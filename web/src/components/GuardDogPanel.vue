<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { useAccountStore } from '@/stores/account'
import { useFriendStore } from '@/stores/friend'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const friendStore = useFriendStore()
const toast = useToastStore()

const { currentAccountId } = storeToRefs(accountStore)
const {
  friends,
  blacklist,
  guardDogBlacklist,
  guardDogWhitelist,
  guardDogGids,
  guardDogScanInProgress,
  guardDogScanProgress,
  guardDogScanCacheStats,
  guardDogScanError,
  loading,
} = storeToRefs(friendStore)

const activeTab = ref<'blacklist' | 'whitelist' | 'detected'>('detected')
const newGid = ref('')
const newGidName = ref('')
const saving = ref(false)
const scanning = ref(false)
let statusTimer: number | null = null

void friends

const blacklistSet = computed(() => new Set(blacklist.value.map(b => Number(b.gid))))
const guardDogBlackSet = computed(() => new Set(guardDogBlacklist.value.map(b => Number(b.gid))))
const guardDogWhiteSet = computed(() => new Set(guardDogWhitelist.value.map(w => Number(w.gid))))

const visibleFriends = computed(() => {
    const list = friends.value || []
    if (activeTab.value === 'blacklist') {
        return list.filter(f => !blacklistSet.value.has(Number(f.gid)))
    }
    return list
})

const scanPhase = computed(() => String(guardDogScanProgress.value?.phase || ''))
const scanInProgressPhase = computed(() => ['starting', 'scanning', 'auto_triggered'].includes(scanPhase.value))
const scanFinishedPhase = computed(() => ['completed', 'error', 'interrupted'].includes(scanPhase.value)
    || scanPhase.value.startsWith('error:'))

const scanPercent = computed(() => {
    const p = guardDogScanProgress.value?.progress
    if (!p || !p.total) return 0
    return Math.max(0, Math.min(100, Math.round((p.scanned / p.total) * 100)))
})

const scanCurrent = computed(() => guardDogScanProgress.value?.progress?.current || null)

function fmtTime(ts?: number | null) {
    if (!ts) return '-'
    try { return new Date(ts).toLocaleString() } catch { return String(ts) }
}

async function load() {
    if (!currentAccountId.value) return
    await Promise.all([
        friendStore.fetchFriends(currentAccountId.value),
        friendStore.fetchGuardDogBlacklist(currentAccountId.value),
        friendStore.fetchGuardDogWhitelist(currentAccountId.value),
        friendStore.fetchGuardDogGids(currentAccountId.value),
        friendStore.fetchGuardDogScanStatus(currentAccountId.value),
    ])
}

function startStatusPolling() {
    stopStatusPolling()
    if (!currentAccountId.value) return
    statusTimer = window.setInterval(async () => {
        if (!currentAccountId.value) return
        await friendStore.fetchGuardDogScanStatus(currentAccountId.value)
        if (!friendStore.guardDogScanInProgress) {
            await friendStore.fetchGuardDogGids(currentAccountId.value)
            stopStatusPolling()
        }
    }, 1500) as unknown as number
}

function stopStatusPolling() {
    if (statusTimer !== null) {
        clearInterval(statusTimer)
        statusTimer = null
    }
}

async function startScan() {
    if (!currentAccountId.value || scanning.value || guardDogScanInProgress.value) return
    scanning.value = true
    try {
        const res = await friendStore.startGuardDogScan(currentAccountId.value, {
            concurrency: 1,
            minIntervalMs: 400,
            maxIntervalMs: 900,
        })
        if (res && res.ok) {
            activeTab.value = 'detected'
            startStatusPolling()
        }
        else if (res && res.reason) {
            toast.warning(`扫描未启动: ${res.reason}`)
        }
    }
    finally {
        scanning.value = false
    }
}

async function clearScanStatus() {
    if (!currentAccountId.value) return
    await friendStore.clearGuardDogScanStatus(currentAccountId.value)
}

