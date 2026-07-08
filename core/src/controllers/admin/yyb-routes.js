/**
 * 应用宝 (YYB) 相关路由
 *
 * 路由:
 *  - GET  /api/user/yyb-config           - 读取当前用户应用宝配置
 *  - POST /api/user/yyb-config           - 保存当前用户应用宝配置
 *  - POST /api/yyb/code                  - 根据 openid 拉取 farm code
 *
 * 扩展路由(项目自定义,前端未调用,保留兼容):
 *  - GET  /api/yyb/config
 *  - POST /api/yyb/config
 *  - POST /api/yyb/fetch-code
 *  - POST /api/yyb/fetch-all
 *  - POST /api/yyb/add-account
 *  - POST /api/yyb/refresh/start
 *  - POST /api/yyb/refresh/stop
 *  - GET  /api/yyb/refresh/status
 *
 * 从 controllers/admin.js 抽出,与 386du/qq-farm-bot 的 controllers/admin/yyb-routes 对齐。
 *
 * @param {import('express').Application} app
 * @param {{ store: any, authRequired: Function }} ctx
 */
module.exports = function mountYybRoutes(app, ctx) {
    const store = ctx.store;
    const authRequired = ctx.authRequired;

    function safeAccount(a) {
        return {
            openid: a.openid,
            name: a.name || '',
            apiToken: a.apiToken ? `${a.apiToken.slice(0, 4)}***${a.apiToken.slice(-2)}` : '',
        };
    }

    function getUsername(req) {
        return (req.currentUser && req.currentUser.username) || (req.user && req.user.username);
    }

    // ============ 应用宝登录配置(386du 主接口) ============
    // GET /api/user/yyb-config - 加载当前用户配置(走 store.userYybConfigs[username])
    app.get('/api/user/yyb-config', (req, res) => {
        const username = getUsername(req);
        if (!username) return res.status(401).json({ ok: false, error: '未登录' });
        const cfg = store.getYybConfig ? store.getYybConfig(username) : { accounts: [] };
        const safeAccounts = (cfg.accounts || []).map(safeAccount);
        res.json({
            ok: true,
            config: {
                enabled: !!cfg.enabled,
                endpoint: cfg.endpoint || '',
                reconnectIntervalMinutes: cfg.reconnectIntervalMinutes || 0,
                autoReconnect: cfg.autoReconnect !== false,
                accounts: safeAccounts,
            },
        });
    });

    // POST /api/user/yyb-config - 保存当前用户配置
    app.post('/api/user/yyb-config', (req, res) => {
        const username = getUsername(req);
        if (!username) return res.status(401).json({ ok: false, error: '未登录' });
        const body = req.body || {};
        // 合并已有 token(避免明文回传导致覆盖)
        const oldCfg = store.getYybConfig ? store.getYybConfig(username) : { accounts: [] };
        const oldTokens = new Map();
        for (const acc of (oldCfg.accounts || [])) oldTokens.set(acc.openid, acc.apiToken);
        const newAccounts = [];
        if (Array.isArray(body.accounts)) {
            for (const a of body.accounts) {
                if (!a || !a.openid) continue;
                let apiToken = '';
                if (a.apiToken && !/^\*+$/.test(a.apiToken)) {
                    apiToken = String(a.apiToken).trim();
                }
                else {
                    apiToken = oldTokens.get(a.openid) || '';
                }
                newAccounts.push({
                    openid: String(a.openid).trim(),
                    name: String(a.name || '').trim(),
                    apiToken,
                });
            }
        }
        const saved = store.setYybConfig({
            enabled: !!body.enabled,
            endpoint: String(body.endpoint || '').trim(),
            accounts: newAccounts,
            autoReconnect: body.autoReconnect !== false,
            reconnectIntervalMinutes: Math.max(0, Math.min(1440, Number(body.reconnectIntervalMinutes) || 0)),
        }, username);
        const safeAccounts = (saved.accounts || []).map(safeAccount);
        res.json({
            ok: true,
            config: {
                enabled: !!saved.enabled,
                endpoint: saved.endpoint || '',
                reconnectIntervalMinutes: saved.reconnectIntervalMinutes || 0,
                autoReconnect: saved.autoReconnect !== false,
                accounts: safeAccounts,
            },
        });
    });

    // POST /api/yyb/code - 拉单个 openid 的 code(386du 接口名)
    app.post('/api/yyb/code', async (req, res) => {
        const username = getUsername(req);
        if (!username) return res.status(401).json({ ok: false, error: '未登录' });
        const openid = String((req.body || {}).openid || '').trim();
        if (!openid) return res.status(400).json({ ok: false, error: 'Missing openid' });
        const yybLogin = require('../../services/yyb-login');
        const cfg = store.getYybConfig ? store.getYybConfig(username) : {};
        try {
            const r = await yybLogin.fetchFarmCodeByOpenid(cfg, openid);
            res.json({ ok: true, code: r.code, openid: r.openid, message: r.message });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 应用宝登录配置(项目自定义兼容接口) ============
    // GET /api/yyb/config
    app.get('/api/yyb/config', (req, res) => {
        const username = getUsername(req);
        if (!username) return res.status(401).json({ ok: false, error: '未登录' });
        const cfg = store.getYybConfig ? store.getYybConfig(username) : {};
        const safeAccounts = (cfg.accounts || []).map(safeAccount);
        res.json({
            ok: true,
            data: {
                ...cfg,
                accounts: safeAccounts,
            },
        });
    });

    // POST /api/yyb/config
    app.post('/api/yyb/config', (req, res) => {
        const username = getUsername(req);
        if (!username) return res.status(401).json({ ok: false, error: '未登录' });
        const body = req.body || {};
        const oldCfg = store.getYybConfig ? store.getYybConfig(username) : { accounts: [] };
        const oldTokensByOpenid = new Map();
        for (const acc of (oldCfg.accounts || [])) oldTokensByOpenid.set(acc.openid, acc.apiToken);
        const newAccounts = [];
        if (Array.isArray(body.accounts)) {
            for (const a of body.accounts) {
                if (!a || !a.openid) continue;
                let apiToken = '';
                if (a.apiToken && !/^\*+$/.test(a.apiToken)) {
                    apiToken = String(a.apiToken).trim();
                }
                else {
                    apiToken = oldTokensByOpenid.get(a.openid) || '';
                }
                newAccounts.push({
                    openid: String(a.openid).trim(),
                    name: String(a.name || '').trim(),
                    apiToken,
                });
            }
        }
        const saved = store.setYybConfig ? store.setYybConfig({
            enabled: !!body.enabled,
            endpoint: String(body.endpoint || '').trim(),
            accounts: newAccounts,
            autoReconnect: body.autoReconnect !== false,
            reconnectIntervalMinutes: Math.max(0, Math.min(1440, Number(body.reconnectIntervalMinutes) || 0)),
        }, username) : {};
        const safeAccounts = (saved.accounts || []).map(safeAccount);
        res.json({
            ok: true,
            data: {
                ...saved,
                accounts: safeAccounts,
            },
        });
    });

    // POST /api/yyb/fetch-code - 立即拉取一个 openid 的 code
    app.post('/api/yyb/fetch-code', async (req, res) => {
        const username = getUsername(req);
        if (!username) return res.status(401).json({ ok: false, error: '未登录' });
        const openid = String((req.body || {}).openid || '').trim();
        if (!openid) return res.status(400).json({ ok: false, error: 'Missing openid' });
        const yybLogin = require('../../services/yyb-login');
        const cfg = store.getYybConfig ? store.getYybConfig(username) : {};
        try {
            const r = await yybLogin.fetchFarmCodeByOpenid(cfg, openid);
            res.json({ ok: true, data: { code: r.code, openid: r.openid, message: r.message } });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // POST /api/yyb/fetch-all - 立即拉取所有 openid 的 code
    app.post('/api/yyb/fetch-all', async (req, res) => {
        const username = getUsername(req);
        if (!username) return res.status(401).json({ ok: false, error: '未登录' });
        const yybLogin = require('../../services/yyb-login');
        const cfg = store.getYybConfig ? store.getYybConfig(username) : {};
        try {
            const r = await yybLogin.fetchAllFarmCodes(cfg);
            res.json({ ok: r.ok, data: r });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // POST /api/yyb/add-account - 应用宝一键登录
    app.post('/api/yyb/add-account', (req, res) => {
        const username = getUsername(req);
        if (!username) return res.status(401).json({ ok: false, error: '未登录' });
        const openid = String((req.body || {}).openid || '').trim();
        const code = String((req.body || {}).code || '').trim();
        const tail = openid.length >= 6 ? openid.slice(-6) : openid;
        const name = String((req.body || {}).name || '').trim() || `应用宝_${tail}`;
        try {
            const accounts = store.getAccounts ? store.getAccounts() : { accounts: [] };
            const existing = (accounts.accounts || []).find(a => String(a.name) === String(tail));
            const payload = existing
                ? { id: existing.id, name: tail, code, platform: 'wx', loginType: 'yyb', openid }
                : { name: tail, code, platform: 'wx', loginType: 'yyb', openid };
            payload.username = username;
            const data = store.addOrUpdateAccount ? store.addOrUpdateAccount(payload) : null;
            res.json({ ok: true, data });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // POST /api/yyb/refresh/start
    app.post('/api/yyb/refresh/start', (req, res) => {
        const username = getUsername(req);
        if (!username) return res.status(401).json({ ok: false, error: '未登录' });
        const yybRefresh = require('../../services/yyb-refresh');
        yybRefresh.start(username);
        res.json({ ok: true, data: yybRefresh.status() });
    });

    // POST /api/yyb/refresh/stop
    app.post('/api/yyb/refresh/stop', (req, res) => {
        const yybRefresh = require('../../services/yyb-refresh');
        yybRefresh.stop();
        res.json({ ok: true });
    });

    // GET /api/yyb/refresh/status
    app.get('/api/yyb/refresh/status', (req, res) => {
        const yybRefresh = require('../../services/yyb-refresh');
        res.json({ ok: true, data: yybRefresh.status() });
    });
};
