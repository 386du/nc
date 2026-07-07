/**
 * QQ农场 WebSocket Code 抓包 Frida Agent (v5)
 *
 * 策略:
 * 1. Hook getaddrinfo - 拦截 gate-obt 的 DNS 解析
 * 2. Hook connect - 拦截连接到目标服务器
 * 3. SSL_write/BoringSSL 加密前明文数据
 * 4. Winsock send/WSASend 备用
 * 5. 内存扫描备用
 */

const REPORT_URL = "http://127.0.0.1:PORT/api/desktop-login/code-captured";
const TARGET = "gate-obt.nqf.qq.com";
let injected = false;
let captCode = null;

function doReport(code, source) {
    try {
        const http = new XMLHttpRequest();
        http.open("POST", REPORT_URL, false);
        http.setRequestHeader("Content-Type", "application/json");
        http.send(JSON.stringify({ code, pid: Process.id || 0, ts: Date.now(), source }));
        return true;
    } catch (e) { return false; }
}

function tryReport(code, source) {
    if (!code || captCode) return;
    captCode = code;
    console.log(`[FarmCapture] CODE FOUND: ${  code  } via ${  source}`);
    doReport(code, source);
}

function extractCode(text) {
    if (!text || typeof text !== "string") return null;
    if (!text.includes("code=")) return null;
    const m = text.match(/[?&]code=([\w-]+)/);
    return m && m[1] ? m[1] : null;
}

// === 1. getaddrinfo - DNS 解析 ===
function hookGetAddrInfo() {
    try {
        const ptr = Module.findExportByName("ws2_32.dll", "getaddrinfo");
        if (!ptr) return false;
        Interceptor.attach(ptr, {
            onEnter(args) {
                try {
                    const nodeName = args[0].readUtf8String();
                    if (nodeName && (nodeName.includes("gate-obt") || nodeName.includes("nqf.qq"))) {
                        console.log(`[FarmCapture] DNS lookup: ${  nodeName}`);
                    }
                } catch(e) {}
            }
        });
        return true;
    } catch(e) { return false; }
}

// === 2. connect - TCP 连接 ===
function hookConnect() {
    try {
        const ptr = Module.findExportByName("ws2_32.dll", "connect");
        if (!ptr) return false;
        Interceptor.attach(ptr, {
            onEnter(args) {
                try {
                    const sockaddr = args[1];
                    const family = sockaddr.readU16();
                    if (family === 2) { // AF_INET
                        const port = (sockaddr.add(2).readU8() << 8) | sockaddr.add(3).readU8();
                        const ip = `${sockaddr.add(4).readU8()  }.${  sockaddr.add(5).readU8()  }.${  sockaddr.add(6).readU8()  }.${  sockaddr.add(7).readU8()}`;
                        console.log(`[FarmCapture] connect to ${  ip  }:${  port}`);
                        this._farmTarget = ip;
                    }
                } catch(e) {}
            }
        });
        return true;
    } catch(e) { return false; }
}

// === 3. SSL_write ===
function hookSSLWrite() {
    try {
        // 尝试直接查找
        let sslWrite = Module.findExportByName(null, "SSL_write");
        if (!sslWrite) {
            // 尝试从所有模块中搜索
            const mods = Process.enumerateModules();
            for (let i = 0; i < mods.length; i++) {
                try {
                    const exports = Module.enumerateExports(mods[i].name);
                    for (let j = 0; j < exports.length; j++) {
                        if (exports[j].name === "SSL_write") {
                            sslWrite = exports[j].address;
                            console.log(`[FarmCapture] Found SSL_write in ${  mods[i].name}`);
                            break;
                        }
                    }
                } catch(e) {}
                if (sslWrite) break;
            }
        }
        if (sslWrite) {
            Interceptor.attach(sslWrite, {
                onEnter(args) {
                    try {
                        const buf = args[1];
                        const len = args[2].toInt32();
                        if (len <= 0 || len > 16384) return;
                        let data = buf.readUtf8String(len);
                        if (!data) {
                            const decoder = new TextDecoder("utf-8");
                            data = decoder.decode(buf.readByteArray(len));
                        }
                        if (data && data.includes("code=")) {
                            const code = extractCode(data);
                            if (code) tryReport(code, "SSL_write");
                            const lines = data.split("\n");
                            for (let k = 0; k < lines.length && k < 3; k++) {
                                if (lines[k].trim()) console.log(`[FarmCapture] SSL_write: ${  lines[k].trim().substring(0, 100)}`);
                            }
                        }
                    } catch(e) {}
                }
            });
            return true;
        }
    } catch(e) {}
    return false;
}