async function invalidateNoCache() {
    if (!currentAccountId.value) return
    const cleared = await friendStore.invalidateGuardDogNoCache(currentAccountId.value)
    if (cleared > 0) {
        toast.success(`已失效 ${cleared} 条负缓存,下次扫描将重新检查。`)
    }
    else {
        toast.info('负缓存为空,无需失效。')
    }
}

async function toggleBlack(gid: number) {
    if (!currentAccountId.value) return
    await friendStore.toggleGuardDogBlacklist(currentAccountId.value, gid)
    await friendStore.fetchGuardDogGids(currentAccountId.value)
}

async function toggleWhite(gid: number) {
    if (!currentAccountId.value) return
    await friendStore.toggleGuardDogWhitelist(currentAccountId.value, gid)
}

async function addByGid() {
    if (!currentAccountId.value) {
        toast.warning('请先选择账号')
        return
    }
    const gid = Number(newGid.value)
    if (!gid) {
        toast.warning('请输入有效 GID')
        return
    }
    if (activeTab.value === 'blacklist') {
        if (guardDogBlackSet.value.has(gid)) {
            toast.info('已在护主犬黑名单中')
            return
        }
        await friendStore.toggleGuardDogBlacklist(currentAccountId.value, gid)
    }
    else if (activeTab.value === 'whitelist') {
        if (guardDogWhiteSet.value.has(gid)) {
            toast.info('已在护主犬白名单中')
            return
        }
        await friendStore.toggleGuardDogWhitelist(currentAccountId.value, gid)
    }
    else {
        // detected tab: 加白名单
        if (guardDogWhiteSet.value.has(gid)) {
            toast.info('已在白名单中')
            return
        }
        await friendStore.toggleGuardDogWhitelist(currentAccountId.value, gid)
    }
    newGid.value = ''
    newGidName.value = ''
}

async function clearAll() {
    if (!currentAccountId.value) return
    if (activeTab.value === 'blacklist') {
        for (const b of [...guardDogBlacklist.value]) {
            await friendStore.toggleGuardDogBlacklist(currentAccountId.value, Number(b.gid))
        }
        toast.success('已清空护主犬黑名单')
    }
    else if (activeTab.value === 'whitelist') {
        saving.value = true
        try {
            await friendStore.setGuardDogWhitelist(currentAccountId.value, [])
            toast.success('已清空护主犬白名单')
        }
        finally {
            saving.value = false
        }
    }
}

watch(() => currentAccountId.value, () => { load() }, { immediate: true })

watch(() => guardDogScanInProgress.value, (v) => {
    if (v) startStatusPolling()
    else stopStatusPolling()
})

onMounted(() => {
    if (guardDogScanInProgress.value) startStatusPolling()
})

onBeforeUnmount(() => {
    stopStatusPolling()
})
</script>

