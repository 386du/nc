/**
 * MITM 代理服务 - 截获农场 WebSocket code
 */
const path = require("path");
let ProxyLib = null;
try { ProxyLib = require("http-mitm-proxy").Proxy; } catch(e) {}

let activeProxies = [];

function startProxy(options) {
    return new Promise((resolve, reject) => {
        if (!ProxyLib) return reject(new Error("http-mitm-proxy 未安装"));
        const port = options.port || 18888;
        const onCode = options.onCode || function() {};
        const log = options.log || console.log;
        const proxy = new ProxyLib();

        proxy.onRequest((ctx, callback) => {
            const method = ctx.clientToProxyRequest.method;
            const url = ctx.clientToProxyRequest.url || "";
            const host = (ctx.clientToProxyRequest.headers && ctx.clientToProxyRequest.headers.host) || "";
            if (url.includes("nqf.qq.com") && url.includes("code=")) {
                const m = url.match(/[?&]code=([\w-]+)/);
                if (m && m[1]) {
                    log(`[MITMProxy] CODE: ${  m[1]}`);
                    onCode(m[1], url);
                }
            }
            return callback();
        });

        proxy.onError((ctx, err, kind) => {
            log(`[MITMProxy] ${  kind  }: ${  err && err.message}`);
        });

        const caDir = path.join(process.cwd(), "data", "mitm-certs");
        proxy.listen({ port, sslCaDir: caDir }, () => {
            log(`[MITMProxy] \u4EE3理已启动: 127.0.0.1:${  port}`);
            activeProxies.push(proxy);
            resolve({ port, caCertPath: path.join(caDir, "certs", "ca.pem"), proxy });
        });
    });
}

function stopAll() {
    activeProxies.forEach((p) => { try { p.close(); } catch(e) {} });
    activeProxies = [];
}

module.exports = { startProxy, stopAll };
