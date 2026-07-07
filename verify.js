// 真实启动 server 并测试
const http = require('http');

(async () => {
    const admin = require('/workspace/core/src/controllers/admin');
    console.log('[TEST] admin module loaded, keys:', Object.keys(admin).join(', '));

    const provider = {
        broadcastConfig: (id) => { /* console.log('broadcast:', id); */ },
        getFriends: async (id) => [{ gid: 100, name: '测试好友A', avatarUrl: '' }, { gid: 200, name: '测试好友B', avatarUrl: '' }],
    };

    let server;
    try {
        server = await admin.startAdminServer({ provider, port: 0 });
        const addr = server.address();
        console.log('[TEST] server up on port', addr.port);

        // 测试应用宝路由
        const tests = [
            { method: 'GET', path: '/api/yyb/config', expect: 401, desc: 'YYB 配置读取 (无 token)' },
            { method: 'GET', path: '/api/yyb/refresh/status', expect: 200, desc: 'YYB 刷新状态' },
            { method: 'GET', path: '/api/friend-guard-dog-blacklist', expect: 400, desc: '护主犬黑名单 (无 account-id)' },
            { method: 'GET', path: '/api/friend-guard-dog-whitelist', expect: 400, desc: '护主犬白名单 (无 account-id)' },
        ];

        for (const t of tests) {
            const r = await new Promise((resolve) => {
                const req = http.request({
                    hostname: '127.0.0.1', port: addr.port,
                    method: t.method, path: t.path,
                    headers: { 'Content-Type': 'application/json' },
                }, (res) => {
                    let body = '';
                    res.on('data', (c) => body += c);
                    res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 200) }));
                });
                req.on('error', (e) => resolve({ status: 0, error: e.message }));
                if (t.method === 'POST') req.write('{}');
                req.end();
            });
            const ok = r.status === t.expect ? '✅' : '❌';
            console.log(`[TEST] ${ok} ${t.method} ${t.path} -> ${r.status} (期望 ${t.expect})  ${t.desc}`);
        }

        // 关闭
        server.close();
        console.log('[TEST] done');
    } catch (e) {
        console.error('[TEST] FAIL:', e.message);
        console.error(e.stack);
        if (server) server.close();
        process.exit(1);
    }
    setTimeout(() => process.exit(0), 100);
})();