<template>
    <div class="guard-dog-panel">
        <div class="panel-header">
            <div class="tab-bar">
                <button
                    class="tab-btn"
                    :class="{ active: activeTab === 'detected' }"
                    @click="activeTab = 'detected'"
                >
                    已检测到护主犬 ({{ guardDogGids.length }})
                </button>
                <button
                    class="tab-btn"
                    :class="{ active: activeTab === 'blacklist' }"
                    @click="activeTab = 'blacklist'"
                >
                    护主犬帮忙黑名单 ({{ guardDogBlacklist.length }})
                </button>
                <button
                    class="tab-btn"
                    :class="{ active: activeTab === 'whitelist' }"
                    @click="activeTab = 'whitelist'"
                >
                    护主犬帮忙白名单 ({{ guardDogWhitelist.length }})
                </button>
            </div>
            <div class="header-actions">
                <BaseButton
                    v-if="activeTab === 'detected'"
                    :loading="scanning || guardDogScanInProgress"
                    variant="primary"
                    @click="startScan"
                >
                    {{ guardDogScanInProgress || scanInProgressPhase ? '扫描中…' : '开始扫描' }}
                </BaseButton>
                <BaseButton
                    v-if="activeTab === 'detected' && scanFinishedPhase"
                    variant="outline"
                    @click="clearScanStatus"
                >
                    清除状态
                </BaseButton>
                <BaseButton
                    v-if="activeTab === 'detected'"
                    variant="outline"
                    :disabled="guardDogScanInProgress"
                    @click="invalidateNoCache"
                >
                    失效负缓存
                </BaseButton>
                <BaseButton
                    v-if="activeTab !== 'detected'"
                    size="sm"
                    variant="danger"
                    @click="clearAll"
                >
                    清空
                </BaseButton>
            </div>
        </div>

        <!-- 扫描状态卡片 -->
        <div v-if="activeTab === 'detected' && (scanPhase || guardDogScanError)" class="scan-status-card">
            <template v-if="scanInProgressPhase">
                <div class="scan-row">
                    <div class="scan-progress">
                        <div class="scan-bar" :style="{ width: scanPercent + '%' }"></div>
                    </div>
                    <div class="scan-text">
                        <span>阶段: <b>{{ scanPhase }}</b></span>
                        <span v-if="guardDogScanProgress?.progress">
                            已扫 {{ guardDogScanProgress.progress.scanned || 0 }} / {{ guardDogScanProgress.progress.total || 0 }}
                            ({{ scanPercent }}%)
                        </span>
                        <span v-if="guardDogScanProgress?.progress?.guardDogCount > 0">
                            命中: {{ guardDogScanProgress.progress.guardDogCount }}
                        </span>
                    </div>
                    <div v-if="scanCurrent" class="scan-current">
                        当前: <b>{{ scanCurrent.name || `GID:${scanCurrent.gid}` }}</b>
                        <span v-if="scanCurrent.status === 'guard_dog'" class="badge badge-danger">已检测到护主犬</span>
                        <span v-else-if="scanCurrent.status === 'error'" class="badge badge-warn">错误: {{ scanCurrent.message }}</span>
                        <span v-else class="badge badge-ok">已确认无护主犬</span>
                    </div>
                </div>
            </template>
            <template v-else-if="scanPhase === 'completed'">
                <div class="scan-done">
                    ✓ 扫描完成 — 共发现 <b>{{ guardDogScanProgress?.progress?.guardDogCount || 0 }}</b> 个护主犬好友,
                    新增 <b>{{ (guardDogScanProgress?.progress?.newGids || []).length }}</b> 个,
                    耗时 {{ Math.max(0, Math.round(((guardDogScanProgress?.finishedAt || 0) - (guardDogScanProgress?.startedAt || 0)) / 1000)) }}s
                </div>
            </template>
            <template v-else-if="scanPhase === 'interrupted'">
                <div class="scan-warn">⚠ 扫描被中断(账号进程退出)</div>
            </template>
            <template v-else-if="scanPhase.startsWith('error') || guardDogScanError">
                <div class="scan-err">✗ 扫描失败: {{ guardDogScanError || guardDogScanProgress?.error || scanPhase }}</div>
            </template>
        </div>

        <div v-if="activeTab === 'detected' && guardDogScanCacheStats" class="cache-stats">
            负缓存(已确认无护主犬): {{ guardDogScanCacheStats.count || 0 }} 条,
            TTL {{ guardDogScanCacheStats.ttlSec || 1800 }}s
            <span v-if="guardDogScanCacheStats.newestAt">· 最近 {{ fmtTime(guardDogScanCacheStats.newestAt) }}</span>
        </div>

        <div class="hint">
            <span v-if="activeTab === 'detected'">
                这里展示 worker 自动检测到的护主犬好友列表。点击"<b>开始扫描</b>"会逐个进入好友农场,识别出携带护主犬的并自动登记。
            </span>
            <span v-else-if="activeTab === 'blacklist'">
                黑名单中的好友<strong>不会被帮忙/偷菜</strong>,无论白名单是否为空。
            </span>
            <span v-else>
                当白名单非空时,<strong>只帮白名单中的好友</strong>;
                当白名单为空时,帮所有不在黑名单里的好友。
            </span>
        </div>

        <div v-if="activeTab !== 'detected'" class="add-by-gid">
            <BaseInput v-model="newGid" type="number" placeholder="好友 GID" />
            <BaseInput v-model="newGidName" placeholder="备注名(可选)" />
            <BaseButton @click="addByGid">添加</BaseButton>
        </div>

        <!-- detected: 已检测到护主犬 -->
        <div v-if="activeTab === 'detected'" class="current-list">
            <h4>已检测到护主犬的好友 ({{ guardDogGids.length }})</h4>
            <div v-if="guardDogGids.length === 0" class="empty">尚未检测到护主犬好友,点击右上"开始扫描"识别。</div>
            <div v-else class="list-grid">
                <div v-for="g in guardDogGids" :key="g.gid" class="list-item">
                    <div class="item-avatar">
                        <img v-if="g.avatarUrl" :src="g.avatarUrl" />
                        <div v-else class="avatar-fallback">{{ (g.name || 'G').charAt(0) }}</div>
                    </div>
                    <div class="item-info">
                        <div class="item-name">{{ g.name || `GID:${g.gid}` }}</div>
                        <div class="item-gid">{{ g.gid }}</div>
                    </div>
                    <div class="item-actions">
                        <BaseButton
                            size="sm"
                            :variant="guardDogBlackSet.has(g.gid) ? 'outline' : 'danger'"
                            @click="toggleBlack(g.gid)"
                        >
                            {{ guardDogBlackSet.has(g.gid) ? '已在黑名单' : '加黑名单' }}
                        </BaseButton>
                        <BaseButton
                            size="sm"
                            variant="primary"
                            :disabled="guardDogWhiteSet.has(g.gid)"
                            @click="toggleWhite(g.gid)"
                        >
                            {{ guardDogWhiteSet.has(g.gid) ? '已在白名单' : '加白名单' }}
                        </BaseButton>
                    </div>
                </div>
            </div>
        </div>

        <div v-else-if="activeTab === 'blacklist'" class="current-list">
            <h4>当前护主犬黑名单 ({{ guardDogBlacklist.length }})</h4>
            <div v-if="guardDogBlacklist.length === 0" class="empty">暂无</div>
            <div v-else class="list-grid">
                <div v-for="b in guardDogBlacklist" :key="b.gid" class="list-item">
                    <div class="item-avatar">
                        <img v-if="b.avatarUrl" :src="b.avatarUrl" />
                        <div v-else class="avatar-fallback">{{ (b.name || 'U').charAt(0) }}</div>
                    </div>
                    <div class="item-info">
                        <div class="item-name">{{ b.name || `GID:${b.gid}` }}</div>
                        <div class="item-gid">{{ b.gid }}</div>
                    </div>
                    <BaseButton size="sm" variant="danger" @click="toggleBlack(b.gid)">移除</BaseButton>
                </div>
            </div>
        </div>

        <div v-else class="current-list">
            <h4>当前护主犬白名单 ({{ guardDogWhitelist.length }})</h4>
            <div v-if="guardDogWhitelist.length === 0" class="empty">白名单为空时,帮所有不在黑名单里的好友</div>
            <div v-else class="list-grid">
                <div v-for="w in guardDogWhitelist" :key="w.gid" class="list-item">
                    <div class="item-avatar">
                        <img v-if="w.avatarUrl" :src="w.avatarUrl" />
                        <div v-else class="avatar-fallback">{{ (w.name || 'U').charAt(0) }}</div>
                    </div>
                    <div class="item-info">
                        <div class="item-name">{{ w.name || `GID:${w.gid}` }}</div>
                        <div class="item-gid">{{ w.gid }}</div>
                    </div>
                    <BaseButton size="sm" variant="danger" @click="toggleWhite(w.gid)">移除</BaseButton>
                </div>
            </div>
        </div>

        <div v-if="activeTab !== 'detected'" class="quick-add">
            <h4>从好友列表快速{{ activeTab === 'blacklist' ? '加入黑' : '加入白' }}名单</h4>
            <div v-if="loading" class="empty">加载中...</div>
            <div v-else-if="visibleFriends.length === 0" class="empty">无好友</div>
            <div v-else class="list-grid">
                <div v-for="f in visibleFriends" :key="f.gid" class="list-item">
                    <div class="item-avatar">
                        <img v-if="f.avatarUrl || f.avatar_url" :src="f.avatarUrl || f.avatar_url" />
                        <div v-else class="avatar-fallback">{{ (f.name || 'U').charAt(0) }}</div>
                    </div>
                    <div class="item-info">
                        <div class="item-name">{{ f.name || f.remark || `GID:${f.gid}` }}</div>
                        <div class="item-gid">{{ f.gid }}</div>
                    </div>
                    <BaseButton
                        v-if="activeTab === 'blacklist'"
                        size="sm"
                        variant="outline"
                        @click="toggleBlack(f.gid)"
                    >
                        加黑
                    </BaseButton>
                    <BaseButton
                        v-else
                        size="sm"
                        variant="primary"
                        @click="toggleWhite(f.gid)"
                    >
                        加白
                    </BaseButton>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.guard-dog-panel {
    background: #fff;
    border-radius: 8px;
    padding: 16px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}
.panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
}
.tab-bar {
    display: flex;
    gap: 4px;
}
.tab-btn {
    background: #f5f5f5;
    border: 0;
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    color: #555;
}
.tab-btn.active {
    background: #1976d2;
    color: #fff;
}
.hint {
    background: #f0f8ff;
    border-left: 3px solid #1976d2;
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 12px;
    color: #333;
    margin-bottom: 12px;
}
.hint strong {
    color: #d33;
}
.add-by-gid {
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    gap: 8px;
    margin-bottom: 16px;
}
.current-list h4 {
    font-size: 13px;
    margin: 0 0 8px;
    color: #555;
}
.list-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 8px;
}
.list-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    background: #f8f8f8;
    border-radius: 6px;
}
.item-avatar img {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    object-fit: cover;
}
.avatar-fallback {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: #1976d2;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 600;
}
.item-info {
    flex: 1;
    min-width: 0;
}
.item-name {
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.item-gid {
    font-size: 11px;
    color: #888;
    font-family: monospace;
}
.empty {
    color: #999;
    text-align: center;
    padding: 20px;
    background: #fafafa;
    border-radius: 6px;
    font-size: 13px;
}
.quick-add {
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid #eee;
}
.quick-add h4 {
    font-size: 13px;
    margin: 0 0 8px;
    color: #555;
}
.scan-status-card {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 12px;
}
.scan-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.scan-progress {
    background: #e2e8f0;
    border-radius: 4px;
    height: 8px;
    overflow: hidden;
}
.scan-bar {
    background: #1976d2;
    height: 100%;
    transition: width 0.3s;
}
.scan-text {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    font-size: 12px;
    color: #555;
}
.scan-current {
    font-size: 12px;
    color: #333;
}
.badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
    margin-left: 4px;
}
.badge-danger {
    background: #fef2f2;
    color: #dc2626;
    border: 1px solid #fecaca;
}
.badge-warn {
    background: #fefce8;
    color: #ca8a04;
    border: 1px solid #fef08a;
}
.badge-ok {
    background: #f0fdf4;
    color: #16a34a;
    border: 1px solid #bbf7d0;
}
.scan-done {
    color: #16a34a;
    font-size: 13px;
}
.scan-warn {
    color: #ca8a04;
    font-size: 13px;
}
.scan-err {
    color: #dc2626;
    font-size: 13px;
}
.cache-stats {
    background: #fafafa;
    border-radius: 4px;
    padding: 6px 12px;
    font-size: 12px;
    color: #666;
    margin-bottom: 12px;
}
.item-actions {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: stretch;
}
</style>
