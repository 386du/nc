export {};
/**
 * 应用宝自动重连服务 (主进程)
 *
 * 监听 worker 上报的 kickout / ws_error 事件,当账号 loginType='yyb' 时
 * 拉取新 farm code 调 refreshWorkerCode 让 worker 内部走 "code_refresh" 流程,
 * 1~2 秒内恢复,不重启进程。
 *
 * 安全网:API 调用失败时绝不触发重连,避免抽风时把还能用的连接搞挂。
 *
 * 同时按用户配置的 reconnectIntervalMinutes 周期性检查所有运行中的 yyb 账号,
 * 命中间隔时拉新 code → addOrUpdateAccount → restartWorker(codeRefresh)。
 */

const { fetchFarmCode } = require('../services/yyb-login');
const { createScheduler } = require('../services/scheduler');
const { createModuleLogger } = require('../services/logger');
const { isScanInProgress } = require('./scan-status');

const logger = createModuleLogger('yyb-relogin');
const log = (msg: string, meta?: any) => { try { logger.info(msg, meta || {}); } catch (e) {} };
const logWarn = (msg: string, meta?: any) => { try { logger.warn(msg, meta || {}); } catch (e) {} };

const RELOGIN_SCHEDULER = createScheduler('yyb_relogin');
const PERIODIC_TASK = 'periodic_reconnect';
const PERIODIC_INTERVAL_MS = 60 * 1000; // 每 60s 检查一次是否需要到间隔

interface YybAccountRef {
    id?: string;
    name?: string;
    username?: string;
    loginType?: string;
    openid?: string;
    uin?: string;
    qq?: string;
    code?: string;
    platform?: string;
    [key: string]: any;
}

interface YybReloginServiceOptions {
    store: any;
    log: (tag: string, msg: string, meta?: any) => void;
    addAccountLog: (action: string, msg: string, accountId?: string, accountName?: string, extra?: any) => void;
    getAccounts: () => { accounts: YybAccountRef[] };
    addOrUpdateAccount: (acc: any) => any;
    isAccountRunning: (accountId: string) => boolean;
    restartWorker: (account: YybAccountRef, options?: any) => void;
    startWorker: (account: YybAccountRef, options?: any) => boolean;
}

interface YybReloginService {
    start: () => void;
    stop: () => void;
    handleAccountRelogin: (accountId: string, reason: string) => Promise<void>;
    periodicReconnectTick: () => Promise<void>;
}

function isYybAccount(account: YybAccountRef | null | undefined): boolean {
    if (!account) return false;
    return String(account.loginType || '').toLowerCase() === 'yyb'
        && String(account.openid || account.qq || '').trim().length > 0;
}

