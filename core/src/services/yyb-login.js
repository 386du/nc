/**
 * 应用宝扫码登录服务
 *
 * 通过用户配置的外部 API 获取登录 code，适配应用宝场景。
 * 每个用户在 store.userYybConfigs 里有独立配置（endPoint、accounts、autoReconnect 等）。
 */

'use strict';

const fetch = require('node-fetch');
const { createModuleLogger } = require('./logger');

const logger = createModuleLogger('yyb-login');
const log = (msg, meta) => { try { logger.info(msg, meta || {}); } catch (e) {} };

const DEFAULT_TIMEOUT_MS = 8000;
let lastCodeCache = new Map(); // openid -> { code, fetchedAt }

function nowMs() { return Date.now(); }

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
    const url = String(yybConfig.endpoint).replace(/\/+$/, '');
    const body = {
        openid,
        apiToken: account.apiToken || '',
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`应用宝 API 返回 ${resp.status}: ${text.slice(0, 200)}`);
        }
        const data = await resp.json();
        // 期望外部 API 返回 { code, openid, message?, success?, data? }
        const code = (data && (data.code || data.data?.code)) ? String(data.code || data.data.code) : '';
        if (!code) {
            throw new Error('应用宝 API 未返回 code');
        }
        lastCodeCache.set(openid, { code, fetchedAt: nowMs() });
        log('yyb-login fetch ok', { openid, codeLen: code.length });
        return { code, openid, message: data.message || 'ok' };
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
