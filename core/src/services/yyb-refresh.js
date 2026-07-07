/**
 * 应用宝 code 定时刷新器
 *
 * 根据 yybConfig.reconnectIntervalMinutes 周期性拉取所有 openid 的 code，
 * 供前端展示最新状态，并在过期时触发 relogin 流程。
 */

'use strict';

const { getYybConfig } = require('../models/store');
const { fetchAllFarmCodes } = require('./yyb-login');
const { createModuleLogger } = require('./logger');

const logger = createModuleLogger('yyb-refresh');
const log = (msg, meta) => { try { logger.info(msg, meta || {}); } catch (e) {} };

let timer = null;
let currentUsername = null;
let currentIntervalMs = 0;

async function tick() {
    if (!currentUsername) return;
    const cfg = getYybConfig(currentUsername);
    if (!cfg.enabled || !cfg.endpoint) return;
    try {
        const r = await fetchAllFarmCodes(cfg);
        log('refresh tick ok', { username: currentUsername, ok: r.okCount, total: r.total });
    } catch (e) {
        log('refresh tick error', { username: currentUsername, error: e.message });
    }
}

function start(username) {
    stop();
    currentUsername = username;
    const cfg = getYybConfig(username);
    const minutes = Number(cfg.reconnectIntervalMinutes) || 0;
    if (!cfg.enabled || !cfg.endpoint || minutes <= 0) {
        log('refresh start skip', { username, enabled: cfg.enabled, hasEndpoint: !!cfg.endpoint, minutes });
        return;
    }
    currentIntervalMs = minutes * 60 * 1000;
    timer = setInterval(tick, currentIntervalMs);
    log('refresh start', { username, minutes });
    // 立即跑一次
    tick();
}

function stop() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    currentUsername = null;
    currentIntervalMs = 0;
    log('refresh stop', {});
}

function refreshNow(username) {
    currentUsername = username || currentUsername;
    return tick();
}

function status() {
    return {
        username: currentUsername,
        running: !!timer,
        intervalMs: currentIntervalMs,
    };
}

module.exports = { start, stop, refreshNow, status };
