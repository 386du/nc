<script setup lang="ts">
import { onMounted, ref } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import api from '@/api'
import { useToastStore } from '@/stores/toast'

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits(['close'])

const toast = useToastStore()

interface YybConfig {
    enabled: boolean
    endpoint: string
    accounts: { openid: string; name: string; apiToken: string; apiTokenMask?: string }[]
    autoReconnect: boolean
    reconnectIntervalMinutes: number
}

const config = ref<YybConfig>({
    enabled: false,
    endpoint: '',
    accounts: [],
    autoReconnect: true,
    reconnectIntervalMinutes: 0,
})

const newAccount = ref({ openid: '', name: '', apiToken: '' })
const saving = ref(false)
const fetching = ref<Record<string, boolean>>({})
const lastCodes = ref<Record<string, string>>({})
const refreshStatus = ref<{ running: boolean; username: string; intervalMs: number }>({ running: false, username: '', intervalMs: 0 })

async function loadConfig() {
    try {
        const res = await api.get('/api/yyb/config')
        if (res.data.ok) {
            config.value = {
                ...res.data.data,
                accounts: (res.data.data.accounts || []).map((a: any) => ({
                    openid: a.openid,
                    name: a.name || '',
                    apiToken: '',
                    apiTokenMask: a.apiTokenMask,
                })),
            }
        }
    }
    catch { /* ignore */ }
}

async function loadRefreshStatus() {
    try {
        const res = await api.get('/api/yyb/refresh/status')
        if (res.data.ok) refreshStatus.value = res.data.data || refreshStatus.value
    }
    catch { /* ignore */ }
}

async function saveConfig() {
    saving.value = true
    try {
        // 提交时：未填 apiToken 的保留旧值
        const accounts = config.value.accounts.map((a) => ({
            openid: a.openid,
            name: a.name,
            apiToken: a.apiToken,
        }))
        const res = await api.post('/api/yyb/config', {
            enabled: config.value.enabled,
            endpoint: config.value.endpoint,
            accounts,
            autoReconnect: config.value.autoReconnect,
            reconnectIntervalMinutes: config.value.reconnectIntervalMinutes,
        })
        if (res.data.ok) {
            toast.success('应用宝配置已保存')
            await loadConfig()
        }
    }
    finally {
        saving.value = false
    }
}

function addAccount() {
    const o = newAccount.value.openid.trim()
    if (!o) {
        toast.warning('openid 必填')
        return
    }
    if (config.value.accounts.some(a => a.openid === o)) {
        toast.warning('openid 已存在')
        return
    }
    config.value.accounts.push({
        openid: o,
        name: newAccount.value.name.trim(),
        apiToken: newAccount.value.apiToken.trim(),
    })
    newAccount.value = { openid: '', name: '', apiToken: '' }
}

function removeAccount(openid: string) {
    config.value.accounts = config.value.accounts.filter(a => a.openid !== openid)
}

async function fetchOne(openid: string) {
    fetching.value[openid] = true
    try {
        const res = await api.post('/api/yyb/fetch-code', { openid })
        if (res.data.ok) {
            lastCodes.value[openid] = res.data.data.code
            toast.success(`已拉取 ${openid} 的 code`)
        }
    }
    catch (e: any) {
        const err = e?.response?.data?.error || e?.message || '拉取失败'
        toast.error(`拉取失败: ${err}`)
    }
    finally {
        fetching.value[openid] = false
    }
}

async function fetchAll() {
    try {
        const res = await api.post('/api/yyb/fetch-all')
        if (res.data.ok && res.data.data) {
            for (const r of res.data.data.results || []) {
                if (r.ok && r.code) lastCodes.value[r.openid] = r.code
            }
            const { okCount, total } = res.data.data
            toast[okCount === total ? 'success' : 'warning'](`拉取完成: ${okCount}/${total}`)
        }
    }
    catch (e: any) {
        toast.error(`批量拉取失败: ${e?.response?.data?.error || e?.message}`)
    }
}

async function startRefresh() {
    try {
        const res = await api.post('/api/yyb/refresh/start')
        if (res.data.ok) {
            refreshStatus.value = res.data.data
            toast.success('已启动定时刷新')
        }
    }
    catch (e: any) {
        toast.error(`启动失败: ${e?.response?.data?.error || e?.message}`)
    }
}

async function stopRefresh() {
    try {
        await api.post('/api/yyb/refresh/stop')
        refreshStatus.value.running = false
        toast.info('已停止定时刷新')
    }
    catch (e: any) {
        toast.error(`停止失败: ${e?.response?.data?.error || e?.message}`)
    }
}

function close() {
    emit('close')
}

onMounted(() => {
    if (props.show) {
        loadConfig()
        loadRefreshStatus()
    }
})
</script>

