<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useToastStore } from '@/stores/toast'
import { useYybLoginStore } from '@/stores/yyb-login'

interface AccountDraft {
  openid: string
  apiToken: string
  name: string
  _showToken?: boolean
}

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits(['close'])

const yybStore = useYybLoginStore()
const toast = useToastStore()
const saving = ref(false)

const form = ref({
  endpoint: 'http://211.154.25.123:28999/api/open/v1/farm/code',
  reconnectIntervalMinutes: 0,
  autoReconnect: true,
  accounts: [] as AccountDraft[],
})

function resetForm() {
  const cfg = yybStore.config
  form.value = {
    endpoint: cfg.endpoint || 'http://211.154.25.123:28999/api/open/v1/farm/code',
    reconnectIntervalMinutes: cfg.reconnectIntervalMinutes || 0,
    autoReconnect: cfg.autoReconnect !== false,
    accounts: Array.isArray(cfg.accounts)
      ? cfg.accounts.map((a: any) => ({ openid: a.openid || '', apiToken: a.apiToken || '', name: a.name || '' }))
      : [],
  }
}

watch(() => props.show, (show) => {
  if (show) {
    yybStore.loadConfig().then(resetForm)
  }
})

const panelStyle = computed(() => ({
  background: 'var(--theme-bg)',
  boxShadow: '0 8px 32px rgba(0,0,0,0.24), 0 0 0 1px rgba(0,0,0,0.08)',
  maxHeight: 'min(85dvh, 700px)',
}))

const interval = computed({
  get: () => form.value.reconnectIntervalMinutes,
  set: (v: number) => {
    form.value.reconnectIntervalMinutes = Math.max(0, Number.isFinite(Number(v)) ? Number(v) : 0)
  },
})

function increaseInterval() {
  form.value.reconnectIntervalMinutes += 1
}

function decreaseInterval() {
  if (form.value.reconnectIntervalMinutes > 0) {
    form.value.reconnectIntervalMinutes -= 1
  }
}

function addAccount() {
  form.value.accounts.push({ openid: '', apiToken: '', name: '' })
}

function removeAccount(index: number) {
  form.value.accounts.splice(index, 1)
}

function toggleTokenVisible(index: number) {
  const acc = form.value.accounts[index] as any
  acc._showToken = !acc._showToken
}

function isTokenVisible(index: number): boolean {
  const acc = form.value.accounts[index] as any
  return !!acc._showToken
}

async function handleSave() {
  saving.value = true
  try {
    // 清理:openid 或 token 为空的条目丢弃
    const cleaned = form.value.accounts
      .map(a => ({ openid: a.openid.trim(), apiToken: a.apiToken.trim(), name: a.name.trim() }))
      .filter(a => a.openid && a.apiToken)

    // 同 openid 去重
    const seen = new Set<string>()
    const deduped = cleaned.filter((a) => {
      if (seen.has(a.openid)) return false
      seen.add(a.openid)
      return true
    })

    await yybStore.saveConfig({
      enabled: true,
      endpoint: form.value.endpoint,
      reconnectIntervalMinutes: form.value.reconnectIntervalMinutes,
      autoReconnect: form.value.autoReconnect,
      accounts: deduped,
    })
    toast.success('应用宝配置已保存')
    emit('close')
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '保存失败')
  }
  finally {
    saving.value = false
  }
}

