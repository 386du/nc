export {};
/**
 * 扫描进度共享状态 - 由 worker IPC 更新，由 data-provider / route 读取，供前端轮询
 * 每个账号一个 entry；status: 'running' | 'done' | 'error' | 'interrupted'；updatedAt 用来在 status 长时间不更新时视为超时
 */
const scanStatusMap: Map<string, any> = new Map();

function key(accountId: unknown): string {
    return String(accountId || '').trim();
}

export function setScanStatus(accountId: unknown, status: any): void {
    const k = key(accountId);
    if (!k) return;
    scanStatusMap.set(k, {
        ...(scanStatusMap.get(k) || {}),
        ...status,
        updatedAt: Date.now(),
    });
}

export function getScanStatus(accountId: unknown): any {
    const k = key(accountId);
    if (!k) return null;
    const v = scanStatusMap.get(k);
    return v ? { ...v } : null;
}

export function clearScanStatus(accountId: unknown): void {
    scanStatusMap.delete(key(accountId));
}

/**
 * 判断该账号是否正在进行护主犬扫描（status === 'running'）。
 * 用于 yyb-relogin 等场景在扫描期间跳过定时重启，避免打断长任务。
 */
export function isScanInProgress(accountId: unknown): boolean {
    const st = getScanStatus(accountId);
    return !!(st && st.status === 'running');
}

module.exports = {
    setScanStatus,
    getScanStatus,
    clearScanStatus,
    isScanInProgress,
};
