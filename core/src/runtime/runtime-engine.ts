export {};
const { fork } = require('node:child_process');
const path = require('node:path');
const process = require('node:process');
const { Worker } = require('node:worker_threads');
const store = require('../models/store');
const { updateRuntimeConfig, getRuntimeConfig, getDefaultSystemConfig } = require('../config/config');
const { sendPushooMessage } = require('../services/push');
const { MiniProgramLoginSession } = require('../services/qrlogin');
const { createDataProvider } = require('./data-provider');
const { createReloginReminderService } = require('./relogin-reminder');
const { createRuntimeState } = require('./runtime-state');
const { createWorkerManager } = require('./worker-manager');
const { createYybReloginService } = require('./yyb-relogin');

const OPERATION_KEYS: string[] = ['harvest', 'water', 'weed', 'bug', 'fertilize', 'plant', 'steal', 'helpWater', 'helpWeed', 'helpBug', 'taskClaim', 'sell', 'upgrade'];

function createRuntimeEngine(options: any = {}): any {
    const processRef: any = options.processRef || process;
    const isRunningFromSource: boolean = (processRef.argv[1] || '').endsWith('.ts')
        || String(__dirname).includes(`${path.sep}src${path.sep}`);
    const fileExt: string = isRunningFromSource ? '.ts' : '.js';
    const mainEntryPath: string = options.mainEntryPath || path.join(__dirname, `..${path.sep}..${path.sep}client${fileExt}`);
    const workerScriptPath: string = options.workerScriptPath || path.join(__dirname, `..${path.sep}core${path.sep}worker${fileExt}`);
    const runtimeMode: string = String(options.runtimeMode || processRef.env.FARM_RUNTIME_MODE || 'thread').toLowerCase();
    const onStatusSync: any = typeof options.onStatusSync === 'function' ? options.onStatusSync : null;
    const onLog: any = typeof options.onLog === 'function' ? options.onLog : null;
    const onAccountLog: any = typeof options.onAccountLog === 'function' ? options.onAccountLog : null;
    const startAdminServer: any = typeof options.startAdminServer === 'function' ? options.startAdminServer : null;

    const workerControls: any = { startWorker: null, restartWorker: null, refreshWorkerCode: null };
    const runtimeState: any = createRuntimeState({
        store,
        operationKeys: OPERATION_KEYS,
    });
    const {
        workers,
        globalLogs: GLOBAL_LOGS,
        accountLogs: ACCOUNT_LOGS,
        runtimeEvents,
        nextConfigRevision,
        buildConfigSnapshotForAccount,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildDefaultStatus,
        filterLogs,
    } = runtimeState;

    const reloginReminder: any = createReloginReminderService({
        store,
        miniProgramLoginSession: MiniProgramLoginSession,
        sendPushooMessage,
        log,
        addAccountLog,
        getAccounts: store.getAccounts,
        addOrUpdateAccount: store.addOrUpdateAccount,
        resolveWorkerControls: () => workerControls,
    });

    const {
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
    } = reloginReminder;

    const { startWorker, stopWorker, restartWorker, callWorkerApi, refreshWorkerCode }: any = createWorkerManager({
        fork,
        WorkerThread: Worker,
        runtimeMode,
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs: GLOBAL_LOGS,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        addOrUpdateAccount: store.addOrUpdateAccount,
        deleteAccount: store.deleteAccount,
        getAccounts: store.getAccounts,
        runtimeEvents,
        onStatusSync: (accountId: string, status: any, accountName?: string) => {
            runtimeEvents.emit('status', { accountId, status, accountName });
            if (onStatusSync) onStatusSync(accountId, status, accountName);
        },
        onWorkerLog: (entry: any, accountId: string, accountName?: string) => {
            runtimeEvents.emit('worker_log', { entry, accountId, accountName });
            if (onLog) onLog(entry, accountId, accountName);
        },
    });
    workerControls.startWorker = startWorker;
    workerControls.restartWorker = restartWorker;
    workerControls.refreshWorkerCode = refreshWorkerCode;

    // 应用宝主进程自动重连服务(监听 kickout/ws_error → 拉新 code → addOrUpdateAccount → restartWorker(codeRefresh))
    const yybReloginService: any = createYybReloginService({
        store,
        log,
        addAccountLog,
        getAccounts: store.getAccounts,
        addOrUpdateAccount: store.addOrUpdateAccount,
        isAccountRunning: (accountId: string) => !!workers[accountId],
        restartWorker,
        startWorker,
    });

    const dataProvider: any = createDataProvider({
        workers,
        globalLogs: GLOBAL_LOGS,
        accountLogs: ACCOUNT_LOGS,
        store,
        getAccounts: store.getAccounts,
        callWorkerApi,
        refreshWorkerCode,
        buildDefaultStatus,
        normalizeStatusForPanel,
        filterLogs,
        addAccountLog,
        nextConfigRevision,
        broadcastConfigToWorkers,
        startWorker,
        stopWorker,
        restartWorker,
    });

    runtimeEvents.on('log', (entry: any) => {
        if (onLog) onLog(entry, entry && entry.accountId ? entry.accountId : '', entry && entry.accountName ? entry.accountName : '');
    });
    runtimeEvents.on('account_log', (entry: any) => {
        if (onAccountLog) onAccountLog(entry);
    });

    // 应用宝主进程重连触发:
    // 监听 worker 上报的 kickout / ws_error 事件,自动拉新 code → addOrUpdateAccount → restartWorker(codeRefresh)
    runtimeEvents.on('kickout', (evt: any) => {
        if (!evt) return;
        const accountId = String(evt.accountId || '');
        if (!accountId) return;
        yybReloginService.handleAccountRelogin(accountId, evt.reason || 'kickout').catch(() => {});
    });
    runtimeEvents.on('ws_error', (evt: any) => {
        if (!evt) return;
        const accountId = String(evt.accountId || '');
        if (!accountId) return;
        yybReloginService.handleAccountRelogin(accountId, 'ws_error').catch(() => {});
    });

    function broadcastConfigToWorkers(targetAccountId: string = ''): void {
        const targetId = String(targetAccountId || '').trim();
        for (const [accId, worker] of Object.entries(workers)) {
            if (targetId && String(accId) !== targetId) continue;
            const snapshot = buildConfigSnapshotForAccount(accId);
            try {
                (worker as any).process.send({ type: 'config_sync', config: snapshot });
            }
            catch {
                // ignore IPC failures for exited workers
            }
        }
    }

    function startAllAccounts(): void {
        const accounts: any[] = (store.getAccounts().accounts || []);
        if (accounts.length > 0) {
            log('系统', `发现 ${accounts.length} 个账号，正在启动...`);
            accounts.forEach(acc => startWorker(acc));
        }
        else {
            log('系统', '未发现账号，请访问管理面板添加账号');
        }
    }

    async function start(options: any = {}): Promise<void> {
        const shouldStartAdminServer = options.startAdminServer !== false;
        const shouldAutoStartAccounts = options.autoStartAccounts !== false;

        // 启动时加载已保存的系统配置
        const savedSystemConfig = store.getSystemConfig();
        if (savedSystemConfig) {
            updateRuntimeConfig(savedSystemConfig);
            log('系统', `已加载系统配置: serverUrl=${savedSystemConfig.serverUrl}, clientVersion=${savedSystemConfig.clientVersion}, platform=${savedSystemConfig.platform}`);
        }

        if (shouldStartAdminServer && startAdminServer) {
            startAdminServer(dataProvider);
        }

        // 启动应用宝主进程重连监听
        yybReloginService.start();

        if (shouldAutoStartAccounts) {
            startAllAccounts();
        }
    }

    function stopAllAccounts(): void {
        for (const accountId of Object.keys(workers)) {
            stopWorker(accountId);
        }
    }

    return {
        store,
        runtimeEvents,
        workers,
        dataProvider,
        start,
        startAllAccounts,
        stopAllAccounts,
        broadcastConfigToWorkers,
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
        refreshWorkerCode,
        log,
        addAccountLog,
    };
}

module.exports = {
    createRuntimeEngine,
};
