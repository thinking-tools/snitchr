// ── Event severity levels ────────────────────────────────────────────────

/** Numeric severity levels used by agent ingest. */
export const EventLevel = {
  /** System metrics heartbeat (CPU, mem, disk, etc.) */
  HEARTBEAT: 0,
  /** Informational event */
  INFO: 1,
  /** Security or anomaly warning (ssh_login, new_port, cpu_spike, etc.) */
  WARN: 2,
  /** Critical change (file_change, crontab_change) */
  ERROR: 3,
  /** Critical system event */
  CRITICAL: 4,
  /** Graceful agent shutdown — server marks machine offline immediately */
  SHUTDOWN: 5,
} as const;

export type EventLevel = (typeof EventLevel)[keyof typeof EventLevel];

/** Human-readable label per level. */
export const EVENT_LEVEL_LABEL: Record<EventLevel, string> = {
  [EventLevel.HEARTBEAT]: 'HEARTBEAT',
  [EventLevel.INFO]: 'INFO',
  [EventLevel.WARN]: 'WARN',
  [EventLevel.ERROR]: 'ERROR',
  [EventLevel.CRITICAL]: 'CRITICAL',
  [EventLevel.SHUTDOWN]: 'SHUTDOWN',
};

// ── Payload data shapes ─────────────────────────────────────────────────

/** Detailed listening port info (snapshot). */
export type PortInfo = { port: number; addr: string; proc: string };

/** Mounted filesystem info (snapshot). */
export type MountInfo = { src: string; target: string; fs: string };

/** Active TTY session info (snapshot). */
export type TtyInfo = { user: string; tty: string; from: string; login: number };

/** Disk usage sample for velocity prediction: [timestamp_ms, percentage]. */
export type DiskSample = [ts: number, pct: number];

/** Heartbeat metrics collected by the agent (t=0). */
export type HeartbeatData = {
  ts: number;
  up: number;
  cpu: number;
  mem: [used: number, total: number];
  disk: number[];
  load: [m1: number, m5: number, m15: number];
  procs: number;
  net: [rx: number, tx: number];
  ports: string;
  users: string;
  /** Pipe-delimited unique process names — sent only on change. */
  procList?: string;
  /** Detailed listening ports — sent only on change. */
  portList?: PortInfo[];
  /** Mounted filesystems — sent only on change. */
  mountList?: MountInfo[];
  /** Active TTY sessions — sent only on change. */
  ttyList?: TtyInfo[];
};

/** Subtypes of alert events emitted by the agent. */
export type EventType =
  | 'ssh_login' | 'ssh_fail' | 'sudo' | 'su' | 'auth_fail'
  | 'new_process' | 'new_port' | 'mount_change'
  | 'cpu_spike' | 'mem_spike' | 'disk_high'
  | 'file_change' | 'crontab_change'
  | 'shutdown';

/** Alert / event payload (t > 0). */
export type AlertData = {
  type: EventType;
  msg: string;
  unit?: string;
};

// ── Stored structures ───────────────────────────────────────────────────

/** Single log / alert entry persisted in R2/S3. */
export type EventEntry = {
  t: EventLevel;
  ts: number;
  d: HeartbeatData | AlertData;
};

/**
 * Machine status stored as `m/{id}/status.json`.
 * Only heartbeats (t=0) update `d`; alerts update `lastSeen` without overwriting metrics.
 */
export type MachineStatus = {
  lastSeen: number;
  d?: HeartbeatData;
  diskSamples?: DiskSample[];
};

// ── Config & bindings ───────────────────────────────────────────────────

export type MachineEntry = {
  secret: string;
  label?: string;
  registeredAt: number;
  notifiedDownAt?: number;
  diskFillNotifiedAt?: number;
  lat?: number;
  lng?: number;
  city?: string;
  country?: string;
};

export type StorageMode = 'r2' | 's3' | 'memory' | 'filesystem';

