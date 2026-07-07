<script setup lang="ts">
import { onMounted, ref } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import api from '@/api'
import { useToastStore } from '@/stores/toast'

const props = defineProps<{
    show: boolean
}>()

const emit = defineEmits(['close', 'saved'])

const toast = useToastStore()

interface YybAccount {
    openid: string
    name: string
    apiToken: string
    apiTokenMask?: string
}

interface YybConfig {
    enabled: boolean
    endpoint: string
    accounts: YybAccount[]
    autoReconnect: boolean
    reconnectIntervalMinutes: number
}

const config = ref<YybConfig | null>(null)
const saving = ref(false)
const fetching = ref<Record<string, boolean>>({})
const lastCodes = ref<Record<string, string>>({})
const refreshStatus = ref<{ running: boolean; username: string; intervalMs: number }>({ running: false, username: '', intervalMs: 0 })

async function loadConfig() {
    try {
        const res = await api.get('/api/yyb/config')
        if (res.data.ok) config.value = res.data.data
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

async function fetchOne(openid: string) {
    fetching.value[openid] = true
    try {
        const res = await api.post('/api/yyb/fetch-code', { openid })
        if (res.data.ok && res.data.data?.code) {
            lastCodes.value[openid] = res.data.data.code
            toast.success(`已拉取 ${openid} 的 code`)
            // 拉完 code 后让用户选择添加/更新账号
            await tryAddAccount(openid, res.data.data.code)
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

async function tryAddAccount(openid: string, code: string) {
    try {
        // 调后端"用 code 添加/更新账号"接口
        const res = await api.post('/api/yyb/add-account', { openid, code })
        if (res.data.ok) {
            toast.success(res.data.message || '账号已添加/更新')
            emit('saved')
        }
    }
    catch (e: any) {
        const err = e?.response?.data?.error || e?.message || '添加账号失败'
        toast.error(`添加账号失败: ${err}`)
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
    saving.value = true
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
    finally {
        saving.value = false
    }
}

async function stopRefresh() {
    saving.value = true
    try {
        await api.post('/api/yyb/refresh/stop')
        refreshStatus.value.running = false
        toast.info('已停止定时刷新')
    }
    catch (e: any) {
        toast.error(`停止失败: ${e?.response?.data?.error || e?.message}`)
    }
    finally {
        saving.value = false
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
                <h2>应用宝一键登录</h2>
                <button class="yyb-modal-close" @click="close">×</button>
            </div>
            <div class="yyb-modal-body">
                <div v-if="!config" class="empty-tip">加载中...</div>
                <template v-else>
                    <div v-if="!config.enabled" class="warn-tip">
                        应用宝功能未启用,请先在「应用宝配置」中启用。
                    </div>
                    <div v-else-if="!config.endpoint" class="warn-tip">
                        尚未配置接口地址,请先在「应用宝配置」中填写。
                    </div>
                    <div v-else-if="!config.accounts?.length" class="warn-tip">
                        尚未添加任何 OpenID,请先在「应用宝配置」中添加。
                    </div>

                    <div v-if="config?.accounts?.length" class="form-section">
                        <div class="form-row list-header">
                            <label>选择 OpenID 一键登录</label>
                            <BaseButton size="sm" @click="fetchAll">批量拉取</BaseButton>
                        </div>
                        <div class="account-list">
                            <div v-for="acc in config.accounts" :key="acc.openid" class="account-row">
                                <div class="account-info">
                                    <div class="account-name">{{ acc.name || '(未命名)' }}</div>
                                    <div class="account-openid">{{ acc.openid }}</div>
                                    <div v-if="lastCodes[acc.openid]" class="last-code">
                                        最近 code: <code>{{ (lastCodes[acc.openid] ?? '').slice(0, 8) }}***</code>
                                    </div>
                                </div>
                                <BaseButton size="sm" :loading="fetching[acc.openid]" @click="fetchOne(acc.openid)">
                                    一键登录
                                </BaseButton>
                            </div>
                        </div>
                    </div>

                    <div class="refresh-status">
                        定时刷新状态:<strong>{{ refreshStatus.running ? '运行中' : '已停止' }}</strong>
                        <span v-if="refreshStatus.running">({{ Math.round(refreshStatus.intervalMs / 60000) }} 分钟一次)</span>
                    </div>
                </template>
            </div>
            <div class="yyb-modal-footer">
                <BaseButton v-if="refreshStatus.running" variant="danger" :loading="saving" @click="stopRefresh">停止定时刷新</BaseButton>
                <BaseButton v-else variant="secondary" :loading="saving" @click="startRefresh">启动定时刷新</BaseButton>
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
    width: 640px;
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
.warn-tip {
    background: #fff7e6;
    border: 1px solid #ffd591;
    color: #874d00;
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 13px;
    margin-bottom: 12px;
}
.form-section {
    margin-bottom: 16px;
}
.form-row {
    margin-bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.form-row.list-header {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
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
