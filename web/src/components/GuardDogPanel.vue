<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { useAccountStore } from '@/stores/account'
import { useFriendStore } from '@/stores/friend'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const friendStore = useFriendStore()
const toast = useToastStore()

const { currentAccountId } = storeToRefs(accountStore)
const { friends, blacklist, guardDogBlacklist, guardDogWhitelist, loading } = storeToRefs(friendStore)

const activeTab = ref<'blacklist' | 'whitelist'>('blacklist')
const newGid = ref('')
const newGidName = ref('')
const saving = ref(false)

const friendMap = computed(() => {
    const m = new Map<number, { name: string; avatarUrl: string }>()
    for (const f of (friends.value || [])) {
        const gid = Number(f.gid)
        if (gid > 0) m.set(gid, { name: f.name || f.remark || '', avatarUrl: f.avatarUrl || f.avatar_url || '' })
    }
    return m
})

const blacklistSet = computed(() => new Set(blacklist.value.map(b => Number(b.gid))))
const guardDogBlackSet = computed(() => new Set(guardDogBlacklist.value.map(b => Number(b.gid))))
const guardDogWhiteSet = computed(() => new Set(guardDogWhitelist.value.map(w => Number(w.gid))))

const visibleFriends = computed(() => {
    const list = friends.value || []
    if (activeTab.value === 'blacklist') {
        // 显示可在护主犬黑名单中添加的：不在好友黑名单里的
        return list.filter(f => !blacklistSet.value.has(Number(f.gid)))
    }
    return list
})

async function load() {
    if (!currentAccountId.value) return
    await Promise.all([
        friendStore.fetchFriends(currentAccountId.value),
        friendStore.fetchGuardDogBlacklist(currentAccountId.value),
        friendStore.fetchGuardDogWhitelist(currentAccountId.value),
    ])
}

watch(() => currentAccountId.value, () => { load() }, { immediate: true })

async function toggleBlack(gid: number) {
    if (!currentAccountId.value) return
    await friendStore.toggleGuardDogBlacklist(currentAccountId.value, gid)
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
    else {
        if (guardDogWhiteSet.value.has(gid)) {
            toast.info('已在护主犬白名单中')
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
    else {
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
</script>

<template>
    <div class="guard-dog-panel">
        <div class="panel-header">
            <div class="tab-bar">
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
                <BaseButton size="sm" variant="danger" @click="clearAll">清空</BaseButton>
            </div>
        </div>

        <div class="hint">
            <span v-if="activeTab === 'blacklist'">
                黑名单中的好友<strong>不会被帮忙/偷菜</strong>，无论白名单是否为空。
            </span>
            <span v-else>
                当白名单非空时，<strong>只帮白名单中的好友</strong>；
                当白名单为空时，帮所有不在黑名单里的好友。
            </span>
        </div>

        <div class="add-by-gid">
            <BaseInput v-model="newGid" type="number" placeholder="好友 GID" />
            <BaseInput v-model="newGidName" placeholder="备注名（可选）" />
            <BaseButton @click="addByGid">添加</BaseButton>
        </div>

        <div v-if="activeTab === 'blacklist'" class="current-list">
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
            <div v-if="guardDogWhitelist.length === 0" class="empty">白名单为空时，帮所有不在黑名单里的好友</div>
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

        <div class="quick-add">
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
                        variant="warning"
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
</style>
