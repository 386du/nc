/**
 * 应用宝 (YYB) 用户隔离配置
 *
 * 持久化在 store.json 的 userYybConfigs[username]
 * 调用 store.js 的 getYybConfig / setYybConfig / deleteUserYybConfig 即可
 * 加载/保存数据,无需关心文件 IO。
 *
 * 拆分到独立文件:与 386du/qq-farm-bot 的 core/src/models/store/yyb-config 对齐,
 * 避免 store.js 单文件膨胀。
 */

const DEFAULT_YYB_CONFIG = {
    enabled: false,
    endpoint: '',
    reconnectIntervalMinutes: 0,
    autoReconnect: true,
    accounts: [],
};

function normalizeYybConfig(input) {
    const src = (input && typeof input === 'object') ? input : {};
    const accounts = Array.isArray(src.accounts)
        ? src.accounts
            .filter((a) => a && typeof a === 'object' && a.openid)
            .map((a) => ({
                openid: String(a.openid || '').trim(),
                apiToken: String(a.apiToken || '').trim(),
                name: String(a.name || '').trim() || undefined,
            }))
        : [];
    return {
        enabled: !!src.enabled,
        endpoint: String(src.endpoint || '').trim(),
        reconnectIntervalMinutes: Math.max(0, Math.min(1440, Number(src.reconnectIntervalMinutes) || 0)),
        autoReconnect: src.autoReconnect !== false,
        accounts,
    };
}

function getYybConfig(globalConfig, username) {
    if (!username) return { ...DEFAULT_YYB_CONFIG };
    const cfg = globalConfig && globalConfig.userYybConfigs && globalConfig.userYybConfigs[username];
    return cfg ? normalizeYybConfig(cfg) : { ...DEFAULT_YYB_CONFIG };
}

function setYybConfig(globalConfig, cfg, username, saveGlobalConfig) {
    if (!username) return { ...DEFAULT_YYB_CONFIG };
    const normalized = normalizeYybConfig(cfg);
    if (!globalConfig.userYybConfigs) globalConfig.userYybConfigs = {};
    globalConfig.userYybConfigs[username] = normalized;
    if (typeof saveGlobalConfig === 'function') saveGlobalConfig();
    return getYybConfig(globalConfig, username);
}

function deleteUserYybConfig(globalConfig, username, saveGlobalConfig) {
    if (globalConfig && globalConfig.userYybConfigs && globalConfig.userYybConfigs[username]) {
        delete globalConfig.userYybConfigs[username];
        if (typeof saveGlobalConfig === 'function') saveGlobalConfig();
    }
}

module.exports = {
    DEFAULT_YYB_CONFIG,
    normalizeYybConfig,
    getYybConfig,
    setYybConfig,
    deleteUserYybConfig,
};