<template>
    <div v-if="show" class="yyb-modal-overlay" @click.self="close">
        <div class="yyb-modal">
            <div class="yyb-modal-header">
                <h2>应用宝登录配置</h2>
                <button class="yyb-modal-close" @click="close">×</button>
            </div>
            <div class="yyb-modal-body">
                <div class="form-section">
                    <div class="form-row">
                        <label>
                            <input v-model="config.enabled" type="checkbox" />
                            启用应用宝登录
                        </label>
                    </div>
                    <div class="form-row">
                        <label>API 端点</label>
                        <BaseInput v-model="config.endpoint" placeholder="https://example.com/api/fetch-code" />
                    </div>
                    <div class="form-row two-col">
                        <div>
                            <label>自动重连</label>
                            <label>
                                <input v-model="config.autoReconnect" type="checkbox" />
                                启用
                            </label>
                        </div>
                        <div>
                            <label>刷新间隔 (分钟，0=不自动)</label>
                            <BaseInput v-model.number="config.reconnectIntervalMinutes" type="number" />
                        </div>
                    </div>
                </div>

                <div class="form-section">
                    <h3>账号列表</h3>
                    <div v-if="config.accounts.length === 0" class="empty-tip">暂无账号，请添加</div>
                    <div v-else class="account-list">
                        <div v-for="acc in config.accounts" :key="acc.openid" class="account-row">
                            <div class="account-info">
                                <div class="account-name">{{ acc.name || '(未命名)' }}</div>
                                <div class="account-openid">{{ acc.openid }}</div>
                                <div v-if="lastCodes[acc.openid]" class="last-code">
                                    最近 code: <code>{{ (lastCodes[acc.openid] ?? '').slice(0, 8) }}***</code>
                                </div>
                            </div>
                            <div class="account-actions">
                                <BaseButton size="sm" :loading="fetching[acc.openid]" @click="fetchOne(acc.openid)">
                                    拉取
                                </BaseButton>
                                <BaseButton size="sm" variant="danger" @click="removeAccount(acc.openid)">
                                    删除
                                </BaseButton>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="form-section">
                    <h3>添加账号</h3>
                    <div class="add-account-row">
                        <BaseInput v-model="newAccount.openid" placeholder="openid" />
                        <BaseInput v-model="newAccount.name" placeholder="备注名 (可选)" />
                        <BaseInput v-model="newAccount.apiToken" placeholder="apiToken" />
                        <BaseButton @click="addAccount">添加</BaseButton>
                    </div>
                </div>

                <div class="refresh-status">
                    定时刷新状态：<strong>{{ refreshStatus.running ? '运行中' : '已停止' }}</strong>
                    <span v-if="refreshStatus.running">({{ Math.round(refreshStatus.intervalMs / 60000) }} 分钟一次)</span>
                </div>
            </div>
            <div class="yyb-modal-footer">
                <BaseButton variant="secondary" @click="fetchAll">批量拉取</BaseButton>
                <BaseButton v-if="!refreshStatus.running" @click="startRefresh">启动定时刷新</BaseButton>
                <BaseButton v-else variant="danger" @click="stopRefresh">停止定时刷新</BaseButton>
                <BaseButton variant="primary" :loading="saving" @click="saveConfig">保存配置</BaseButton>
                <BaseButton variant="secondary" @click="close">关闭</BaseButton>
            </div>
        </div>
    </div>
</template>

<style scoped>
.yyb-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
}
.yyb-modal {
    background: #fff;
    border-radius: 12px;
    width: 720px;
    max-width: 90vw;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
.yyb-modal-header {
    padding: 16px 20px;
    border-bottom: 1px solid #eee;
    display: flex;
    align-items: center;
    justify-content: space-between;
}
.yyb-modal-header h2 {
    margin: 0;
    font-size: 18px;
}
.yyb-modal-close {
    background: none;
    border: 0;
    font-size: 24px;
    cursor: pointer;
}
.yyb-modal-body {
    padding: 16px 20px;
    overflow-y: auto;
    flex: 1;
}
.yyb-modal-footer {
    padding: 12px 20px;
    border-top: 1px solid #eee;
    display: flex;
    gap: 8px;
    justify-content: flex-end;
}
.form-section {
    margin-bottom: 20px;
}
.form-section h3 {
    font-size: 14px;
    margin: 0 0 8px;
    color: #555;
}
.form-row {
    margin-bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.form-row.two-col {
    flex-direction: row;
    gap: 16px;
}
.form-row.two-col > div {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.form-row label {
    font-size: 13px;
    color: #555;
}
.empty-tip {
    color: #999;
    text-align: center;
    padding: 20px;
    background: #f8f8f8;
    border-radius: 8px;
}
.account-list {
    border: 1px solid #eee;
    border-radius: 8px;
    overflow: hidden;
}
.account-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px;
    border-bottom: 1px solid #f0f0f0;
}
.account-row:last-child {
    border-bottom: 0;
}
.account-info {
    flex: 1;
}
.account-name {
    font-weight: 600;
    font-size: 14px;
}
.account-openid {
    color: #888;
    font-size: 12px;
    font-family: monospace;
}
.last-code {
    margin-top: 4px;
    color: #0a0;
    font-size: 12px;
}
.account-actions {
    display: flex;
    gap: 6px;
}
.add-account-row {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr auto;
    gap: 8px;
    align-items: end;
}
.refresh-status {
    background: #f0f8ff;
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 13px;
    color: #333;
}
.refresh-status strong {
    color: #1976d2;
    margin: 0 4px;
}
</style>
