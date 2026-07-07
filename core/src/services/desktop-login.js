/**
 * 桌面登录服务
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { QRLoginSession } = require("./qrlogin");
const sessionsDb = require("../models/desktop-sessions");
const { createDesktopFarmCapture } = require("./desktop-farm-capture");
const { captureProtocolCode } = require("./protocol-code-capture");
const platform = require("../utils/platform");
const FRIDA_AGENT_PATH = path.join(__dirname, "../utils/desktop-login-agent.js");
// FRIDA_FARM_AGENT_PATH removed
// FRIDA_CAPTURE_AGENT_PATH removed

const REPORT_PORT = process.env.ADMIN_PORT || 3338;
const FARM_CODE_REFRESH_INTERVAL_MS = Math.max(30 * 1000, Number(process.env.FARM_CODE_REFRESH_INTERVAL_MS) || 3 * 60 * 1000);
const FARM_CODE_REFRESH_POLL_MS = 10 * 1000;
const QQ_NUMBER_RE = /^\d{8,12}$/;


function normalizeProcessIds(items) {
    return Array.isArray(items) ? items.map((item) => {
        return Number(typeof item === "object" ? item.pid : item);
    }).filter(Boolean) : [];
}

function isFarmProcessRow(row) {
    const commandLine = String((row && row.commandLine) || "");
    return /QQEX|QQEXMiniProgram|--loadapp=mini-app|--loadapp=exApp|m\.q\.qq\.com\/a\/p\/1112386029/i.test(commandLine);
}

function collectProcessTreePids(rows, rootPids) {
    const allRows = Array.isArray(rows) ? rows : [];
    const collected = new Set((rootPids || []).map(Number).filter(Boolean));
    let changed = true;
    while (changed) {
        changed = false;
        allRows.forEach((row) => {
            if (row.pid && collected.has(Number(row.parentPid)) && !collected.has(Number(row.pid))) {
                collected.add(Number(row.pid));
                changed = true;
            }
        });
    }
    return Array.from(collected);
}

function detectFarmRootPids(rows, beforePids, mainPid) {
    const allRows = Array.isArray(rows) ? rows : [];
    const before = new Set(normalizeProcessIds(beforePids));
    const byPid = new Map(allRows.map((row) => { return [Number(row.pid), row]; }));
    const roots = [];
    const seen = new Set();
    allRows.forEach((row) => {
        if (!row || !row.pid || before.has(Number(row.pid)) || !isFarmProcessRow(row)) return;
        let root = row;
        while (root && root.parentPid && !before.has(Number(root.parentPid)) && byPid.has(Number(root.parentPid))) {
            root = byPid.get(Number(root.parentPid));
        }
        const rootPid = Number(root && root.pid);
        if (rootPid && rootPid !== Number(mainPid) && !before.has(rootPid) && !seen.has(rootPid)) {
            seen.add(rootPid);
            roots.push(rootPid);
        }
    });
    return roots;
}

function shouldCloseFarmOnCaptureFailure(farmPids) {
    return normalizeProcessIds(farmPids).length > 0;
}

function filterFarmCloseTargets(targets, mainPid, beforePids) {
    const main = Number(mainPid || 0);
    const before = new Set(normalizeProcessIds(beforePids));
    return normalizeProcessIds(targets).filter((pid) => {
        return pid && pid !== main && !before.has(pid);
    });
}

function isProcessAlive(pid) {
    const id = Number(pid || 0);
    if (!id) return false;
    try {
        process.kill(id, 0);
        return true;
    } catch (e) {
        return e && e.code === "EPERM";
    }
}

function getLiveSessionState(session, processExists) {
    const pid = Number((session && session.pid) || 0);
    if (!pid) return { alive: false, patch: null };
    const exists = typeof processExists === "function" ? processExists(pid) : isProcessAlive(pid);
    if (exists) return { alive: true, patch: null };
    return {
        alive: false,
        patch: {
            pid: null,
            status: "offline",
            farmPids: [],
        },
    };
}

function resolveLaunchCookies(cookies, existingSession) {
    const source = cookies || (existingSession && existingSession.cookies) || "";
    if (!source) throw new Error("Missing cookies");
    if (typeof source === "object") return source;
    try {
        return JSON.parse(String(source));
    } catch (e) {
        throw new Error("Invalid cookies");
    }
}

function shouldRunCodeRefreshTimer(session, processExists) {
    if (!session || !session.boundAccountId || session.autoRefreshCode === false) return false;
    if (session.status !== "online") return false;
    return getLiveSessionState(session, processExists).alive;
}

function normalizeQQProfileUin(uin) {
    const key = String(uin || "").trim();
    return QQ_NUMBER_RE.test(key) ? key : "unknown";
}

function getDesktopQQProfileRoot(options) {
    return (options && options.profileRoot) || process.env.DESKTOP_QQ_PROFILE_ROOT || path.join(__dirname, "../../data/desktop-login/qq-profiles");
}

function getQQUserDataDirForUin(uin, options) {
    return path.join(getDesktopQQProfileRoot(options), normalizeQQProfileUin(uin));
}

function buildQQLaunchArgs(uin, options) {
    const userDataDir = getQQUserDataDirForUin(uin, options);
    const args = [];
    if (userDataDir) args.push(`--user-data-dir=${  userDataDir}`);
    args.push("--");
    return args;
}

function normalizePathText(input) {
    return String(input || "").replace(/\//g, "\\").replace(/"/g, "").toLowerCase();
}

function isQQMainProcessRow(row) {
    const name = String((row && row.name) || "").toLowerCase();
    const commandLine = String((row && row.commandLine) || "");
    if (name !== "qq.exe") return false;
    if (/--type=|--loadapp=|QQEXMiniProgram/i.test(commandLine)) return false;
    return true;
}

function findQQMainPidByUserDataDir(rows, userDataDir) {
    const target = normalizePathText(userDataDir);
    if (!target) return 0;
    const found = (Array.isArray(rows) ? rows : []).find((row) => {
        return isQQMainProcessRow(row) && normalizePathText(row.commandLine).includes(target);
    });
    return Number((found && found.pid) || 0);
}

function createDesktopLoginService(options) {
    const { log } = options || {};
    const applyFarmCodeToAccount = typeof options.applyFarmCodeToAccount === "function" ? options.applyFarmCodeToAccount : null;
    const isBoundAccountRunning = typeof options.isBoundAccountRunning === "function" ? options.isBoundAccountRunning : null;
    const prepareFarmCodeRefresh = typeof options.prepareFarmCodeRefresh === "function" ? options.prepareFarmCodeRefresh : null;
    const fridaProcesses = {};
    let pendingFarmCode = null;
    let pendingFarmCodeTime = 0;
    const codeRefreshTimers = {};
    const codeRefreshRunning = {};
    const farmCapture = createDesktopFarmCapture({
        sessionsDb,
        log(msg) { logInfo(msg); },
    });
    function logInfo(msg) { (typeof log === "function" ? log : console.log)("桌面登录", msg); }
    function logError(msg) { (typeof log === "function" ? log : console.error)("桌面登录", `[错误] ${  msg}`); }

    function refreshSessionProcessState(session) {
        const state = getLiveSessionState(session);
        if (state.patch && session && session.uin) {
            sessionsDb.update(session.uin, Object.assign({}, state.patch, { lastActiveAt: Date.now(), nextCodeRefreshAt: 0 }));
            stopCodeRefreshTimer(session.uin);
        }
        return state;
    }

    function refreshAllSessionProcessStates() {
        sessionsDb.getAll().forEach((session) => {
            refreshSessionProcessState(session);
        });
    }
    async function prepareBoundAccountForCodeRefresh(session) {
        const accountId = String((session && session.boundAccountId) || "").trim();
        if (!accountId || !prepareFarmCodeRefresh) return null;
        try {
            return await prepareFarmCodeRefresh(accountId, session);
        } catch (e) {
            logError(`准备绑定实例 Code 刷新失败: ${  e && e.message ? e.message : e}`);
            return { ok: false, reason: e && e.message ? e.message : String(e || "prepare_failed") };
        }
    }



    async function applyCodeToBoundAccount(session, code) {
        const accountId = String((session && session.boundAccountId) || "").trim();
        if (!accountId || !code || !applyFarmCodeToAccount) return null;
        try {
            const result = await applyFarmCodeToAccount(accountId, code, session);
            sessionsDb.update(session.uin, {
                lastCodeRefreshAt: Date.now(),
                lastCodeRefreshOk: !!(result && result.ok),
                lastCodeRefreshError: result && result.ok ? "" : ((result && result.reason) || "refresh_failed"),
            });
            if (result && result.ok && result.started) logInfo(`实例未运行，已使用新 Code 启动: ${  String(code).substring(0, 8)  }...`);
            else if (result && result.ok && result.restarted) logInfo(`原地刷新失败，已用新 Code 重启绑定实例: ${  String(code).substring(0, 8)  }...`);
            else if (result && result.ok) logInfo(`已更新绑定实例 Code: ${  String(code).substring(0, 8)  }...`);
            else logError(`绑定实例 Code 刷新失败: ${  (result && result.reason) || "refresh_failed"}`);
            return result;
        } catch(e) {
            sessionsDb.update(session.uin, {
                lastCodeRefreshAt: Date.now(),
                lastCodeRefreshOk: false,
                lastCodeRefreshError: e.message,
            });
            logError(`绑定实例 Code 刷新失败: ${  e.message}`);
            return { ok: false, reason: e.message };
        }
    }

    function stopCodeRefreshTimer(uin) {
        const key = String(uin || "").trim();
        if (codeRefreshTimers[key]) {
            clearInterval(codeRefreshTimers[key]);
            delete codeRefreshTimers[key];
        }
        delete codeRefreshRunning[key];
    }

    function startCodeRefreshTimer(uin) {
        const key = String(uin || "").trim();
        if (!key || codeRefreshTimers[key]) return;
        const session = sessionsDb.findByUin(key);
        if (!shouldRunCodeRefreshTimer(session)) {
            if (session) {
                refreshSessionProcessState(session);
                sessionsDb.update(key, { nextCodeRefreshAt: 0 });
            }
            return;
        }
        if (session && !session.nextCodeRefreshAt) {
            sessionsDb.update(key, { nextCodeRefreshAt: Date.now() + FARM_CODE_REFRESH_INTERVAL_MS });
        }
        codeRefreshTimers[key] = setInterval(() => {
            const latest = sessionsDb.findByUin(key);
            if (!shouldRunCodeRefreshTimer(latest)) {
                if (latest) {
                    refreshSessionProcessState(latest);
                    sessionsDb.update(key, { nextCodeRefreshAt: 0 });
                }
                stopCodeRefreshTimer(key);
                return;
            }
            if (isBoundAccountRunning && !isBoundAccountRunning(latest.boundAccountId)) {
                sessionsDb.update(key, { nextCodeRefreshAt: Date.now() + FARM_CODE_REFRESH_INTERVAL_MS });
                return;
            }
            const nextAt = Number(latest.nextCodeRefreshAt || 0);
            if (!nextAt) {
                sessionsDb.update(key, { nextCodeRefreshAt: Date.now() + FARM_CODE_REFRESH_INTERVAL_MS });
                return;
            }
            if (Date.now() < nextAt) return;
            if (codeRefreshRunning[key]) return;
            codeRefreshRunning[key] = true;
            openFarm(key)
                .catch((e) => { logError(`自动刷新 Code 失败: ${  e.message}`); })
                .finally(() => {
                    sessionsDb.update(key, { nextCodeRefreshAt: Date.now() + FARM_CODE_REFRESH_INTERVAL_MS });
                    codeRefreshRunning[key] = false;
                });
        }, FARM_CODE_REFRESH_POLL_MS);
    }

    function restoreCodeRefreshTimers() {
        sessionsDb.getAll().forEach((session) => {
            if (shouldRunCodeRefreshTimer(session)) startCodeRefreshTimer(session.uin);
            else if (session && session.boundAccountId) {
                refreshSessionProcessState(session);
                sessionsDb.update(session.uin, { nextCodeRefreshAt: 0 });
            }
        });
    }
    async function createQR(preset) {
        logInfo("正在生成 QQ 桌面登录二维码...");
        const result = await QRLoginSession.requestQRCode(preset || "vip");
        logInfo("二维码已生成");
        return result;
    }
    async function checkQrStatus(qrsig, preset) { return QRLoginSession.checkStatus(qrsig, preset || "vip"); }
    function parseLoginResult(result) {
        const cookieArr = Array.isArray(result.cookie) ? result.cookie : [];
        const cookies = {}; let uin = ""; const nickname = result.nickname || "";
        cookieArr.forEach((c) => {
            const eq = c.indexOf("=");
            if (eq < 0) return;
            const k = c.substring(0, eq).trim(); const e = c.indexOf(";", eq);
            cookies[k] = (e > eq ? c.substring(eq + 1, e) : c.substring(eq + 1)).trim();
            if (k === "uin" || k === "ptui_loginuin") uin = c.substring(eq + 1, e > eq ? e : undefined).trim().replace(/^o0*/, "");
        });
        if (!uin && result.jumpUrl) { const m = result.jumpUrl.match(/uin=(\d+)/); if (m) uin = m[1]; }
        return { uin, cookies, nickname };
    }
    function findQQPath(customPath) {
        if (customPath && fs.existsSync(customPath)) {
            if (fs.statSync(customPath).isDirectory()) customPath = path.join(customPath, "QQ.exe");
            if (fs.existsSync(customPath)) return customPath;
        }
        // QQ \u8def\u5f84\u672a\u914d\u7f6e\u6216\u4e0d\u5b58\u5728\uff0c\u629b\u51fa\u660e\u786e\u9519\u8bef
        const hint = customPath ? (`\u2018${  customPath  }\u2019 \u4E0D\u5B58\u5728`) : "\u672A\u914D\u7F6E";
        throw new Error(`QQ 路径${  hint  }，Windows 系统请检查 QQ.exe 路径配置`);
    }
    