/** Per-feature toggles — all default to true when absent. */
export type AgentFeatures = {
  authWatch?: boolean;
  fileIntegrity?: boolean;
  processWatch?: boolean;
  portWatch?: boolean;
  mountWatch?: boolean;
  cpuAlerts?: boolean;
  memAlerts?: boolean;
  diskAlerts?: boolean;
};

/** Maps alert event types to their controlling feature flag. */
export const EVENT_FEATURE_MAP: Record<string, keyof AgentFeatures> = {
  ssh_login: 'authWatch',
  ssh_fail: 'authWatch',
  sudo: 'authWatch',
  su: 'authWatch',
  auth_fail: 'authWatch',
  file_change: 'fileIntegrity',
  crontab_change: 'fileIntegrity',
  new_process: 'processWatch',
  new_port: 'portWatch',
  mount_change: 'mountWatch',
  cpu_spike: 'cpuAlerts',
  mem_spike: 'memAlerts',
  disk_high: 'diskAlerts',
};

export const AGENT_FEATURES_DEFAULT: Required<AgentFeatures> = {
  authWatch: true,
  fileIntegrity: true,
  processWatch: true,
  portWatch: true,
  mountWatch: true,
  cpuAlerts: true,
  memAlerts: true,
  diskAlerts: true,
};

// ── Notification channel configs ────────────────────────────────────────

export type NtfyChannel = { type: 'ntfy'; endpoint: string; enabled: boolean };
export type WebhookChannel = { type: 'webhook'; url: string; secret?: string; enabled: boolean };
export type SlackChannel = { type: 'slack'; webhookUrl: string; enabled: boolean };
export type WebPushChannel = { type: 'webpush'; enabled: boolean };

export type NotificationChannelConfig = NtfyChannel | WebhookChannel | SlackChannel | WebPushChannel;

export type NotificationPriority = 'urgent' | 'high' | 'default' | 'low';

export type NotificationPayload = {
  event: 'alert' | 'recovery' | 'down' | 'test';
  title: string;
  body: string;
  priority: NotificationPriority;
  tags?: string;
  level: EventLevel;
  machineId?: string;
  machineLabel?: string;
};

export type Config = {
  passwordHash: string;
  passwordSalt: string;
  storageMode: StorageMode;
  userId: string;
  machineList: Record<string, MachineEntry>;
  alertThreshold?: number;
  heartbeatTimeout?: number;
  pendingToken?: string;
  pendingTokenDisplay?: string;
  ntfyEndpoint?: string;
  notifications?: Record<string, NotificationChannelConfig>;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  agentFeatures?: AgentFeatures;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  s3Region?: string;
  dataDir?: string;
};

import type { KVStore } from './kv';
import type { AssetServer } from './assets';

/** Cloudflare request geolocation properties — local type to avoid @cloudflare/workers-types dependency. */
export type CfGeoProperties = {
  latitude?: string;
  longitude?: string;
  city?: string;
  country?: string;
};

/** Minimal R2-like bucket interface — avoids coupling to @cloudflare/workers-types. */
export interface R2BucketLike {
  get(key: string): Promise<{ text(): Promise<string>; json<T>(): Promise<T> } | null>;
  put(key: string, data: string | ArrayBufferView | ArrayBuffer | ReadableStream): Promise<unknown>;
  list(opts: {
    prefix?: string;
    limit?: number;
    cursor?: string;
    delimiter?: string;
  }): Promise<{
    objects: Array<{ key: string; size: number; uploaded: Date }>;
    truncated: boolean;
    cursor: string;
  }>;
  delete(key: string | string[]): Promise<void>;
}

export type Bindings = {
  SNITCHR_CONFIG: KVStore;
  SNITCHR_STORAGE?: R2BucketLike;
  ASSETS: AssetServer;
  DATA_DIR?: string;
  VAPID_CONTACT?: string;
};
