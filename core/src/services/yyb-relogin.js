/**
 * 应用宝过期重登
 *
 * 监测已登录账号的 token 过期时间，到期后调用 fetchFarmCodeByOpenid
 * 拉取新 code 并触发账号重新登录（worker 重启）。
 */

'use strict';

const { getYybConfig, getAllAccountsConfig } = require('../models/store');
const { fetchFarmCodeByOpenid } = require('./yyb-login');
const { createModuleLogger } = require('./logger');

const logger = createModuleLogger('yyb-relogin');
const log = (msg, meta) => { try { logger.info(msg, meta || {}); } catch (e) {} };

let monitorTimer = null;
let currentUsername = null;

async function checkAndRelogin(account) {
    if (!account || !account.yybOpenid) return;
    const username = account.yybOwnerUsername || currentUsername;
    if (!username) return;
    const cfg = getYybConfig(username);
    if (!cfg.enabled || !cfg.endpoint) return;
    try {
        const r = await fetchFarmCodeByOpenid(cfg, account.yybOpenid);
        log('relogin fetched', { accountId: account.id, openid: account.yybOpenid, codeLen: r.code.length });
    } catch (e) {
        log('relogin error', { accountId: account.id, error: e.message });
    }
}

async function tick() {
    const accounts = getAllAccountsConfig() || [];
    for (const acc of accounts) {
        await checkAndRelogin(acc);
    }
}

function start(username) {
    stop();
    currentUsername = username;
    const cfg = getYybConfig(username);
    if (!cfg.enabled || !cfg.autoReconnect) {
        log('relogin start skip', { enabled: cfg.enabled, autoReconnect: cfg.autoReconnect });
        return;
    }
    const minutes = Number(cfg.reconnectIntervalMinutes) || 5;
    monitorTimer = setInterval(tick, Math.max(1, minutes) * 60 * 1000);
    log('relogin start', { username, minutes });
}

function stop() {
    if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
    }
    currentUsername = null;
    log('relogin stop', {});
}

module.exports = { start, stop, tick };
