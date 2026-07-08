export {};

export type PlantingStrategy =
  | 'preferred'
  | 'level'
  | 'max_exp'
  | 'max_fert_exp'
  | 'max_profit'
  | 'max_fert_profit'
  | 'bag_priority';

export type BagSeedFallbackStrategy = Exclude<PlantingStrategy, 'bag_priority'>;

export type FertilizerMode = 'both' | 'normal' | 'organic' | 'smart' | 'none';

export type FertilizerLandType = 'purple-gold' | 'gold' | 'black' | 'red' | 'normal';

export interface AutomationConfig {
  farm: boolean;
  farm_push: boolean;
  land_upgrade: boolean;
  friend: boolean;
  friend_help_exp_limit: boolean;
  friend_help_only_guard_dog: boolean;
  friend_steal: boolean;
  friend_help: boolean;
  friend_bad: boolean;
  friend_auto_accept: boolean;
  friend_auto_accept_min_level: number;
  task: boolean;
  fertilizer_gift: boolean;
  fertilizer_buy_organic: boolean;
  fertilizer_buy_normal: boolean;
  sell: boolean;
  fertilizer: FertilizerMode;
  fertilizer_multi_season: boolean;
  fertilizer_land_types: FertilizerLandType[];
  fertilizer_smart_seconds: number;
  skip_own_weed_bug: boolean;
}

export interface IntervalConfig {
  farm: number;
  farmMin: number;
  farmMax: number;
  helpMin: number;
  helpMax: number;
  stealMin: number;
  stealMax: number;
  [key: string]: number;
}

export interface QuietHoursConfig {
  enabled: boolean;
  start: string;
  end: string;
}

export interface AccountConfig {
  automation: AutomationConfig;
  plantingStrategy: PlantingStrategy;
  preferredSeedId: number;
  intervals: IntervalConfig;
  friendQuietHours: QuietHoursConfig;
  knownFriendGids: number[];
  knownFriendGidSyncCooldownSec: number;
  friendsListCacheTtlSec: number;
  friendBlacklist: number[];
  friendGuardDogGids: number[];
  /** 护主犬帮忙黑名单：开启"只帮护主犬"时，命中的 gid 强制跳过（优先级最高） */
  friendGuardDogBlacklist: number[];
  /** 护主犬帮忙白名单：开启"只帮护主犬"且非空时，只帮白名单中的 gid（覆盖 enterReply 检测） */
  friendGuardDogWhitelist: number[];
  /**
   * "该好友当前未携带护主犬"的检测结果缓存（key 为 gid，value 为 Unix 毫秒时间戳）。
   * TTL 内的命中可以跳过 enterReply，直接跳过帮忙操作。
   * 添加/删除护主犬好友/黑名单/白名单时，相应 gid 的缓存应当被失效。
   */
  friendNoGuardDogAt: Record<number, number>;
  /**
   * friendNoGuardDogAt 缓存的 TTL（秒），默认 1800（30 分钟）。
   * 缓存过期后再次帮忙时需重新 enterReply 检测。
   */
  friendNoGuardDogCacheTtlSec: number;
  plantBlacklist: number[];
  stealDelaySeconds: number;
  plantOrderRandom: boolean;
  plantDelaySeconds: number;
  fertilizerBuyOrganicCount: number;
  fertilizerBuyOrganicThresholdHours: number;
  fertilizerBuyNormalCount: number;
  fertilizerBuyNormalThresholdHours: number;
  fertilizerBuyCheckIntervalMinutes: number;
  bagSeedPriority: number[];
  bagSeedFallbackStrategy: BagSeedFallbackStrategy;
}

export interface OfflineReminder {
  channel: string;
  reloginUrlMode: 'none' | 'qq_link' | 'qr_link';
  endpoint: string;
  token: string;
  title: string;
  msg: string;
  offlineDeleteSec: number;
}

export interface UIConfig {
  theme: 'light' | 'dark';
}

export interface DeviceInfo {
  os: string;
  clientVersion: string;
  sysSoftware: string;
  network: string;
  memory: string;
  deviceId: string;
  userAgent: string;
}

export interface SystemConfig {
  serverUrl: string;
  clientVersion: string;
  platform: string;
  os: string;
  deviceInfo: DeviceInfo;
  // 容器/服务启动时是否自动恢复之前在跑的账号
  // - true: 按账号的 autoStart 标记恢复(默认)
  // - false: 一律不自动启动(账号的 autoStart 标记失效)
  autoResumeEnabled?: boolean;
}

export interface DeletedFriendRecord {
  gid: number;
  name: string;
  avatarUrl: string;
  // 检测到被删时的 Unix 毫秒时间戳
  deletedAt: number;
}

export interface FriendSnapshotItem {
  gid: number;
  name: string;
  avatarUrl: string;
}

export interface Announcement {
  content: string;
  showOnce: boolean;
  updatedAt: number;
}

export interface YybOpenIdEntry {
  // 应用宝 OpenID(每个账号独立,来自应用宝一键登录服务)
  openid: string;
  // 该 openid 对应的 API Token(不同 openid 可能来自不同外部 API 账号,token 不通用)
  apiToken: string;
  // 备注名(可选,登录时默认用 openid 末 6 位)
  name?: string;
}

export interface YybConfig {
  enabled: boolean;
  // 接口地址(公共,所有 openid 共享)
  endpoint: string;
  reconnectIntervalMinutes: number;
  autoReconnect: boolean;
  // openid 列表,每个 openid 带自己的 token
  accounts: YybOpenIdEntry[];
}

export interface GoConfig {
  enabled: boolean;
  // Go 服务地址(管理员/用户在「Go 服务配置」中设置,与 wxlogin apiBase 分开)
  // 例如: http://192.168.1.10:8000
  apiBase: string;
  // 微信小程序 AppID(默认 wx5306c5978fdb76e4)
  appId: string;
  // 代理模式(走 /api/proxy)时使用的 API Key
  apiKey?: string;
  // 代理模式时上游 API 的完整 URL(覆盖 apiBase)
  proxyApiUrl?: string;
}

export interface GlobalConfig {
  accountConfigs: Record<string, AccountConfig>;
  defaultAccountConfig: AccountConfig;
  ui: UIConfig;
  offlineReminder: OfflineReminder;
  userOfflineReminders: Record<string, OfflineReminder>;
  userYybConfigs: Record<string, YybConfig>;
  userGoConfigs: Record<string, GoConfig>;
  adminPasswordHash: string;
  announcement: Announcement;
  announcementReadRecords: Record<string, number>;
  systemConfig: SystemConfig | null;
  // 被好友删除记录（key 为 accountId），按 deletedAt 倒序
  friendDeletedRecords?: Record<string, DeletedFriendRecord[]>;
  // 好友列表快照（key 为 accountId），用于下次对比发现"被删好友"
  friendListSnapshot?: Record<string, FriendSnapshotItem[]>;
}
