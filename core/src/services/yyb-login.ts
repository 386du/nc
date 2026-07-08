export {};
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

const axios = require('axios');
const { createModuleLogger } = require('./logger');

const logger = createModuleLogger('yyb-login');
const log = (msg: string, meta?: any) => { try { logger.info(msg, meta || {}); } catch (e) {} };

const DEFAULT_TIMEOUT_MS = 15000;
let lastCodeCache: Map<string, { code: string; fetchedAt: number }> = new Map(); // openid -> { code, fetchedAt }

function nowMs(): number { return Date.now(); }

interface YybAccountEntry {
    openid: string;
    apiToken: string;
    name?: string;
}

interface YybConfigLike {
    endpoint: string;
    accounts: YybAccountEntry[];
    enabled?: boolean;
    autoReconnect?: boolean;
    reconnectIntervalMinutes?: number;
}

interface FetchResult {
    code: string;
    openid: string;
    ok: boolean;
    message?: string;
    error?: string;
}

/**
 * 从响应对象里抠出 code 字段(兼容多种返回结构)
 */
function pickCodeFromResponse(data: any): string {
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
function pickErrorFromResponse(data: any): string {
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
 *
 * @param options { endpoint, apiToken, openid }
 */
async function fetchFarmCode(options: {
    endpoint: string;
    apiToken: string;
    openid: string;
    forceRefresh?: boolean;
}): Promise<FetchResult> {
    const endpoint = String(options.endpoint || '').trim().replace(/\/+$/, '');
    const apiToken = String(options.apiToken || '').trim();
    const openid = String(options.openid || '').trim();
    if (!endpoint) {
        return { ok: false, code: '', openid, error: '应用宝 API 端点未配置' };
    }
    if (!openid) {
        return { ok: false, code: '', openid, error: 'openid 必填' };
    }
    if (!apiToken) {
        return { ok: false, code: '', openid, error: `openid=${openid} 未配置 API Token` };
    }
    const body = {
        openid,
        forceRefresh: !!options.forceRefresh,
        debug: false,
    };
    try {
        const resp = await axios.post(endpoint, body, {
            timeout: DEFAULT_TIMEOUT_MS,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiToken}`,
            },
            validateStatus: () => true, // 自己判断 2xx
        });
        const data = resp && resp.data;
        const status = resp && Number(resp.status) || 0;
        if (status < 200 || status >= 300) {
            const errMsg = pickErrorFromResponse(data) || (typeof data === 'string' ? data.slice(0, 200) : '');
            throw new Error(`应用宝 API 返回 ${status}: ${errMsg}`);
        }
        const code = pickCodeFromResponse(data);
        if (!code) {
            const errMsg = pickErrorFromResponse(data) || '响应无 code 字段';
            throw new Error(`应用宝 API 未返回 code: ${errMsg}`);
        }
        lastCodeCache.set(openid, { code, fetchedAt: nowMs() });
        log('yyb-login fetch ok', { openid, codeLen: code.length, endpoint: endpoint.replace(/:\d+/, ':****') });
        return { code, openid, ok: true, message: (data && (data.message || data.msg)) || 'ok' };
    } catch (e: any) {
        return { ok: false, code: '', openid, error: e && e.message ? e.message : String(e) };
    }
}

/**
 * 兼容旧调用:传入 yybConfig + openid
 */
async function fetchFarmCodeByOpenid(yybConfig: YybConfigLike, openid: string): Promise<FetchResult> {
    if (!yybConfig || !yybConfig.endpoint) {
        return { ok: false, code: '', openid: String(openid || ''), error: '应用宝 API 端点未配置' };
    }
    const account = (yybConfig.accounts || []).find((a: YybAccountEntry) => a.openid === openid);
    if (!account) {
        return { ok: false, code: '', openid: String(openid || ''), error: `未找到 openid=${openid} 的应用宝配置` };
    }
    return fetchFarmCode({
        endpoint: yybConfig.endpoint,
        apiToken: account.apiToken,
        openid,
    });
}

/**
 * 批量拉取所有 openid 的最新 code
 */
async function fetchAllFarmCodes(yybConfig: YybConfigLike): Promise<{ ok: boolean; reason?: string; total: number; okCount: number; results: any[] }> {
    if (!yybConfig || !yybConfig.endpoint) {
        return { ok: false, reason: '应用宝 API 端点未配置', total: 0, okCount: 0, results: [] };
    }
    const accounts = Array.isArray(yybConfig.accounts) ? yybConfig.accounts : [];
    const results: any[] = [];
    for (const acc of accounts) {
        const r = await fetchFarmCodeByOpenid(yybConfig, acc.openid);
        results.push({ openid: acc.openid, ok: r.ok, code: r.code, error: r.error });
    }
    const okCount = results.filter(r => r.ok).length;
    return { ok: okCount > 0, total: accounts.length, okCount, results };
}

function getLastCode(openid: string) {
    const v = lastCodeCache.get(String(openid || ''));
    if (!v) return null;
    return v;
}

function clearLastCodeCache() {
    lastCodeCache = new Map();
}

module.exports = {
    fetchFarmCode,
    fetchFarmCodeByOpenid,
    fetchAllFarmCodes,
    getLastCode,
    clearLastCodeCache,
};
