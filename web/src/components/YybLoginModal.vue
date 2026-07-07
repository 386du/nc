<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'
import { useYybLoginStore } from '@/stores/yyb-login'

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits(['close', 'saved'])

const yybStore = useYybLoginStore()
const accountStore = useAccountStore()
const toast = useToastStore()

const loadingOpenId = ref<string | null>(null)
const accountNames = ref<Record<string, string>>({})

function resetNames() {
  const next: Record<string, string> = {}
  for (const a of yybStore.config.accounts) {
    if (!a || !a.openid) continue
    next[a.openid] = accountNames.value[a.openid] || a.name || ''
  }
  accountNames.value = next
}

watch(() => props.show, (show) => {
  if (show) {
    accountStore.fetchAccounts()
    yybStore.loadConfig().then(resetNames)
  }
})

const panelStyle = computed(() => ({
  background: 'var(--theme-bg)',
  boxShadow: '0 8px 32px rgba(0,0,0,0.24), 0 0 0 1px rgba(0,0,0,0.08)',
  maxHeight: 'min(85dvh, 700px)',
}))

function displayName(openid: string): string {
  const cfgName = yybStore.config.accounts.find((a: any) => a.openid === openid)?.name
  if (cfgName) return cfgName
  return `应用宝_${openid.slice(-6)}`
}

async function loginOne(openid: string) {
  loadingOpenId.value = openid
  try {
    const inputName = accountNames.value[openid]?.trim() || ''
    const name = inputName || displayName(openid)
    const result = await yybStore.reloginAccount(accountStore, openid, name)
    if (!result.ok) {
      toast.error(result.error || '登录失败')
      return false
    }

    toast.success(`已${accountStore.accounts.some((a: any) => a.openid === openid) ? '更新' : '添加'}并启动账号: ${name}`)
    emit('saved')
    return true
  }
  finally {
    loadingOpenId.value = null
  }
}

async function loginAll() {
  const openIds = yybStore.config.accounts.filter((a: any) => a.openid).map((a: any) => a.openid)
  if (openIds.length === 0) {
    toast.warning('请先配置 OpenID')
    return
  }
  loadingOpenId.value = 'all'
  let successCount = 0
  try {
    for (const openid of openIds) {
      const ok = await loginOne(openid)
      if (ok)
        successCount++
    }
  }
  finally {
    loadingOpenId.value = null
  }
  toast.success(`一键登录完成，成功 ${successCount}/${openIds.length}`)
  emit('close')
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
        class="absolute left-1/2 top-1/2 z-10 max-w-md w-[calc(100%-2rem)] flex flex-col rounded-2xl -translate-x-1/2 -translate-y-1/2"
        :style="panelStyle"
        @click.stop
      >
        <div class="flex shrink-0 items-center justify-between p-4" style="border-bottom: 1px solid color-mix(in srgb, var(--theme-text) 10%, transparent)">
          <div>
            <h3 class="text-lg font-semibold" style="color: var(--theme-primary, var(--theme-text))">
              应用宝一键登录
            </h3>
            <p class="mt-1 text-xs opacity-70" style="color: var(--theme-text)">
              为已配置的 OpenID 自动获取 Code 并添加/更新账号
            </p>
          </div>
          <BaseButton variant="ghost" class="!p-1" @click="close">
            <div class="i-carbon-close text-xl" :style="{ color: 'var(--theme-text)' }" />
          </BaseButton>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
          <div v-if="yybStore.loading && yybStore.config.accounts.length === 0" class="py-8 text-center text-sm text-gray-500">
            加载中...
          </div>

          <div v-else-if="yybStore.config.accounts.length === 0" class="py-8 text-center text-sm text-gray-500">
            尚未配置 OpenID，请先进入"应用宝配置"添加
          </div>

          <div v-else class="space-y-3">
            <div
              v-for="acc in yybStore.config.accounts"
              v-show="acc.openid"
              :key="acc.openid"
              class="border border-gray-200 rounded-xl bg-white p-3 space-y-2 dark:border-gray-600 dark:bg-gray-800"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium" style="color: var(--theme-text)">
                    {{ displayName(acc.openid) }}
                  </div>
                  <div class="text-xs opacity-60 truncate font-mono" style="color: var(--theme-text)">
                    {{ acc.openid }}
                  </div>
                </div>
                <BaseButton
                  variant="primary"
                  size="sm"
                  :loading="loadingOpenId === acc.openid"
                  :disabled="loadingOpenId !== null"
                  @click="loginOne(acc.openid)"
                >
                  登录
                </BaseButton>
              </div>
              <input
                v-model="accountNames[acc.openid]"
                placeholder="账号备注（可选）"
                class="farm-input w-full rounded-xl border-3 border-black/10 bg-white px-3 py-2 text-sm outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              >
            </div>
          </div>

          <div class="flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
            <BaseButton variant="outline" @click="close">
              关闭
            </BaseButton>
            <BaseButton
              v-if="yybStore.config.accounts.length > 0"
              variant="primary"
              :loading="loadingOpenId === 'all'"
              :disabled="loadingOpenId !== null"
              @click="loginAll"
            >
              一键登录全部
            </BaseButton>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
