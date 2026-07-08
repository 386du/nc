export {};
const { createScheduler } = require('../services/scheduler');

interface CreateWorkerManagerOptions {
    fork: any;
    WorkerThread: any;
    runtimeMode?: string;
    processRef: any;
    mainEntryPath: string;
    workerScriptPath: string;
    workers: Record<string, any>;
    globalLogs: any[];
    log: (tag: string, msg: string, meta?: any) => void;
    addAccountLog: (action: string, msg: string, accountId?: string, accountName?: string, extra?: any) => void;
    normalizeStatusForPanel: (data: any, accountId: string, name: string) => any;
    buildConfigSnapshotForAccount: (accountId: string) => any;
    getOfflineAutoDeleteMs: (username: string) => number;
    triggerOfflineReminder: (params: any) => void;
    addOrUpdateAccount: (acc: any) => any;
    deleteAccount: (accountId: string) => boolean;
    getAccounts: () => { accounts: any[] };
    runtimeEvents?: any;
    onStatusSync?: (accountId: string, status: any, name?: string) => void;
    onWorkerLog?: (entry: any, accountId: string, name?: string) => void;
}

function createWorkerManager(options: CreateWorkerManagerOptions): any {
    const {
        fork,
        WorkerThread,
        runtimeMode = 'thread',
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        addOrUpdateAccount,
        deleteAccount,
        getAccounts,
        runtimeEvents = null,
        onStatusSync,
        onWorkerLog,
    } = options;

    const managerScheduler = createScheduler('worker_manager');
    const useThreadRuntime = runtimeMode === 'thread' && !processRef.pkg && typeof WorkerThread === 'function';

    // ============ 应用宝登录模式环境变量注入 ============
    // 当账号 loginType='yyb' 且配置了 endpoint/openid/apiToken 时,
    // 把这些信息注入 worker 进程,worker 内部会先拉取 farm code 再启动游戏连接,
    // 并启动 yyb-refresh 定时续期。
    function buildYybEnv(account: any): Record<string, string> {
        const env: Record<string, string> = {};
        try {
            if (!account || String(account.loginType || '').toLowerCase() !== 'yyb') return env;
            const openid = String(account.openid || account.qq || '').trim();
            if (!openid) return env;
            const store = require('../models/store');
            const username = String(account.username || '');
            const cfg = (store.getYybConfig && store.getYybConfig(username)) || null;
            if (!cfg || !cfg.enabled) return env;
            const entry = (cfg.accounts || []).find((a: any) => String(a.openid || '').trim() === openid);
            if (!entry || !entry.apiToken || !cfg.endpoint) return env;
            env.FARM_LOGIN_TYPE = 'yyb';
            env.FARM_OPENID = openid;
            env.YYB_API_TOKEN = String(entry.apiToken).trim();
            env.YYB_ENDPOINT = String(cfg.endpoint).trim();
        } catch {
            // 静默:获取失败时不透传 env
        }
        return env;
    }

    function createThreadWorker(account: any, options: any = {}): any {
        const yybEnv = buildYybEnv(account);
        const workerOptions: any = {
            workerData: {
                accountId: String(account.id || ''),
                channel: 'thread',
                startupMode: (options && options.codeRefresh) ? 'code_refresh' : 'start',
            },
            env: { ...processRef.env, ...yybEnv },
        };
        // 当从源码运行(tsx)时,worker 也需要用 tsx 加载
        if (workerScriptPath.endsWith('.ts')) {
            workerOptions.execArgv = ['--require', 'tsx/cjs'];
        }
        // 与 child_process 保持同形接口
        const worker = new WorkerThread(workerScriptPath, workerOptions);
        worker.send = (payload: any) => worker.postMessage(payload);
        worker.kill = () => worker.terminate();
        return worker;
    }

    function createForkWorker(account: any, options: any = {}): any {
        const yybEnv = buildYybEnv(account);
        if (processRef.pkg) {
            // 打包后也走 fork + execPath，确保 IPC 通道可用
            return fork(mainEntryPath, [], {
                execPath: processRef.execPath,
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                env: { ...processRef.env, FARM_WORKER: '1', FARM_ACCOUNT_ID: String(account.id || ''), FARM_STARTUP_MODE: (options && options.codeRefresh) ? 'code_refresh' : 'start', ...yybEnv },
            });
        }
        const forkOptions: any = {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: { ...processRef.env, FARM_ACCOUNT_ID: String(account.id || ''), FARM_STARTUP_MODE: (options && options.codeRefresh) ? 'code_refresh' : 'start', ...yybEnv },
        };
        // 当从源码运行(tsx)时,worker 也需要用 tsx 加载
        if (workerScriptPath.endsWith('.ts')) {
            forkOptions.execArgv = ['--require', 'tsx/cjs'];
        }
        return fork(workerScriptPath, [], forkOptions);
    }

    function createWorkerProcess(account: any, options: any = {}): any {
        if (useThreadRuntime) return createThreadWorker(account, options);
        return createForkWorker(account, options);
    }

    function startWorker(account: any, options: any = {}): boolean {
        if (!account || !account.id) return false;
        if (workers[account.id]) return false; // 已运行

        if (!(options && options.codeRefresh)) log('系统', `正在启动账号: ${account.name}`, { accountId: String(account.id), accountName: account.name });

        let child: any = null;
        try {
            child = createWorkerProcess(account, options);
        } catch (err: any) {
            const reason = err && err.message ? err.message : String(err || 'unknown error');
            log('错误', `账号 ${account.name} 启动失败: ${reason}`, { accountId: String(account.id), accountName: account.name });
            addAccountLog('start_failed', `账号 ${account.name} 启动失败`, account.id, account.name, { reason });
            return false;
        }

        workers[account.id] = {
            process: child,
            status: null, // 最新状态快照
            logs: [],
            requests: new Map(), // pending API requests
            reqId: 1,
            startedAt: Number(options.startedAt) > 0 ? Number(options.startedAt) : Date.now(),
            name: account.name,
            username: account.username || '', // 保存用户名用于下线提醒
            nick: account.nick || '',
            uin: account.uin || account.qq || '',
            loginType: account.loginType || '', // 应用宝登录模式标记（主进程重连判定用）
            openid: account.openid || '',
            keepRunningOnKickout: !!account.keepRunningOnKickout,
            stopping: false,
            disconnectedSince: 0,
            autoDeleteTriggered: false,
            wsError: null,
        };

        // 发送启动指令
        child.send({
            type: 'start',
            config: {
                code: account.code,
                platform: account.platform,
                keepRunningOnKickout: !!account.keepRunningOnKickout,
            },
        });
        child.send({ type: 'config_sync', config: buildConfigSnapshotForAccount(account.id) });

        // 监听消息
        child.on('message', (msg: any) => {
            handleWorkerMessage(account.id, msg);
        });

        child.on('error', (err: any) => {
            log('系统', `账号 ${account.name} 子进程启动失败: ${err && err.message ? err.message : err}`, { accountId: String(account.id), accountName: account.name });
        });

        child.on('exit', (code: any, signal: any) => {
            const current = workers[account.id];
            const displayName = (current && current.name) || account.name;
            if (!(options && options.codeRefresh)) log('系统', `账号 ${displayName} 进程退出 (code=${code}, signal=${signal || 'none'})`, {
                accountId: String(account.id),
                accountName: displayName,
                runtimeMode: useThreadRuntime ? 'thread' : 'fork',
            });

            managerScheduler.clear(`force_kill_${account.id}`);
            managerScheduler.clear(`restart_fallback_${account.id}`);

            if (current && current.requests && current.requests.size > 0) {
                for (const [reqId, req] of current.requests.entries()) {
                    managerScheduler.clear(`api_timeout_${account.id}_${reqId}`);
                    try {
                        req.reject(new Error('Worker exited'));
                    } catch {}
                }
                current.requests.clear();
            }

            // 如果扫描进行中 worker 退出了,标记为已中断
            try {
                const scanMod = require('./scan-status');
                if (scanMod && typeof scanMod.isScanInProgress === 'function' && scanMod.isScanInProgress(String(account.id), 'guardDogScan')) {
                    if (typeof scanMod.interruptInProgressScan === 'function') {
                        scanMod.interruptInProgressScan(String(account.id), 'guardDogScan', { reason: 'worker_exit' });
                    } else {
                        const cur = scanMod.getScanStatus ? scanMod.getScanStatus(String(account.id), 'guardDogScan') : null;
                        if (scanMod.setScanStatus) {
                            scanMod.setScanStatus(String(account.id), 'guardDogScan', {
                                ...(cur || {}),
                                phase: 'interrupted',
                                error: 'worker_exit',
                                finishedAt: Date.now(),
                            });
                        }
                    }
                }
            } catch { /* ignore */ }

            if (current && current.process === child) {
                delete workers[account.id];
            }
        });
        return true;
    }

    function stopWorker(accountId: string): void {
        const worker = workers[accountId];
        if (!worker) return;

        const proc = worker.process;
        worker.stopping = true;
        worker.process.send({ type: 'stop' });
        // process.kill will happen in 'exit' handler, or we can force it
        managerScheduler.setTimeoutTask(`force_kill_${accountId}`, 1000, () => {
            const current = workers[accountId];
            if (current && current.process === proc) {
                current.process.kill();
                delete workers[accountId];
            }
        });
    }

    function restartWorker(account: any, options: any = {}): void {
        if (!account) return;
        const accountId = account.id;
        const worker = workers[accountId];
        if (!worker) { startWorker(account); return; }
        const proc = worker.process;
        const preservedStartedAt = options && options.preserveStartedAt ? worker.startedAt : 0;
        let started = false;
        const startOnce = (): void => {
            if (started) return;
            started = true;
            managerScheduler.clear(`restart_fallback_${accountId}`);
            const current = workers[accountId];
            if (!current) { startWorker(account, { startedAt: preservedStartedAt, codeRefresh: !!(options && options.codeRefresh) }); return; }
            if (current.process !== proc) return;
            delete workers[accountId];
            startWorker(account, { startedAt: preservedStartedAt, codeRefresh: !!(options && options.codeRefresh) });
        };
        const killIfStale = (): boolean => {
            const current = workers[accountId];
            if (!current || current.process !== proc) return false;
            try {
                current.process.kill();
            } catch {}
            delete workers[accountId];
            return true;
        };
        if (typeof proc.exitCode === 'number' || proc.signalCode) {
            startOnce();
            return;
        }
        proc.once('exit', startOnce);
        stopWorker(accountId);
        managerScheduler.setTimeoutTask(`restart_fallback_${accountId}`, 1500, () => {
            if (started) return;
            killIfStale();
            startOnce();
        });
    }

    function handleWorkerMessage(accountId: string, msg: any): void {
        const worker = workers[accountId];
        if (!worker) return;

        if (msg.type === 'status_sync') {
            // 合并状态
            const status = normalizeStatusForPanel(msg.data, accountId, worker.name);
            status.instanceStartedAt = worker.startedAt;
            status.uptime = Math.max(0, Math.floor((Date.now() - worker.startedAt) / 1000));
            worker.status = status;
            if (typeof onStatusSync === 'function') {
                onStatusSync(accountId, worker.status, worker.name);
            }

            // 尝试更新昵称到 store
            if (msg.data && msg.data.status && msg.data.status.name) {
                const newNick = String(msg.data.status.name).trim();
                // 忽略无效昵称
                if (newNick && newNick !== '未知' && newNick !== '未登录') {
                    // 避免频繁写入，只在内存中无昵称或不一致时更新
                    if (worker.nick !== newNick) {
                        const oldNick = worker.nick;
                        worker.nick = newNick;
                        addOrUpdateAccount({
                            id: accountId,
                            nick: newNick,
                        });
                        // 仅在首次同步或名称变更时记录日志
                        if (oldNick !== newNick) {
                            log('系统', `已同步账号昵称: ${oldNick || 'None'} -> ${newNick}`, { accountId, accountName: worker.name });
                        }
                    }
                }
            }

            // 登录成功后，将 uin (QQ 号) 同步到 store
            const isConnected = !!(msg.data && msg.data.connection && msg.data.connection.connected);
            if (isConnected && msg.data && msg.data.status) {
                // 优先使用明确的 uin 字段，其次用 gid（可能不是 QQ 号）
                const gameUin = msg.data.status.uin || '';
                if (gameUin && String(gameUin).trim()) {
                    const currentUin = worker.uin || '';
                    if (currentUin !== String(gameUin)) {
                        worker.uin = String(gameUin);
                        addOrUpdateAccount({
                            id: accountId,
                            uin: String(gameUin),
                        });
                        if (!currentUin) {
                            log('系统', `已同步账号 QQ 号: ${gameUin}`, { accountId, accountName: worker.name });
                        }
                    }
                }
            }

            const connected = !!(msg.data && msg.data.connection && msg.data.connection.connected);
            if (connected) {
                worker.disconnectedSince = 0;
                worker.autoDeleteTriggered = false;
                worker.wsError = null;
            } else if (!worker.stopping) {
                const now = Date.now();
                if (!worker.disconnectedSince) worker.disconnectedSince = now;
                const offlineMs = now - worker.disconnectedSince;
                const autoDeleteMs = getOfflineAutoDeleteMs(worker.username);
                if (!worker.autoDeleteTriggered && offlineMs >= autoDeleteMs) {
                    worker.autoDeleteTriggered = true;
                    const offlineMin = Math.floor(offlineMs / 60000);
                    log('系统', `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，自动删除账号信息`);
                    triggerOfflineReminder({
                        accountId,
                        accountName: worker.name,
                        username: worker.username,
                        reason: 'offline_timeout',
                        offlineMs,
                    });
                    addAccountLog(
                        'offline_delete',
                        `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，已自动删除`,
                        accountId,
                        worker.name,
                        { reason: 'offline_timeout', offlineMs },
                    );
                    stopWorker(accountId);
                    try {
                        deleteAccount(accountId);
                    } catch (e: any) {
                        log('错误', `删除离线账号失败: ${e.message}`);
                    }
                }
            }
        } else if (msg.type === 'log') {
            // 保存日志
            const logEntry = {
                ...msg.data,
                accountId,
                accountName: worker.name,
                ts: Date.now(),
                meta: msg.data && msg.data.meta ? msg.data.meta : {},
            };
            logEntry._searchText = `${logEntry.msg || ''} ${logEntry.tag || ''} ${JSON.stringify(logEntry.meta || {})}`.toLowerCase();
            worker.logs.push(logEntry);
            if (worker.logs.length > 1000) worker.logs.shift();
            globalLogs.push(logEntry);
            if (globalLogs.length > 1000) globalLogs.shift();
            if (typeof onWorkerLog === 'function') {
                onWorkerLog(logEntry, accountId, worker.name);
            }
        } else if (msg.type === 'error') {
            log('错误', `账号[${accountId}]进程报错: ${msg.error}`, { accountId: String(accountId), accountName: worker.name });
        } else if (msg.type === 'ws_error') {
            const code = Number(msg.code) || 0;
            const message = msg.message || '';
            worker.wsError = { code, message, at: Date.now() };
            if (code === 400) {
                addAccountLog(
                    'ws_400',
                    `账号 ${worker.name} 登录失效，请更新 Code`,
                    accountId,
                    worker.name,
                );
            }
            // 应用宝重连服务需要这个事件
            if (runtimeEvents && typeof runtimeEvents.emit === 'function') {
                runtimeEvents.emit('ws_error', {
                    accountId: String(accountId),
                    accountName: worker.name,
                    code,
                    message,
                });
            }
        } else if (msg.type === 'account_kicked') {
            const reason = msg.reason || '未知';
            const idleKickout = String(reason).includes('长时间未操作') || String(reason).includes('断开链接');
            const stopLabel = idleKickout ? '连接因长时间未操作断开' : '被踢下线';

            const latestAccounts = typeof getAccounts === 'function' ? getAccounts() : { accounts: [] };
            const latestAccount = latestAccounts && Array.isArray(latestAccounts.accounts)
                ? latestAccounts.accounts.find((a: any) => String(a && a.id) === String(accountId))
                : null;
            const keepRunningOnKickout = !!((latestAccount && latestAccount.keepRunningOnKickout) || worker.keepRunningOnKickout);

            // 应用宝重连服务需要这个事件(放在 keepRunningOnKickout 判定之前,
            // 让服务在主进程做后续处理时已经有事件可监听)
            if (runtimeEvents && typeof runtimeEvents.emit === 'function') {
                runtimeEvents.emit('kickout', {
                    accountId: String(accountId),
                    accountName: worker.name,
                    reason,
                    idle: idleKickout,
                });
            }

            if (keepRunningOnKickout) {
                worker.keepRunningOnKickout = true;
                worker.wsError = { code: 400, message: String(reason || 'kickout'), at: Date.now(), waitingCodeRefresh: true };
                log('系统', `账号 ${worker.name} ${stopLabel}，等待新 Code 后自动恢复`, { accountId: String(accountId), accountName: worker.name });
                addAccountLog('kickout_wait_code', `账号 ${worker.name} ${stopLabel}，等待新 Code 后自动恢复`, accountId, worker.name, { reason });
                return;
            }
            log('系统', `账号 ${worker.name} ${stopLabel}，已自动停止账号`, { accountId: String(accountId), accountName: worker.name });
            triggerOfflineReminder({
                accountId,
                accountName: worker.name,
                reason: `kickout:${reason}`,
                offlineMs: 0,
            });
            addAccountLog('kickout_stop', `账号 ${worker.name} ${stopLabel}，已自动停止`, accountId, worker.name, { reason });
            stopWorker(accountId);
        } else if (msg.type === 'api_response') {
            const { id, result, error } = msg;
            managerScheduler.clear(`api_timeout_${accountId}_${id}`);
            const req = worker.requests.get(id);
            if (req) {
                if (error) req.reject(new Error(error));
                else req.resolve(result);
                worker.requests.delete(id);
            }
        } else if (msg.type === 'friend_blacklist_add') {
            const gid = Number(msg.gid) || 0;
            if (gid > 0) {
                const { addFriendToBlacklist: addToBlacklist } = require('../models/store');
                addToBlacklist(accountId, gid);
                log('好友', `已将好友 ${msg.friendName || `GID:${gid}`} 加入黑名单`, {
                    accountId: String(accountId),
                    accountName: worker.name,
                    friendGid: gid,
                    friendName: msg.friendName,
                    reason: msg.reason,
                });
                // 同步配置到 worker 进程
                const worker_process = workers[accountId];
                if (worker_process && worker_process.process) {
                    worker_process.process.send({ type: 'config_sync', config: buildConfigSnapshotForAccount(accountId) });
                }
            }
        } else if (msg.type === 'friend_guard_dog_add') {
            const gid = Number(msg.gid) || 0;
            if (gid > 0) {
                const store = require('../models/store');
                if (store.addFriendGuardDogGid) {
                    const added = store.addFriendGuardDogGid(accountId, gid);
                    if (added) {
                        log('好友', `已自动登记护主犬好友: ${msg.friendName || `GID:${gid}`}`, {
                            accountId: String(accountId),
                            accountName: worker.name,
                            friendGid: gid,
                            friendName: msg.friendName,
                            dogIds: msg.dogIds,
                        });
                    }
                }
                // 同步配置到 worker 进程（让 worker 进程也能拿到最新的护主犬好友清单）
                const worker_process = workers[accountId];
                if (worker_process && worker_process.process) {
                    worker_process.process.send({ type: 'config_sync', config: buildConfigSnapshotForAccount(accountId) });
                }
            }
        } else if (msg.type === 'guard_dog_scan_progress') {
            // worker 主动汇报扫描进度
            try {
                const { setScanStatus, isScanInProgress, getScanStatus } = require('./scan-status');
                const phase = String(msg.phase || 'scanning');
                if (msg.finished) {
                    const cur = getScanStatus(accountId, 'guardDogScan') || {};
                    setScanStatus(accountId, 'guardDogScan', {
                        ...cur,
                        phase: 'completed',
                        progress: msg.progress || cur.progress || { scanned: 0, total: 0, guardDogCount: 0, newGids: [] },
                        finishedAt: Date.now(),
                    });
                } else {
                    setScanStatus(accountId, 'guardDogScan', {
                        phase,
                        progress: msg.progress || { scanned: 0, total: 0, guardDogCount: 0, newGids: [] },
                        lastUpdate: Date.now(),
                    });
                }
            } catch (e: any) {
                log('错误', `护主犬扫描进度更新失败: ${e && e.message ? e.message : String(e || 'unknown')}`, { accountId: String(accountId) });
            }
        }
    }

    function callWorkerApi(accountId: string, method: string, ...args: any[]): Promise<any> {
        const worker = workers[accountId];
        if (!worker) return Promise.reject(new Error('账号未运行'));

        return new Promise((resolve, reject) => {
            const id = worker.reqId++;
            worker.requests.set(id, { resolve, reject });

            // 超时处理
            const timeoutMs = method === 'refreshCode' ? 45000 : 10000;
            managerScheduler.setTimeoutTask(`api_timeout_${accountId}_${id}`, timeoutMs, () => {
                if (worker.requests.has(id)) {
                    worker.requests.delete(id);
                    reject(new Error('API Timeout'));
                }
            });

            worker.process.send({ type: 'api_call', id, method, args });
        });
    }

    async function refreshWorkerCode(accountId: string, code: string): Promise<{ ok: boolean; reason?: string }> {
        const worker = workers[accountId];
        if (!worker) return { ok: false, reason: 'account_not_running' };
        await callWorkerApi(accountId, 'refreshCode', code);
        return { ok: true };
    }

    return {
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
        refreshWorkerCode,
    };
}

module.exports = {
    createWorkerManager,
};