function readContextForAccount(account: YybAccountRef): { endpoint: string; apiToken: string; openid: string; username: string } | null {
    if (!isYybAccount(account)) return null;
    try {
        const store = require('../models/store');
        const username = String(account.username || '');
        const cfg = (store.getYybConfig && store.getYybConfig(username)) || null;
        if (!cfg || !cfg.enabled) return null;
        const openid = String(account.openid || account.qq || '').trim();
        const entry = (cfg.accounts || []).find((a: any) => String(a.openid || '').trim() === openid);
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

async function handleAccountRelogin(
    options: YybReloginServiceOptions,
    accountId: string,
    reason: string,
): Promise<void> {
    try {
        const accounts = options.getAccounts();
        const acc = (accounts && Array.isArray(accounts.accounts))
            ? accounts.accounts.find(a => String(a && a.id) === String(accountId))
            : null;
        if (!acc) return;
        if (!isYybAccount(acc)) return; // 非 yyb 账号 / 配置缺失,交给通用 kickout 流程处理
        // 如果正在扫描,跳过由 yyb 触发的重启,避免打断长任务
        if (isScanInProgress(accountId)) {
            log('YYB 跳过主进程重连:护主犬扫描进行中', {
                module: 'yyb', event: 'main_renew_skipped_scan', accountId,
            });
            return;
        }
        const ctx = readContextForAccount(acc);
        if (!ctx) return;
        const r = await fetchFarmCode({
            endpoint: ctx.endpoint,
            apiToken: ctx.apiToken,
            openid: ctx.openid,
            forceRefresh: true,
        });
        if (!r || !r.ok || !r.code) {
            logWarn('YYB 主进程拉新 code 失败,保持当前连接', {
                module: 'yyb', event: 'main_renew_failed', accountId, error: r && r.error,
            });
            return;
        }
        // 更新账号 code
        try {
            options.addOrUpdateAccount({
                id: accountId,
                code: r.code,
                loginType: 'yyb',
                openid: ctx.openid,
                username: ctx.username,
            });
        } catch (e: any) {
            // 写不动也继续
        }
        log('YYB 主进程拉新 code 成功,触发 worker 重启(codeRefresh)', {
            module: 'yyb', event: 'main_renew_ok', accountId,
        });
        try {
            options.restartWorker(acc, { codeRefresh: true });
        } catch (e: any) {
            logWarn('YYB 主进程重启 worker 失败', {
                module: 'yyb', event: 'main_restart_error', accountId, error: e && e.message ? e.message : String(e),
            });
        }
    } catch (e: any) {
        logWarn('YYB 主进程重连异常', {
            module: 'yyb', event: 'main_renew_error', accountId, error: e && e.message ? e.message : String(e),
        });
    }
}

function createYybReloginService(options: YybReloginServiceOptions): YybReloginService {
    const opts = options || ({} as YybReloginServiceOptions);

    async function periodicReconnectTick(): Promise<void> {
        try {
            const accounts = opts.getAccounts();
            const list = (accounts && Array.isArray(accounts.accounts)) ? accounts.accounts : [];
            for (const acc of list) {
                if (!isYybAccount(acc)) continue;
                if (!opts.isAccountRunning(String(acc.id || ''))) continue;
                if (isScanInProgress(String(acc.id || ''))) continue; // 扫描中跳过
                const ctx = readContextForAccount(acc);
                if (!ctx) continue;
                const cfg = (require('../models/store').getYybConfig && require('../models/store').getYybConfig(ctx.username)) || null;
                const intervalMin = Math.max(0, Number(cfg && cfg.reconnectIntervalMinutes) || 0);
                if (intervalMin <= 0) continue; // 0 = 不自动续
                const last = Number(acc.codeRefreshedAt) || 0;
                if (last > 0 && Date.now() - last < intervalMin * 60 * 1000) continue;
                // 到点拉新 code
                const r = await fetchFarmCode({
                    endpoint: ctx.endpoint,
                    apiToken: ctx.apiToken,
                    openid: ctx.openid,
                    forceRefresh: true,
                });
                if (!r || !r.ok || !r.code) continue;
                try {
                    opts.addOrUpdateAccount({
                        id: acc.id,
                        code: r.code,
                        codeRefreshedAt: Date.now(),
                        loginType: 'yyb',
                        openid: ctx.openid,
                        username: ctx.username,
                    });
                    opts.restartWorker({ ...acc, code: r.code, codeRefreshedAt: Date.now() }, { codeRefresh: true });
                    log('YYB 定时续期成功', { module: 'yyb', event: 'periodic_renew_ok', accountId: acc.id });
                } catch (e: any) {
                    // 跳过
                }
            }
        } catch (e: any) {
            logWarn('YYB 定时续期异常', { module: 'yyb', event: 'periodic_renew_error', error: e && e.message ? e.message : String(e) });
        }
    }

    function start(): void {
        RELOGIN_SCHEDULER.setIntervalTask(PERIODIC_TASK, PERIODIC_INTERVAL_MS, periodicReconnectTick, {
            preventOverlap: true,
        });
        log('YYB 主进程重连服务已启动', { module: 'yyb', event: 'main_relogin_started' });
    }

    function stop(): void {
        RELOGIN_SCHEDULER.clear(PERIODIC_TASK);
    }

    return {
        start,
        stop,
        handleAccountRelogin: (accountId: string, reason: string) => handleAccountRelogin(opts, accountId, reason),
        periodicReconnectTick,
    };
}

module.exports = { createYybReloginService, handleAccountRelogin, isYybAccount, readContextForAccount };