function close() {
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="fixed inset-0 z-50">
      <div class="absolute inset-0 bg-black/40 backdrop-blur-sm" @click.self="close" />
      <div
        class="absolute left-1/2 top-1/2 z-10 max-w-lg w-[calc(100%-2rem)] flex flex-col rounded-2xl -translate-x-1/2 -translate-y-1/2"
        :style="panelStyle"
        @click.stop
      >
        <div class="flex shrink-0 items-center justify-between p-4" style="border-bottom: 1px solid color-mix(in srgb, var(--theme-text) 10%, transparent)">
          <div>
            <h3 class="text-lg font-semibold" style="color: var(--theme-primary, var(--theme-text))">
              应用宝配置
            </h3>
            <p class="mt-1 text-xs opacity-70" style="color: var(--theme-text)">
              每个 OpenID 可绑定独立 Token(不同外部 API 账号的 Token 不通用)
            </p>
          </div>
          <BaseButton variant="ghost" class="!p-1" @click="close">
            <div class="i-carbon-close text-xl" :style="{ color: 'var(--theme-text)' }" />
          </BaseButton>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-4">
          <div class="space-y-4">
            <BaseInput
              v-model="form.endpoint"
              label="接口地址"
              placeholder="请输入接口地址"
              class="farm-input"
            />

            <div class="space-y-2">
              <label class="text-sm text-gray-700 font-medium dark:text-gray-300">
                运行中定时重连间隔（分钟）
              </label>
              <div class="flex items-center overflow-hidden border-3 border-black/10 rounded-xl bg-white dark:border-gray-600 dark:bg-gray-800">
                <button
                  type="button"
                  class="h-11 w-12 flex items-center justify-center text-lg font-bold transition hover:bg-gray-100 dark:hover:bg-gray-700"
                  :style="{ color: 'var(--theme-text)' }"
                  @click="decreaseInterval"
                >
                  −
                </button>
                <input
                  v-model.number="interval"
                  type="number"
                  min="0"
                  class="h-11 min-w-0 flex-1 border-x-3 border-black/10 bg-transparent text-center outline-none dark:border-gray-600 dark:text-white"
                >
                <button
                  type="button"
                  class="h-11 w-12 flex items-center justify-center text-lg font-bold transition hover:bg-gray-100 dark:hover:bg-gray-700"
                  :style="{ color: 'var(--theme-text)' }"
                  @click="increaseInterval"
                >
                  +
                </button>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                输入 0 则不进行定时重登；设置后到达间隔时间将自动重新获取 Code 并重登
              </p>
            </div>

            <div class="space-y-1">
              <BaseSwitch v-model="form.autoReconnect" label="离线后自动重连" />
              <p class="text-xs text-gray-500 dark:text-gray-400">
                账号被踢下线或断线后自动获取新 Code 并重登
              </p>
            </div>

            <div class="space-y-2">
              <div class="flex items-center justify-between">
                <label class="text-sm text-gray-700 font-medium dark:text-gray-300">
                  OpenID 列表
                  <span class="text-xs opacity-70">({{ form.accounts.length }} 个)</span>
                </label>
                <BaseButton variant="secondary" size="sm" @click="addAccount">
                  + 添加
                </BaseButton>
              </div>

              <div v-if="form.accounts.length === 0" class="rounded-xl border border-dashed border-gray-300 bg-gray-50/50 p-4 text-center text-xs text-gray-500 dark:border-gray-600 dark:bg-gray-800/30 dark:text-gray-400">
                尚未添加 OpenID,点击右上"+ 添加"开始
              </div>

              <div v-else class="space-y-3">
                <div
                  v-for="(acc, index) in form.accounts"
                  :key="index"
                  class="rounded-xl border border-gray-200 bg-white p-3 space-y-2 dark:border-gray-600 dark:bg-gray-800"
                >
                  <div class="flex items-center justify-between">
                    <span class="text-xs opacity-70" style="color: var(--theme-text)">
                      账号 #{{ index + 1 }}
                    </span>
                    <button
                      type="button"
                      class="text-gray-400 hover:text-red-500 dark:hover:text-red-400"
                      @click="removeAccount(index)"
                    >
                      <div class="i-carbon-trash-can text-lg" />
                    </button>
                  </div>

                  <BaseInput
                    v-model="acc.openid"
                    label="OpenID"
                    placeholder="输入 OpenID"
                    class="farm-input"
                  />

                  <div class="space-y-1">
                    <div class="flex items-center justify-between">
                      <label class="text-xs text-gray-700 font-medium dark:text-gray-300">
                        API Token
                      </label>
                      <button
                        type="button"
                        class="text-xs opacity-70 hover:opacity-100"
                        style="color: var(--theme-text)"
                        @click="toggleTokenVisible(index)"
                      >
                        {{ isTokenVisible(index) ? '隐藏' : '显示' }}
                      </button>
                    </div>
                    <input
                      v-model="acc.apiToken"
                      :type="isTokenVisible(index) ? 'text' : 'password'"
                      placeholder="该 OpenID 对应的 API Token"
                      class="farm-input w-full rounded-xl border-3 border-black/10 bg-white px-3 py-2 text-sm outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                    >
                  </div>

                  <BaseInput
                    v-model="acc.name"
                    label="备注名 (可选)"
                    placeholder="例如:大号 / 小号 / 角色1"
                    class="farm-input"
                  />
                </div>
              </div>
            </div>

            <div class="flex justify-end gap-2 pt-2">
              <BaseButton variant="outline" @click="close">
                取消
              </BaseButton>
              <BaseButton variant="primary" :loading="saving" @click="handleSave">
                保存
              </BaseButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
