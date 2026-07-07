/**
 * 应用宝会话续期服务 (Worker 内部使用)
 *
 * 背景:应用宝登录返回的 code 在网关侧有 TTL(实测 3~5 分钟)。
 * WS 连接还"看似"开着,但服务端已把会话视为失效,
 * 继续发偷菜请求会被忽略或返回空成功。
 *
 * 解决方案:Worker 内部每 2.5 分钟主动拿新 code,调现有 reconnect() 重连,
 * 不重启整个进程,1~2 秒内恢复,无感。
 *
 * 安全网:API 调用失败时绝不触发重连,避免抽风时把还能用的连接搞挂。
 *
 * 用法:仅在 process.env.FARM_LOGIN_TYPE === 'yyb' 时启用,启动后 2.5 分钟一次。
 */

'use strict';

const { fetchFarmCodeByOpenid } = require('./yyb-login');
const { createModuleLogger } = require('./logger');

const logger = createModuleLogger('yyb-refresh');
const log = (msg, meta) => { try { logger.info(msg, meta || {}); } catch (e) {} };
const logWarn = (msg, meta) => { try { logger.warn(msg, meta || {}); } catch (e) {} };

const DEFAULT_REFRESH_MS = 2.5 * 60 * 1000; // 默认 2.5 分钟(给 3 分钟 TTL 留缓冲)

let activeTimer = null;
let activeAccountName = '';
let activeIntervalMs = DEFAULT_REFRESH_MS;

function readYybContext() {
    if (String(process.env.FARM_LOGIN_TYPE || '').toLowerCase() !== 'yyb') return null;
    const endpoint = String(process.env.YYB_ENDPOINT || '').trim();
    const openid = String(process.env.FARM_OPENID || '').trim();
    const apiToken = String(process.env.YYB_API_TOKEN || '').trim();
    if (!endpoint || !openid || !apiToken) return null;
    return { endpoint, openid, apiToken };
}

async function refreshAndReconnect(accountName) {
    const ctx = readYybContext();
    if (!ctx) return;
    let reconnectFn = null;
    try {
        // 延迟 require 避免循环依赖
        const network = require('../utils/network');
        reconnectFn = typeof network.reconnect === 'function' ? network.reconnect : null;
    } catch {
        return;
    }
    if (!reconnectFn) return;

    let result;
    try {
        result = await fetchFarmCodeByOpenid(ctx, ctx.openid);
    } catch (e) {
        logWarn('YYB 续期 API 调用异常', {
            module: 'yyb', event: 'session_renew_error', error: e && e.message ? e.message : String(e),
        });
        return; // API 抽风:静默,等下一轮再试,绝对不重连
    }
    if (!result || !result.ok || !result.code) {
        // 拿不到新 code:保持当前连接继续工作,等下一轮
        logWarn('YYB 续期失败,保持当前连接', {
            module: 'yyb', event: 'session_renew_failed', error: result && result.error,
        });
        return;
    }
    try {
        log('YYB 会话续期成功,触发内部重连', {
            module: 'yyb', event: 'session_renew_ok', accountName,
        });
        reconnectFn(result.code);
    } catch (e) {
        logWarn('YYB 触发重连失败', {
            module: 'yyb', event: 'session_renew_reconnect_error', error: e && e.message ? e.message : String(e),
        });
    }
}

function startYybSessionRenewer(accountName, intervalMs) {
    stopYybSessionRenewer();
    if (!readYybContext()) return false;
    const ms = Number(intervalMs) > 0 ? Number(intervalMs) : DEFAULT_REFRESH_MS;
    activeAccountName = String(accountName || '');
    activeIntervalMs = ms;
    activeTimer = setInterval(() => { refreshAndReconnect(activeAccountName); }, ms);
    log('YYB 会话续期已启动', {
        module: 'yyb', event: 'session_renew_started', accountName: activeAccountName, intervalMs: ms,
    });
    return true;
}

function stopYybSessionRenewer() {
    if (activeTimer) {
        clearInterval(activeTimer);
        activeTimer = null;
    }
    activeAccountName = '';
}

function status() {
    return {
        running: !!activeTimer,
        accountName: activeAccountName,
        intervalMs: activeIntervalMs,
        enabled: !!readYybContext(),
    };
}

module.exports = {
    startYybSessionRenewer,
    stopYybSessionRenewer,
    refreshAndReconnect,
    status,
};