// === 4. Winsock ===
function hookWinsock() {
    let h = 0;
    function onSocketData(ptr, len) {
        try {
            if (len <= 0 || len > 16384) return;
            const decoder = new TextDecoder("utf-8");
            const data = decoder.decode(ptr.readByteArray(len));
            if (data && data.includes("code=")) {
                const code = extractCode(data);
                if (code) tryReport(code, "winsock");
            }
        } catch(e) {}
    }
    try {
        const send = Module.findExportByName("ws2_32.dll", "send");
        if (send) { Interceptor.attach(send, { onEnter(a) { onSocketData(a[1], a[2].toInt32()); } }); h++; }
    } catch(e) {}
    try {
        const wsa = Module.findExportByName("ws2_32.dll", "WSASend");
        if (wsa) {
            Interceptor.attach(wsa, { onEnter(a) {
                try {
                    const cnt = a[2].toInt32();
                    for (let i = 0; i < cnt && i < 32; i++) {
                        const entry = a[1].add(i * 16);
                        onSocketData(entry.add(8).readPointer(), entry.readU32());
                    }
                } catch(e) {}
            }});
            h++;
        }
    } catch(e) {}
    try {
        const sslRead = Module.findExportByName(null, "SSL_read");
        if (sslRead) {
            Interceptor.attach(sslRead, { onEnter(a) {
                try {
                    const buf = a[1];
                    const len = a[2].toInt32();
                    if (len <= 0 || len > 16384) return;
                    const decoder = new TextDecoder("utf-8");
                    const data = decoder.decode(buf.readByteArray(len));
                    if (data && data.includes("code=")) {
                        const code = extractCode(data);
                        if (code) tryReport(code, "SSL_read");
                    }
                } catch(e) {}
            }});
            h++;
        }
    } catch(e) {}
    return h;
}

// === 5. 内存扫描 ===
function scanMemory() {
    if (captCode) return;
    try {
        Process.enumerateRanges("rw-").forEach((range) => {
            if (captCode || range.size > 1048576) return;
            try {
                const decoder = new TextDecoder("utf-8");
                const buf = range.base.readByteArray(Math.min(range.size, 65536));
                if (!buf) return;
                const text = decoder.decode(buf);
                let idx = text.indexOf(TARGET);
                while (idx >= 0 && !captCode) {
                    const snippet = text.substring(idx, idx + 400);
                    const code = extractCode(snippet);
                    if (code) tryReport(code, "memscan");
                    idx = text.indexOf(TARGET, idx + 1);
                }
            } catch(e) {}
        });
    } catch(e) {}
}

function main() {
    if (injected) return;
    injected = true;
    console.log(`[FarmCapture] Starting v5... PID: ${  Process.id}`);
    Process.enumerateModules().forEach((m) => {
        if (m.name.includes("electron") || m.name.includes("ssl") || m.name.includes("boringssl") || m.name.includes("winhttp") || m.name.includes("wininet") || m.name.includes("libeay") || m.name.includes("ssleay") || m.name.includes("chrome")) {
            console.log(`[FarmCapture] MOD: ${  m.name}`);
        }
    });
    let h = 0;
    if (hookGetAddrInfo()) { h++; console.log("[FarmCapture] getaddrinfo hooked"); }
    if (hookConnect()) { h++; console.log("[FarmCapture] connect hooked"); }
    if (hookSSLWrite()) { h++; console.log("[FarmCapture] SSL_write hooked"); } else { console.log("[FarmCapture] SSL_write NOT FOUND"); }
    h += hookWinsock();
    if (h > 0) console.log(`[FarmCapture] Total hooks: ${  h}`);
    setInterval(scanMemory, 2000);
    try {
        const http = new XMLHttpRequest();
        http.open("POST", REPORT_URL, false);
        http.send(JSON.stringify({ action: "injected", pid: Process.id || 0, hooks: h }));
    } catch(e) {}
}
setTimeout(main, 1000);
