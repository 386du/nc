import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export interface BlacklistItem {
  gid: number
  name: string
  avatarUrl: string
}

export interface KnownFriendSettings {
  knownFriendGids: number[]
  knownFriendGidSyncCooldownSec: number
  friendsListCacheTtlSec: number
}

export const useFriendStore = defineStore('friend', () => {
  const friends = ref<any[]>([])
  const loading = ref(false)
  const friendLands = ref<Record<string, any[]>>({})
  const friendLandsLoading = ref<Record<string, boolean>>({})
  const blacklist = ref<BlacklistItem[]>([])
  // 护主犬帮忙黑/白名单
  const guardDogBlacklist = ref<BlacklistItem[]>([])
  const guardDogWhitelist = ref<BlacklistItem[]>([])
  const interactRecords = ref<any[]>([])
  const interactLoading = ref(false)
  const interactError = ref('')

  const knownFriendGids = ref<number[]>([])
  const knownFriendGidSyncCooldownSec = ref(600)
  const friendsListCacheTtlSec = ref(60)
  const knownFriendSettingsLoading = ref(false)
  const knownFriendSettingsSaving = ref(false)

  // 护主犬扫描相关
  const guardDogGids = ref<BlacklistItem[]>([])
  const guardDogScanInProgress = ref(false)
  const guardDogScanProgress = ref<any>(null)
  const guardDogScanCacheStats = ref<any>(null)
  const guardDogScanError = ref('')

  function buildPlantSummaryFromDetail(lands: any[], summary: any) {
    let stealNum = 0
    let dryNum = 0
    let weedNum = 0
    let insectNum = 0

    const detailLands = Array.isArray(lands) ? lands : []
    if (detailLands.length > 0) {
      for (const land of detailLands) {
        if (!land || !land.unlocked)
          continue
        if (land.status === 'stealable')
          stealNum++
        if (land.needWater)
          dryNum++
        if (land.needWeed)
          weedNum++
        if (land.needBug)
          insectNum++
      }
    }
    else {
      stealNum = Array.isArray(summary?.stealable) ? summary.stealable.length : 0
      dryNum = Array.isArray(summary?.needWater) ? summary.needWater.length : 0
      weedNum = Array.isArray(summary?.needWeed) ? summary.needWeed.length : 0
      insectNum = Array.isArray(summary?.needBug) ? summary.needBug.length : 0
    }

    return {
      stealNum: Number(stealNum) || 0,
      dryNum: Number(dryNum) || 0,
      weedNum: Number(weedNum) || 0,
      insectNum: Number(insectNum) || 0,
    }
  }

  function syncFriendPlantSummary(friendId: string, lands: any[], summary: any) {
    const key = String(friendId)
    const idx = friends.value.findIndex(f => String(f?.gid || '') === key)
    if (idx < 0)
      return

    const nextPlant = buildPlantSummaryFromDetail(lands, summary)
    friends.value[idx] = {
      ...friends.value[idx],
      plant: nextPlant,
    }
  }

  async function fetchFriends(accountId: string, forceSync = false) {
    if (!accountId)
      return
    loading.value = true
    try {
      const res = await api.get('/api/friends', {
        headers: { 'x-account-id': accountId },
        params: forceSync ? { forceSync: 'true' } : {},
      })
      if (res.data.ok) {
        friends.value = res.data.data || []
      }
    }
    finally {
      loading.value = false
    }
  }
  async function fetchInteractRecords(accountId: string) {
    if (!accountId)
      return
    interactLoading.value = true
    interactError.value = ''
    interactRecords.value = []

    try {
      const res = await api.get('/api/interact-records', {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        interactRecords.value = Array.isArray(res.data.data) ? res.data.data : []
      }
      else {
        interactError.value = res.data.error || '加载访客记录失败'
      }
    }
    catch (error: any) {
      interactError.value = error?.response?.data?.error || error?.message || '加载访客记录失败'
    }
    finally {
      interactLoading.value = false
    }
  }

  async function fetchBlacklist(accountId: string) {
    if (!accountId)
      return
    try {
      const res = await api.get('/api/friend-blacklist', {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        blacklist.value = res.data.data || []
      }
    }
    catch { /* ignore */ }
  }

  async function toggleBlacklist(accountId: string, gid: number) {
    if (!accountId || !gid)
      return
    const res = await api.post('/api/friend-blacklist/toggle', { gid }, {
      headers: { 'x-account-id': accountId },
    })
    if (res.data.ok) {
      blacklist.value = res.data.data || []
    }
  }

  async function fetchGuardDogBlacklist(accountId: string) {
    if (!accountId)
      return
    try {
      const res = await api.get('/api/friend-guard-dog-blacklist', {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        guardDogBlacklist.value = res.data.data || []
      }
    }
    catch { /* ignore */ }
  }

  async function toggleGuardDogBlacklist(accountId: string, gid: number) {
    if (!accountId || !gid)
      return
    const res = await api.post('/api/friend-guard-dog-blacklist/toggle', { gid }, {
      headers: { 'x-account-id': accountId },
    })
    if (res.data.ok) {
      guardDogBlacklist.value = res.data.data || []
    }
  }

  async function fetchGuardDogWhitelist(accountId: string) {
    if (!accountId)
      return
    try {
      const res = await api.get('/api/friend-guard-dog-whitelist', {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        guardDogWhitelist.value = res.data.data || []
      }
    }
    catch { /* ignore */ }
  }

  async function toggleGuardDogWhitelist(accountId: string, gid: number) {
    if (!accountId || !gid)
      return
    const res = await api.post('/api/friend-guard-dog-whitelist/toggle', { gid }, {
      headers: { 'x-account-id': accountId },
    })
    if (res.data.ok) {
      guardDogWhitelist.value = res.data.data || []
    }
  }

  async function setGuardDogWhitelist(accountId: string, gids: number[]) {
    if (!accountId)
      return
    const res = await api.post('/api/friend-guard-dog-whitelist/set', { gids }, {
      headers: { 'x-account-id': accountId },
    })
    if (res.data.ok) {
      guardDogWhitelist.value = res.data.data || []
    }
  }

  // ============ 护主犬扫描 ============
  async function fetchGuardDogGids(accountId: string) {
    if (!accountId)
      return
    try {
      const res = await api.get('/api/friend-guard-dog-gids', {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        guardDogGids.value = res.data.data || []
        guardDogScanCacheStats.value = res.data.cacheStats || null
      }
    }
    catch { /* ignore */ }
  }

  async function startGuardDogScan(accountId: string, options: { concurrency?: number; minIntervalMs?: number; maxIntervalMs?: number } = {}) {
    if (!accountId)
      return { ok: false, reason: 'invalid_account' }
    guardDogScanError.value = ''
    guardDogScanInProgress.value = true
    try {
      const res = await api.post('/api/friend-guard-dog-gids/scan', options, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data && res.data.ok) {
        // 后台跑:成功提交后不立即 await,刷新列表即可
        guardDogScanProgress.value = res.data.result || guardDogScanProgress.value
        return res.data
      }
      guardDogScanError.value = (res.data && res.data.reason) || 'scan_failed'
      return res.data || { ok: false, reason: 'scan_failed' }
    }
    catch (e: any) {
      guardDogScanError.value = e?.response?.data?.error || e?.message || 'scan_failed'
      return { ok: false, reason: guardDogScanError.value }
    }
    finally {
      guardDogScanInProgress.value = false
    }
  }

  async function fetchGuardDogScanStatus(accountId: string) {
    if (!accountId)
      return null
    try {
      const res = await api.get('/api/friend-guard-dog-gids/scan-status', {
        headers: { 'x-account-id': accountId },
      })
      if (res.data && res.data.ok) {
        guardDogScanInProgress.value = !!res.data.inProgress
        guardDogScanProgress.value = res.data.status || null
        return res.data
      }
      return null
    }
    catch { return null }
  }

  async function clearGuardDogScanStatus(accountId: string) {
    if (!accountId)
      return
    try {
      await api.post('/api/friend-guard-dog-gids/clear', {}, {
        headers: { 'x-account-id': accountId },
      })
      guardDogScanInProgress.value = false
      guardDogScanProgress.value = null
    }
    catch { /* ignore */ }
  }

  async function invalidateGuardDogNoCache(accountId: string) {
    if (!accountId)
      return 0
    try {
      const res = await api.post('/api/friend-guard-dog-gids/invalidate-cache', {}, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data && res.data.ok) {
        return res.data.cleared || 0
      }
    }
    catch { /* ignore */ }
    return 0
  }

  async function fetchFriendLands(accountId: string, friendId: string) {
    if (!accountId || !friendId)
      return
    friendLandsLoading.value[friendId] = true
    try {
      const res = await api.get(`/api/friend/${friendId}/lands`, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        const lands = res.data.data.lands || []
        const summary = res.data.data.summary || null
        friendLands.value[friendId] = lands
        syncFriendPlantSummary(friendId, lands, summary)
      }
    }
    finally {
      friendLandsLoading.value[friendId] = false
    }
  }

  async function operate(accountId: string, friendId: string, opType: string) {
    if (!accountId || !friendId)
      return { ok: false, message: '参数无效' }
    try {
      const res = await api.post(`/api/friend/${friendId}/op`, { opType }, {
        headers: { 'x-account-id': accountId },
      })
      const result = res.data?.data || res.data || {}
      await fetchFriends(accountId)
      if (friendLands.value[friendId]) {
        await fetchFriendLands(accountId, friendId)
      }
      return result
    }
    catch (e: any) {
      return { ok: false, message: e?.response?.data?.error || e?.message || '操作失败' }
    }
  }

  function applyKnownFriendSettings(data: KnownFriendSettings | null | undefined) {
    if (!data)
      return
    knownFriendGids.value = Array.isArray(data.knownFriendGids) ? data.knownFriendGids : []
    knownFriendGidSyncCooldownSec.value = Number.isFinite(data.knownFriendGidSyncCooldownSec)
      ? Math.max(30, Math.min(86400, data.knownFriendGidSyncCooldownSec))
      : 600
    friendsListCacheTtlSec.value = Number.isFinite(data.friendsListCacheTtlSec)
      ? Math.max(10, Math.min(86400, data.friendsListCacheTtlSec))
      : 60
  }

  async function fetchKnownFriendSettings(accountId: string) {
    if (!accountId)
      return
    knownFriendSettingsLoading.value = true
    try {
      const res = await api.get('/api/friend-known-gids', {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
    }
    finally {
      knownFriendSettingsLoading.value = false
    }
  }

  async function saveKnownFriendSettings(accountId: string, payload: Partial<KnownFriendSettings>) {
    if (!accountId)
      return
    knownFriendSettingsSaving.value = true
    try {
      const res = await api.post('/api/friend-known-gids', payload, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
    }
    finally {
      knownFriendSettingsSaving.value = false
    }
  }

  async function removeKnownFriendGid(accountId: string, gid: number) {
    if (!accountId || !gid)
      return
    knownFriendSettingsSaving.value = true
    try {
      const res = await api.post('/api/friend-known-gids/remove', { gid }, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
    }
    finally {
      knownFriendSettingsSaving.value = false
    }
  }

  async function batchAddKnownFriendGids(accountId: string, gids: number[]) {
    if (!accountId || !gids || gids.length === 0)
      return { ok: false, addedCount: 0 }
    knownFriendSettingsSaving.value = true
    try {
      const res = await api.post('/api/friend-known-gids/batch-add', { gids }, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
      return { ok: res.data.ok, addedCount: res.data.addedCount || 0 }
    }
    finally {
      knownFriendSettingsSaving.value = false
    }
  }

  async function removeUnsyncedKnownFriendGids(accountId: string, gids: number[]) {
    if (!accountId || !gids || gids.length === 0)
      return { ok: false, removedCount: 0 }
    knownFriendSettingsSaving.value = true
    try {
      const res = await api.post('/api/friend-known-gids/batch-remove', { gids }, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
      return { ok: res.data.ok, removedCount: res.data.removedCount || 0 }
    }
    finally {
      knownFriendSettingsSaving.value = false
    }
  }

  return {
    friends,
    loading,
    friendLands,
    friendLandsLoading,
    blacklist,
    guardDogBlacklist,
    guardDogWhitelist,
    guardDogGids,
    guardDogScanInProgress,
    guardDogScanProgress,
    guardDogScanCacheStats,
    guardDogScanError,
    interactRecords,
    interactLoading,
    interactError,
    knownFriendGids,
    knownFriendGidSyncCooldownSec,
    friendsListCacheTtlSec,
    knownFriendSettingsLoading,
    knownFriendSettingsSaving,
    fetchFriends,
    fetchBlacklist,
    toggleBlacklist,
    fetchGuardDogBlacklist,
    toggleGuardDogBlacklist,
    fetchGuardDogWhitelist,
    toggleGuardDogWhitelist,
    setGuardDogWhitelist,
    fetchGuardDogGids,
    startGuardDogScan,
    fetchGuardDogScanStatus,
    clearGuardDogScanStatus,
    invalidateGuardDogNoCache,
    fetchInteractRecords,
    fetchFriendLands,
    operate,
    fetchKnownFriendSettings,
    saveKnownFriendSettings,
    removeKnownFriendGid,
    batchAddKnownFriendGids,
    removeUnsyncedKnownFriendGids,
  }
})
