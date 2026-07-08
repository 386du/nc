/**
 * 应用宝一键登录 Pinia Store
 *
 * 与 386du/qq-farm-bot 项目同款 store 行为：
 *  - loadConfig / saveConfig: 走 /api/user/yyb-config
 *  - fetchCode: 走 /api/yyb/code
 *  - reloginAccount: 拉 code + upsert 账号(写 loginType='yyb' / openid) + 自动启动
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'

export interface YybOpenIdEntry {
  openid: string
  apiToken: string
  name?: string
}

export interface YybConfig {
  enabled: boolean
  endpoint: string
  reconnectIntervalMinutes: number
  autoReconnect: boolean
  accounts: YybOpenIdEntry[]
}

const defaultConfig: YybConfig = {
  enabled: false,
  endpoint: 'http://211.154.25.123:28999/api/open/v1/farm/code',
  reconnectIntervalMinutes: 0,
  autoReconnect: true,
  accounts: [],
}

export const useYybLoginStore = defineStore('yyb-login', () => {
  const rawConfig = ref<YybConfig>({ ...defaultConfig })
  const loading = ref(false)
  const fetchingCode = ref(false)
  const processingOpenIds = new Set<string>()

  const config = computed<YybConfig>(() => ({
    ...defaultConfig,
    ...rawConfig.value,
  }))

  async function loadConfig() {
    loading.value = true
    try {
      const res = await api.get('/api/user/yyb-config')
      if (res.data?.ok && res.data.config) {
        rawConfig.value = { ...defaultConfig, ...res.data.config }
      }
      else {
        rawConfig.value = { ...defaultConfig }
      }
    }
    catch (e) {
      console.error('加载应用宝配置失败', e)
      rawConfig.value = { ...defaultConfig }
    }
    finally {
      loading.value = false
    }
  }

  async function saveConfig(payload: Partial<YybConfig>) {
    const merged: YybConfig = { ...config.value, ...payload }
    const res = await api.post('/api/user/yyb-config', merged)
    if (res.data?.ok && res.data.config) {
      rawConfig.value = { ...defaultConfig, ...res.data.config }
    }
    return res.data
  }

  async function fetchCode(openid: string): Promise<{ ok: boolean, code?: string, error?: string }> {
    fetchingCode.value = true
    try {
      const res = await api.post('/api/yyb/code', { openid }, { skipErrorToast: true } as any)
      if (res.data?.ok && res.data.code) {
        return { ok: true, code: res.data.code }
      }
      return { ok: false, error: res.data?.error || '获取 Code 失败' }
    }
    catch (e: any) {
      const msg = e?.response?.data?.error || e?.message || '请求失败'
      return { ok: false, error: msg }
    }
    finally {
      fetchingCode.value = false
    }
  }

  /**
   * 为指定 OpenID 获取新 Code 并更新/新增账号，确保账号处于运行状态。
   * 自动重连由后端 yyb-relogin 服务统一处理。
   */
  async function reloginAccount(
    accountStore: any,
    openid: string,
    preferName?: string,
  ): Promise<{ ok: boolean, accountId?: string, started?: boolean, error?: string }> {
    if (!openid) {
      return { ok: false, error: '缺少 OpenID' }
    }
    if (processingOpenIds.has(openid)) {
      return { ok: false, error: '正在重连中' }
    }

    processingOpenIds.add(openid)
    try {
      const result = await fetchCode(openid)
      if (!result.ok || !result.code) {
        return { ok: false, error: result.error || '获取 Code 失败' }
      }

      // 优先用传入的 preferName,其次用配置里的 name,最后用 openid 末 6 位
      const entry = rawConfig.value.accounts.find((a: any) => a.openid === openid)
      const name = preferName?.trim() || (entry && entry.name ? entry.name : '') || `应用宝_${openid.slice(-6)}`

      // 优先按 openid 匹配
      const existing = (accountStore.accounts || []).find((a: any) => String(a.openid) === String(openid))

      try {
        if (existing) {
          await accountStore.updateAccount(String(existing.id), {
            name,
            code: result.code,
            platform: 'wx',
            loginType: 'yyb',
            openid,
          })
        }
        else {
          await accountStore.addAccount({
            name,
            code: result.code,
            platform: 'wx',
            loginType: 'yyb',
            openid,
          })
        }

        // 刷新账号列表,并启动账号
        await accountStore.fetchAccounts()
        const updated = (accountStore.accounts || []).find((a: any) => String(a.openid) === String(openid))
        if (updated && !updated.running) {
          try { await accountStore.startAccount(String(updated.id)) } catch { /* ignore */ }
        }

        return {
          ok: true,
          accountId: updated ? String(updated.id) : (existing ? String(existing.id) : undefined),
          started: updated ? !!updated.running : false,
        }
      }
      catch (e: any) {
        return { ok: false, error: e?.response?.data?.error || e?.message || '保存账号失败' }
      }
    }
    finally {
      processingOpenIds.delete(openid)
    }
  }

  return {
    config,
    loading,
    fetchingCode,
    loadConfig,
    saveConfig,
    fetchCode,
    reloginAccount,
  }
})
