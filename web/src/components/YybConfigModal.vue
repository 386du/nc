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

const config = ref<YybConfig>({
    enabled: false,
    endpoint: '',
    accounts: [],
    autoReconnect: true,
    reconnectIntervalMinutes: 0,
})

const newAccount = ref({ openid: '', name: '', apiToken: '' })
const saving = ref(false)

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

async function saveConfig() {
    saving.value = true
    try {
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
    catch (e: any) {
        toast.error(`保存失败: ${e?.response?.data?.error || e?.message || '未知错误'}`)
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

function close() {
    emit('close')
}

onMounted(() => {
    if (props.show) loadConfig()
})
</script>

<template>
    <div v-if="show" class="yyb-modal-overlay" @click.self="close">
        <div class="yyb-modal">
            <div class="yyb-modal-header">
                <h2>应用宝配置</h2>
                <button class="yyb-modal-close" @click="close">×</button>
            </div>
            <div class="yyb-modal-body">
                <p class="form-hint">每个 OpenID 可绑定独立 Token(不同外部 API 账号的 Token 不通用)</p>

                <div class="form-section">
                    <div class="form-row">
                        <label>接口地址</label>
                        <BaseInput v-model="config.endpoint" placeholder="http://211.154.25.123:28999/api/open/v1/farm/code" />
                    </div>
                </div>

                <div class="form-section">
                    <div class="form-row two-col">
                        <div>
                            <label>运行中定时重连间隔(分钟)</label>
                            <BaseInput v-model.number="config.reconnectIntervalMinutes" type="number" />
                            <p class="form-hint">输入 0 则不进行定时重登;设置后到达间隔时间将自动重新获取 Code 并重登</p>
                        </div>
                        <div>
                            <label>离线后自动重连</label>
                            <label class="switch-row">
                                <input v-model="config.autoReconnect" type="checkbox" />
                                <span>账号被踢下线或断线后自动获取新 Code 并重登</span>
                            </label>
                        </div>
                    </div>
                </div>

                <div class="form-section">
                    <div class="form-row list-header">
                        <label>OpenID 列表 ({{ config.accounts.length }} 个)</label>
                        <BaseButton size="sm" @click="addAccount" :disabled="!newAccount.openid.trim()">+ 添加</BaseButton>
                    </div>
                    <div class="add-account-row">
                        <BaseInput v-model="newAccount.openid" placeholder="openid" />
                        <BaseInput v-model="newAccount.name" placeholder="备注名 (可选)" />
                        <BaseInput v-model="newAccount.apiToken" placeholder="apiToken" type="password" />
                    </div>
                    <div v-if="config.accounts.length === 0" class="empty-tip">尚未添加 OpenID,点击右上"+ 添加"开始</div>
                    <div v-else class="account-list">
                        <div v-for="acc in config.accounts" :key="acc.openid" class="account-row">
                            <div class="account-info">
                                <div class="account-name">{{ acc.name || '(未命名)' }}</div>
                                <div class="account-openid">{{ acc.openid }}</div>
                                <div v-if="acc.apiTokenMask" class="last-code">Token: {{ acc.apiTokenMask }}</div>
                            </div>
                            <BaseButton size="sm" variant="danger" @click="removeAccount(acc.openid)">删除</BaseButton>
                        </div>
                    </div>
                </div>
            </div>
            <div class="yyb-modal-footer">
                <BaseButton variant="primary" :loading="saving" @click="saveConfig">保存</BaseButton>
                <BaseButton variant="secondary" @click="close">取消</BaseButton>
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
.form-hint {
    color: #888;
    font-size: 12px;
    margin: 0 0 12px;
}
.form-section {
    margin-bottom: 20px;
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
.form-row.list-header {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
}
.form-row label {
    font-size: 13px;
    color: #555;
}
.switch-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: #555;
    cursor: pointer;
}
.empty-tip {
    color: #999;
    text-align: center;
    padding: 20px;
    background: #f8f8f8;
    border-radius: 8px;
    border: 1px dashed #ddd;
}
.account-list {
    border: 1px solid #eee;
    border-radius: 8px;
    overflow: hidden;
    margin-top: 8px;
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
.add-account-row {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 8px;
    margin-bottom: 8px;
}
</style>
