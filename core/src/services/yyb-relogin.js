/**
 * 应用宝自动重连服务 (主进程)
 *
 * 监听 worker 上报的 kickout / ws_error 事件,当账号 loginType='yyb' 时
 * 拉取新 farm code 调 refreshWorkerCode 让 worker 内部走 "code_refresh" 流程,
 * 1~2 秒内恢复,不重启进程。
 *
 * 安全网:API 调用失败时绝不触发重连,避免抽风时把还能用的连接搞挂。
 */

'use strict';

const { fetchFarmCodeByOpenid } = require('./yyb-login');
const { createModuleLogger } = require('./logger');

const logger = createModuleLogger('yyb-relogin');
const log = (msg, meta) => { try { logger.info(msg, meta || {}); } catch (e) {} };
const logWarn = (msg, meta) => { try { logger.warn(msg, meta || {}); } catch (e) {} };

let serviceRef = null;
let runtimeEventsRef = null;

function isYybAccount(account) {
    if (!account) return false;
    return String(account.loginType || '').toLowerCase() === 'yyb'
        && String(account.openid || account.qq || '').trim().length > 0;
}

function readContextForAccount(account) {
    if (!isYybAccount(account)) return null;
    try {
        const store = require('../models/store');
        const username = String(account.username || '');
        const cfg = (store.getYybConfig && store.getYybConfig(username)) || null;
        if (!cfg || !cfg.enabled) return null;
        const openid = String(account.openid || account.qq || '').trim();
        const entry = (cfg.accounts || []).find(a => String(a.openid || '').trim() === openid);
        if (!entry || !entry.apiToken || !cfg.endpoint) return null;
        return {
            endpoint: String(cfg.endpoint).trim(),
            apiToken: String(entry.apiToken).trim(),
            openid,
            username,
        };
    } catch {
        return null;
    }
}

async function handleAccountRelogin(accountId, reason) {
    try {
        const workers = serviceRef && serviceRef.workers;
        if (!workers || !workers[accountId]) return;
        const w = workers[accountId];
        const account = {
            id: accountId,
            name: w.name,
            username: w.username,
            loginType: w.loginType || (w.workerInfo && w.workerInfo.loginType) || '',
            openid: w.openid || (w.workerInfo && w.workerInfo.openid) || '',
        };
        const ctx = readContextForAccount(account);
        if (!ctx) return; // 非 yyb 账号 / 配置缺失,交给通用 kickout 流程处理
        const r = await fetchFarmCodeByOpenid(ctx, ctx.openid);
        if (!r || !r.ok || !r.code) {
            logWarn('YYB 主进程拉新 code 失败,保持当前连接', {
                module: 'yyb', event: 'main_renew_failed', accountId, error: r && r.error,
            });
            return;
        }
        log('YYB 主进程拉新 code 成功,触发 worker code_refresh', {
            module: 'yyb', event: 'main_renew_ok', accountId,
        });
        const refreshFn = serviceRef && serviceRef.refreshWorkerCode;
        if (typeof refreshFn === 'function') {
            await refreshFn(accountId, r.code);
        }
    } catch (e) {
        logWarn('YYB 主进程重连异常', {
            module: 'yyb', event: 'main_renew_error', accountId, error: e && e.message ? e.message : String(e),
        });
    }
}

function createYybReloginService(options) {
    serviceRef = options || {};
    runtimeEventsRef = serviceRef.runtimeEvents;

    function onEvent(evt) {
        if (!evt) return;
        const accountId = String(evt.accountId || '');
        if (!accountId) return;
        const reason = evt.type === 'ws_error' ? 'ws_error' : (evt.reason || 'kickout');
        handleAccountRelogin(accountId, reason).catch(() => {});
    }

    function start() {
        if (!runtimeEventsRef || typeof runtimeEventsRef.on !== 'function') return;
        runtimeEventsRef.on('kickout', onEvent);
        runtimeEventsRef.on('ws_error', onEvent);
        log('YYB 主进程重连服务已启动', { module: 'yyb', event: 'main_relogin_started' });
    }

    function stop() {
        if (runtimeEventsRef && typeof runtimeEventsRef.off === 'function') {
            runtimeEventsRef.off('kickout', onEvent);
            runtimeEventsRef.off('ws_error', onEvent);
        }
    }

    return { start, stop, handleAccountRelogin };
}

module.exports = { createYybReloginService, handleAccountRelogin, isYybAccount, readContextForAccount };
