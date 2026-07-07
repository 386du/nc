/**
 * 应用宝扫码登录服务
 *
 * 通过用户配置的外部 API 获取登录 code，适配应用宝场景。
 * 每个用户在 store.userYybConfigs 里有独立配置（endPoint、accounts、autoReconnect 等）。
 *
 * API 协议（按 211.154.25.123:28999 应用宝对接页面规范）：
 *   - POST <endpoint>
 *   - Authorization: Bearer <api-token>
 *   - Content-Type: application/json
 *   - Body: { openid, forceRefresh?, debug? }
 *   - 成功响应: { code: '<farm code>', ... } 或 { success/code: '...' }
 *   - 失败响应: { error/msg/message: '...' } 或非 2xx
 */

'use strict';

const fetch = require('node-fetch');
const { createModuleLogger } = require('./logger');

const logger = createModuleLogger('yyb-login');
const log = (msg, meta) => { try { logger.info(msg, meta || {}); } catch (e) {} };

const DEFAULT_TIMEOUT_MS = 15000;
let lastCodeCache = new Map(); // openid -> { code, fetchedAt }

function nowMs() { return Date.now(); }

/**
 * 从响应对象里抠出 code 字段(兼容多种返回结构)
 */
function pickCodeFromResponse(data) {
    if (!data) return '';
    if (typeof data === 'string') return data.trim();
    if (data.code) return String(data.code);
    if (data.data && data.data.code) return String(data.data.code);
    if (data.farmCode) return String(data.farmCode);
    if (data.farm_code) return String(data.farm_code);
    return '';
}

/**
 * 从响应对象里抠出错误信息
 */
function pickErrorFromResponse(data) {
    if (!data) return '';
    if (typeof data === 'string') return data;
    return String(
        data.error
        || data.message
        || data.msg
        || data.data?.error
        || data.data?.message
        || ''
    );
}

/**
 * 调用外部 API 拉取单个 openid 的 code
 */
async function fetchFarmCodeByOpenid(yybConfig, openid) {
    if (!yybConfig || !yybConfig.endpoint) {
        throw new Error('应用宝 API 端点未配置');
    }
    if (!openid) {
        throw new Error('openid 必填');
    }
    const account = (yybConfig.accounts || []).find(a => a.openid === openid);
    if (!account) {
        throw new Error(`未找到 openid=${openid} 的应用宝配置`);
    }
    const apiToken = String(account.apiToken || '').trim();
    if (!apiToken) {
        throw new Error(`openid=${openid} 未配置 API Token`);
    }
    const url = String(yybConfig.endpoint).replace(/\/+$/, '');
    const body = {
        openid: String(openid).trim(),
        forceRefresh: false,
        debug: false,
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiToken}`,
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        const text = await resp.text().catch(() => '');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (!resp.ok) {
            const errMsg = pickErrorFromResponse(data) || text.slice(0, 200);
            throw new Error(`应用宝 API 返回 ${resp.status}: ${errMsg}`);
        }
        const code = pickCodeFromResponse(data);
        if (!code) {
            const errMsg = pickErrorFromResponse(data) || '响应无 code 字段';
            throw new Error(`应用宝 API 未返回 code: ${errMsg}`);
        }
        lastCodeCache.set(openid, { code, fetchedAt: nowMs() });
        log('yyb-login fetch ok', { openid, codeLen: code.length, endpoint: url.replace(/:\d+/, ':****') });
        return { code, openid, message: (data && (data.message || data.msg)) || 'ok' };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 批量拉取所有 openid 的最新 code
 */
async function fetchAllFarmCodes(yybConfig) {
    if (!yybConfig || !yybConfig.endpoint) {
        return { ok: false, reason: '应用宝 API 端点未配置', results: [] };
    }
    const accounts = Array.isArray(yybConfig.accounts) ? yybConfig.accounts : [];
    const results = [];
    for (const acc of accounts) {
        try {
            const r = await fetchFarmCodeByOpenid(yybConfig, acc.openid);
            results.push({ openid: acc.openid, ok: true, code: r.code });
        } catch (e) {
            results.push({ openid: acc.openid, ok: false, error: e.message });
        }
    }
    const okCount = results.filter(r => r.ok).length;
    return { ok: okCount > 0, total: accounts.length, okCount, results };
}

function getLastCode(openid) {
    const v = lastCodeCache.get(openid);
    if (!v) return null;
    return v;
}

function clearLastCodeCache() {
    lastCodeCache = new Map();
}

module.exports = {
    fetchFarmCodeByOpenid,
    fetchAllFarmCodes,
    getLastCode,
    clearLastCodeCache,
};