function findQQUserDataDir() {
        const base = process.env.APPDATA || path.join(process.env.USERPROFILE || "C:\\Users\\Default", "AppData", "Roaming");
        let d = path.join(base, "Tencent", "QQNT");
        if (fs.existsSync(d)) return d;
        d = path.join(process.env.USERPROFILE || "C:\\Users\\Default", "Documents", "Tencent Files");
        return fs.existsSync(d) ? d : path.join(base, "Tencent", "QQNT");
    }




    function waitMs(ms) {
        return new Promise((resolve) => { setTimeout(resolve, ms); });
    }

    async function waitForQQMainPidByUserDataDir(userDataDir, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < (timeoutMs || 8000)) {
            const pid = findQQMainPidByUserDataDir(await getQQProcessTreeSnapshot(), userDataDir);
            if (pid) {
                await waitMs(1500);
                const stablePid = findQQMainPidByUserDataDir(await getQQProcessTreeSnapshot(), userDataDir);
                if (stablePid === pid) return pid;
            }
            await waitMs(500);
        }
        return 0;
    }






    function getProcessIdsByName(name) {
        return new Promise((resolve) => {
            const ps = spawn("powershell", [
                "-NoProfile",
                "-Command",
                `(Get-Process -Name '${  name  }' -ErrorAction SilentlyContinue).Id | ConvertTo-Json`
            ], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
            let out = "";
            ps.stdout.on("data", (d) => { out += d.toString(); });
            ps.on("close", () => {
                try {
                    const parsed = JSON.parse(out.trim());
                    resolve(Array.isArray(parsed) ? parsed.map(Number) : (parsed ? [Number(parsed)] : []));
                } catch(e) { resolve([]); }
            });
            ps.on("error", () => { resolve([]); });
        });
    }

    function getQQFarmCandidateProcesses(mainPid) {
        return new Promise((resolve) => {
            const escapedMainPid = Number(mainPid || 0);
            const command = [
                "$items = Get-CimInstance Win32_Process | Where-Object {",
                `  $_.Name -eq 'QQEX.exe' -or ($_.Name -eq 'QQ.exe' -and $_.CommandLine -match '--type=renderer' -and $_.ParentProcessId -eq ${  escapedMainPid  })`,
                "} | Select-Object @{n='pid';e={$_.ProcessId}},@{n='name';e={$_.Name}},@{n='parentPid';e={$_.ParentProcessId}},@{n='createdAt';e={$_.CreationDate}},@{n='commandLine';e={$_.CommandLine}};",
                "$items | ConvertTo-Json -Compress"
            ].join(" ");
            const ps = spawn("powershell", ["-NoProfile", "-Command", command], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
            let out = "";
            ps.stdout.on("data", (d) => { out += d.toString(); });
            ps.on("close", () => {
                try {
                    const parsed = JSON.parse(out.trim() || "[]");
                    const rows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
                    resolve(rows.map((row) => {
                        return {
                            pid: Number(row.pid),
                            name: row.name || "",
                            parentPid: Number(row.parentPid || 0),
                            createdAt: row.createdAt || "",
                            commandLine: row.commandLine || "",
                        };
                    }).filter((row) => { return row.pid; }));
                } catch(e) { resolve([]); }
            });
            ps.on("error", () => { resolve([]); });
        });
    }

    function getQQProcessTreeSnapshot() {
        return new Promise((resolve) => {
            const command = [
                "$items = Get-CimInstance Win32_Process | Where-Object {",
                "  $_.Name -eq 'QQ.exe' -or $_.Name -eq 'QQEX.exe' -or $_.Name -eq 'crashpad_handler.exe'",
                "} | Select-Object @{n='pid';e={$_.ProcessId}},@{n='name';e={$_.Name}},@{n='parentPid';e={$_.ParentProcessId}},@{n='createdAt';e={$_.CreationDate}},@{n='commandLine';e={$_.CommandLine}};",
                "$items | ConvertTo-Json -Compress"
            ].join(" ");
            const ps = spawn("powershell", ["-NoProfile", "-Command", command], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
            let out = "";
            ps.stdout.on("data", (d) => { out += d.toString(); });
            ps.on("close", () => {
                try {
                    const parsed = JSON.parse(out.trim() || "[]");
                    const rows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
                    resolve(rows.map((row) => {
                        return {
                            pid: Number(row.pid),
                            name: row.name || "",
                            parentPid: Number(row.parentPid || 0),
                            createdAt: row.createdAt || "",
                            commandLine: row.commandLine || "",
                        };
                    }).filter((row) => { return row.pid; }));
                } catch(e) { resolve([]); }
            });
            ps.on("error", () => { resolve([]); });
        });
    }

    async function detectFarmProcessIds(mainPid, beforePids, timeoutMs) {
        const before = Array.isArray(beforePids) ? beforePids.map((item) => {
            return Number(typeof item === "object" ? item.pid : item);
        }) : [];
        const start = Date.now();
        while (Date.now() - start < (timeoutMs || 8000)) {
            const treeRows = await getQQProcessTreeSnapshot();
            const newRoots = detectFarmRootPids(treeRows, before, mainPid);
            if (newRoots.length) return collectProcessTreePids(treeRows, newRoots);

            const afterRows = await getQQFarmCandidateProcesses(mainPid);
            const farmPids = afterRows.map((row) => { return row.pid; }).filter((pid) => {
                return pid && !before.includes(Number(pid));
            });
            if (farmPids.length) return farmPids;
            await waitMs(500);
        }

        const fallbackRows = await getQQProcessTreeSnapshot();
        const latestRoot = detectFarmRootPids(fallbackRows, before, mainPid);
        if (latestRoot.length) return collectProcessTreePids(fallbackRows, latestRoot);

        return (await getQQFarmCandidateProcesses(mainPid))
            .filter((row) => { return row.name === "QQ.exe"; })
            .sort((a, b) => { return String(b.createdAt).localeCompare(String(a.createdAt)); })
            .slice(0, 1)
            .map((row) => { return row.pid; });
    }

    async function closeFarmProcesses(mainPid, beforePids, farmPids) {
        await waitMs(800);
        let targets = filterFarmCloseTargets(farmPids, mainPid, beforePids);
        try {
            if (!targets.length) {
                const afterRows = await getQQProcessTreeSnapshot();
                const before = normalizeProcessIds(beforePids);
                targets = filterFarmCloseTargets(afterRows.map((row) => { return row.pid; }).filter((pid) => {
                    return pid && !before.includes(Number(pid));
                }), mainPid, beforePids);
            }

            if (!targets.length && process.env.FARM_CLOSE_LATEST_RENDERER !== "0") {
                targets = filterFarmCloseTargets((await getQQFarmCandidateProcesses(mainPid))
                    .filter((row) => { return row.name === "QQ.exe"; })
                    .sort((a, b) => { return String(b.createdAt).localeCompare(String(a.createdAt)); })
                    .slice(0, 1)
                    .map((row) => { return row.pid; }), mainPid, beforePids);
            }

            if (!targets.length && process.env.FARM_CLOSE_ALL_QQEX === "1") {
                targets = filterFarmCloseTargets(await getProcessIdsByName("QQEX"), mainPid, beforePids);
            }

            targets.slice().reverse().forEach((pid) => {
                try {
                    require("node:child_process").execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
                    logInfo(`已关闭农场小程序进程 (PID: ${  pid  })`);
                } catch(e) {}
            });
        } catch(e) {}
    }

    async function closeNewFarmProcesses(mainPid, beforePids) {
        try {
            const farmPids = await detectFarmProcessIds(mainPid, beforePids, 1000);
            await closeFarmProcesses(mainPid, beforePids, farmPids);
        } catch(e) {}
    }



    async function launchQQ(uin, cookies, nickname, autoLogin, ownerUsername, preferQQPath) {
  logInfo(`正在启动 QQ (uin: ${  uin  })`);
  const qqPath = findQQPath(preferQQPath);
  const userDataDir = getQQUserDataDirForUin(uin);
  const session = sessionsDb.findByUin(uin);
  const currentState = getLiveSessionState(session);
  if (currentState.alive) {
    logInfo(`QQ 已在运行 (PID: ${  session.pid  })`);
    return { pid: session.pid, alreadyRunning: true };
  }
  // macOS: detect existing QQ process or open QQ
  if (platform.IS_MAC) {
    var loginCookies = resolveLaunchCookies(cookies, session);
    try { fs.mkdirSync(userDataDir, { recursive: true }); } catch(e) {}
    logInfo(`QQ 启动数据目录: ${  userDataDir}`);
    let pids = await platform.getQQPids();
    if (pids.length === 0) {
      try { require("child_process").execSync("open -b com.tencent.qq", { timeout: 10000 }); } catch (e2) {}
      await new Promise((r) => { setTimeout(r, 3000); });
      pids = await platform.getQQPids();
    }
    var pid = pids[0] || null;
    logInfo(`QQ session 已创建 (PID: ${  pid || "null"  })`);
    sessionsDb.upsert({
      uin,
      nickname: nickname || '',
      pid,
      status: "online",
      cookies: JSON.stringify(loginCookies),
      processPath: pid ? '/Applications/QQ.app' : '',
      autoLogin: autoLogin === true,
      ownerUsername: String(ownerUsername || (session && session.ownerUsername) || '').trim(),
      createdAt: session && session.createdAt ? session.createdAt : Date.now(),
      lastActiveAt: Date.now()
    });
    const macLaunchedSession = sessionsDb.findByUin(uin);
    if (macLaunchedSession && macLaunchedSession.boundAccountId && macLaunchedSession.autoRefreshCode !== false) {
      sessionsDb.update(uin, { nextCodeRefreshAt: Date.now() + FARM_CODE_REFRESH_INTERVAL_MS });
      startCodeRefreshTimer(uin);
    }
    return { pid, alreadyRunning: !!pid };
  }
  // Windows: launch QQ.exe
  var loginCookies = resolveLaunchCookies(cookies, session);
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch(e) {}
  const args = buildQQLaunchArgs(uin);
  logInfo(`QQ 启动数据目录: ${  userDataDir}`);
  const qqProc = spawn(qqPath, args, { detached: true, stdio: "ignore", windowsHide: false });
  var pid = qqProc.pid;
  logInfo(`QQ.exe 已启动 (PID: ${  pid  })`);
  sessionsDb.upsert({
    uin,
    nickname: nickname || '',
    pid,
    status: "online",
    cookies: JSON.stringify(loginCookies),
    processPath: qqPath,
    autoLogin: autoLogin === true,
    ownerUsername: String(ownerUsername || (session && session.ownerUsername) || '').trim(),
    createdAt: session && session.createdAt ? session.createdAt : Date.now(),
    lastActiveAt: Date.now()
  });
  const mainPid = await waitForQQMainPidByUserDataDir(userDataDir, 8000);
  if (!mainPid) {
    sessionsDb.update(uin, { pid: null, status: "offline", farmPids: [], nextCodeRefreshAt: 0, lastActiveAt: Date.now() });
    const launchError = new Error("QQ 未启动为独立实例，可能被已有 QQ 窗口接管");
    launchError.statusCode = 409;
    throw launchError;
  }
  pid = mainPid;
  try { await injectFrida(pid, uin, loginCookies); } catch (e) { logError(`Frida 注入失败: ${  e.message}`); }
  sessionsDb.update(uin, { pid, status: "online", lastActiveAt: Date.now() });
  const launchedSession = sessionsDb.findByUin(uin);
  if (launchedSession && launchedSession.boundAccountId && launchedSession.autoRefreshCode !== false) {
    sessionsDb.update(uin, { nextCodeRefreshAt: Date.now() + FARM_CODE_REFRESH_INTERVAL_MS });
    startCodeRefreshTimer(uin);
  }
  qqProc.on("exit", () => {
    logInfo(`QQ.exe 已退出 (PID: ${  pid  })`);
    sessionsDb.update(uin, { pid: null, status: "offline", farmPids: [], nextCodeRefreshAt: 0, lastActiveAt: Date.now() });
    stopCodeRefreshTimer(uin);
    delete fridaProcesses[uin];
  });
  return { pid };
}
    function injectFrida(pid, uin, cookies) {
        return new Promise((resolve, reject) => {
            let src = fs.readFileSync(FRIDA_AGENT_PATH, "utf-8");
            src = src.replace("const REPORT_URL = 'http://127.0.0.1:3338/api/desktop-login/agent-status';", `const REPORT_URL = 'http://127.0.0.1:${  REPORT_PORT  }/api/desktop-login/agent-status';`);
            src = src.replace("const LOGIN_COOKIES = '{}';", `const LOGIN_COOKIES = '${  JSON.stringify(cookies).replace(/\\/g, "\\\\").replace(/'/g, "\\'")  }';`);
            src = src.replace("const TARGET_UIN = '';", `const TARGET_UIN = '${  uin  }';`);
            const tmp = path.join(require("os").tmpdir(), `desktop-login-agent-${  pid  }.js`);
            fs.writeFileSync(tmp, src, "utf-8");
            const fp = spawn("frida", [String(pid), "-l", tmp, "-q"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
            const to = setTimeout(() => { try { fs.unlinkSync(tmp); } catch (e) {} resolve(); }, 5000);
            fp.on("error", (err) => { clearTimeout(to); try { fs.unlinkSync(tmp); } catch (e) {} reject(new Error(`Frida 注入失败: ${  err.message}`)); });
            fp.on("exit", (code) => { clearTimeout(to); try { fs.unlinkSync(tmp); } catch (e) {} if (code === 0 || code === null) resolve(); else reject(new Error(`Frida 进程异常退出, code: ${  code}`)); });
        });
    }
    async function stopQQ(uin) {
        const s = sessionsDb.findByUin(uin);
        if (!s) throw new Error(`未找到 uin=${  uin  } 的 session`);
        if (s.pid) { try { process.kill(s.pid, "SIGTERM"); } catch (e) {} }
        try { spawn("taskkill", ["/PID", String(s.pid), "/F"], { windowsHide: true }); } catch (e) {}
        sessionsDb.update(uin, { pid: null, status: "offline", lastActiveAt: Date.now() });
        delete fridaProcesses[uin];
        logInfo(`QQ 进程已终止 (uin: ${  uin  })`);
    }
    function getSessions() {
        refreshAllSessionProcessStates();
        return sessionsDb.getAll();
    }
    function removeSession(uin) {
        const s = sessionsDb.findByUin(uin);
        if (s && s.pid) { try { process.kill(s.pid, "SIGTERM"); } catch (e) {} }
        stopCodeRefreshTimer(uin);
        sessionsDb.remove(uin);
        delete fridaProcesses[uin];
    }

    function bindCodeTarget(uin, accountId, accountName) {
        const key = String(uin || "").trim();
        const id = String(accountId || "").trim();
        const session = sessionsDb.findByUin(key);
        if (!session) throw new Error("Session not found");
        sessionsDb.update(key, {
            boundAccountId: id,
            boundAccountName: String(accountName || "").trim(),
            autoRefreshCode: !!id,
            lastCodeRefreshError: "",
            nextCodeRefreshAt: id ? Date.now() + FARM_CODE_REFRESH_INTERVAL_MS : 0,
        });
        if (id) startCodeRefreshTimer(key);
        else stopCodeRefreshTimer(key);
        return sessionsDb.findByUin(key);
    }
    async function openFarm(uin, options) {
        const s = sessionsDb.findByUin(uin);
        if (!s) throw new Error(`uin not found: ${  uin}`);
        if (!refreshSessionProcessState(s).alive) {
            const err = new Error("QQ 已退出，请先启动桌面 QQ");
            err.statusCode = 409;
            throw err;
        }

        farmCapture.clear(uin);
        const farmPidsBefore = await getQQProcessTreeSnapshot();
        let protocolCaptured = null;
        let protocolFarmPids = [];
        logInfo("使用协议抓包获取 Code");
        try {
            protocolCaptured = await captureProtocolCode({ log: logInfo });
            protocolFarmPids = await detectFarmProcessIds(s.pid, farmPidsBefore, 8000);
        } catch(e) {
            try {
                protocolFarmPids = await detectFarmProcessIds(s.pid, farmPidsBefore, 3000);
                if (protocolFarmPids.length) {
                    await closeFarmProcesses(s.pid, farmPidsBefore, protocolFarmPids);
                }
            } catch(_) {}
            throw e;
        }
        sessionsDb.update(uin, { farmPids: protocolFarmPids, lastActiveAt: Date.now() });
        if (protocolFarmPids.length) {
            logInfo(`农场小程序 PID: ${  protocolFarmPids.join(", ")}`);
        }
        if (protocolCaptured && protocolCaptured.code) {
            logInfo(`Code: ${  protocolCaptured.code.substring(0, 8)  }...`);
            reportFarmCapture({
                uin,
                pid: s.pid,
                code: protocolCaptured.code,
                url: protocolCaptured.url || "protocol",
                capturedAt: protocolCaptured.capturedAt || Date.now(),
            });
            await closeFarmProcesses(s.pid, farmPidsBefore, protocolFarmPids);
            sessionsDb.update(uin, { farmPids: protocolFarmPids, lastActiveAt: Date.now() });
            const protocolSession = sessionsDb.findByUin(uin) || s;
            // 准备绑定实例，然后后台异步刷新 Code
            prepareBoundAccountForCodeRefresh(s);
            // 后台异步刷新 Code，不阻塞前端响应
            (function() {
                const ps = protocolSession;
                const pc = protocolCaptured.code;
                applyCodeToBoundAccount(ps, pc).then((r) => {
                    if (r && r.ok && r.started) logInfo(`后台刷新完成，已用新 Code 启动实例: ${  String(pc).substring(0, 8)  }...`);
                    else if (r && r.ok && r.restarted) logInfo(`后台刷新完成，已用新 Code 重启绑定实例: ${  String(pc).substring(0, 8)  }...`);
                    else if (r && r.ok) logInfo(`后台刷新完成，已更新绑定实例 Code: ${  String(pc).substring(0, 8)  }...`);
                }).catch((e) => {
                    logError(`后台刷新 Code 失败: ${  e && e.message ? e.message : e}`);
                });
            })();
            return { ok: true, code: protocolCaptured.code, url: protocolCaptured.url || "protocol", capturedAt: protocolCaptured.capturedAt || Date.now(), pid: s.pid, farmPids: protocolFarmPids, manualRequired: false };
        }
        logInfo("协议抓包未捕获到 code");
        if (protocolFarmPids.length) await closeFarmProcesses(s.pid, farmPidsBefore, protocolFarmPids);
        sessionsDb.update(uin, { farmCode: null, farmPids: protocolFarmPids, lastCapturedAt: Date.now() });
        return { ok: true, code: null, pid: s.pid, farmPids: protocolFarmPids, manualRequired: false };
    }
    function getQQPids() {
        return platform.getQQPids();
    }

    async function autoStartSessions() {
        const sessions = sessionsDb.getAll().filter((s) => { return s.autoLogin && s.status === "offline"; });
        if (!sessions.length) { logInfo("没有需要自动登录的 session"); return; }
        logInfo(`发现 ${  sessions.length  } 个自动登录 session，正在启动...`);
        for (let i = 0; i < sessions.length; i++) {
            const s = sessions[i];
            try {
                let ck = {};
                try { ck = JSON.parse(s.cookies || "{}"); } catch (e) {}
                if (!Object.keys(ck).length) { logInfo(`跳过 ${  s.uin  }（无有效 cookies）`); continue; }
                await launchQQ(s.uin, ck, s.nickname, true, '', s.processPath || '');
                await new Promise((r) => { setTimeout(r, 5000); });
            } catch (e) { logError(`自动登录 ${  s.uin  } 失败: ${  e.message}`); }
        }
    }

    function reportFarmCapture(payload) {
        const body = payload || {};
        const result = farmCapture.setCode({
            uin: body.uin || "",
            pid: body.pid || 0,
            code: body.code || "",
            url: body.url || "",
            capturedAt: body.capturedAt || body.ts || Date.now(),
        });
        if (result.ok) {
            pendingFarmCode = result.code;
            pendingFarmCodeTime = result.capturedAt;
        }
        return result;
    }
    function setFarmCode(code) { return reportFarmCapture({ code }); }
    function getFarmCode() { return { code: pendingFarmCode, time: pendingFarmCodeTime }; }
    restoreCodeRefreshTimers();
    return { createQR, checkQrStatus, parseLoginResult, launchQQ, stopQQ, getSessions, removeSession, openFarm, bindCodeTarget, autoStartSessions, setFarmCode, reportFarmCapture, getFarmCode };
}
module.exports = {
    createDesktopLoginService,
    __privateDesktopFarmFns: {
        collectProcessTreePids,
        detectFarmRootPids,
        shouldCloseFarmOnCaptureFailure,
        filterFarmCloseTargets,
        getLiveSessionState,
        resolveLaunchCookies,
        shouldRunCodeRefreshTimer,
        buildQQLaunchArgs,
        findQQMainPidByUserDataDir,
    },
};

