/**
 * OpenClaw Watchdog - Type Definitions
 */

export interface WatchdogConfig {
  version: string;
  monitor: MonitorConfig;
  gateway: GatewayConfig;
  dryRun: boolean;
  models: ModelConfig;
  recovery: RecoveryConfig;
  notifications: NotificationConfig;
  logging: LoggingConfig;
}

export interface MonitorConfig {
  enabled: boolean;
  intervalMs: number;
  healthTimeoutMs: number;
  logFile: string;
  reportsDir: string;
}

export interface GatewayConfig {
  url: string;
  token: string | null;
  healthEndpoint: boolean;
}

export interface ModelConfig {
  quotaCheckEnabled: boolean;
  quotaRecoveryCheckIntervalMs: number;
  autoSwitch: boolean;
  sessionRules: Record<string, SessionRule>;
}

export interface SessionRule {
  allowedModels: string[];
  fallbackOrder: string[];
}

export interface RecoveryConfig {
  enabled: boolean;
  maxRestartAttempts: number;
  restartCooldownMs: number;
  strategies: RecoveryStrategy[];
}

export type RecoveryStrategy = 'restart_gateway' | 'switch_model' | 'notify_only';

export interface NotificationConfig {
  enabled: boolean;
  channel: string;
  target: string;
  topic?: string;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  file: string;
}

// Health Check Types
export interface HealthStatus {
  ok: boolean;
  ts: number;
  durationMs: number;
  channels: Record<string, ChannelHealth>;
  gateway?: GatewayHealth;
  error?: string;
}

export interface ChannelHealth {
  configured: boolean;
  running: boolean;
  probe?: {
    ok: boolean;
    error?: string;
  };
}

export interface GatewayHealth {
  uptime?: number;
  version?: string;
}

// Log Analysis Types
export interface LogEntry {
  ts: number;
  level: string;
  subsystem?: string;
  message: string;
  error?: string;
  details?: Record<string, unknown>;
}

export interface LogAnalysis {
  errors: AnalyzedError[];
  warnings: string[];
  modelErrors: ModelError[];
  recommendations: string[];
}

export interface AnalyzedError {
  ts: number;
  message: string;
  category: ErrorCategory;
  severity: 'low' | 'medium' | 'high' | 'critical';
  context?: Record<string, unknown>;
}

export type ErrorCategory = 
  | 'model_quota'
  | 'model_unavailable'
  | 'network'
  | 'auth'
  | 'config'
  | 'channel'
  | 'internal'
  | 'unknown';

export interface ModelError {
  ts: number;
  model: string;
  sessionKey?: string;
  errorType: 'quota' | 'rate_limit' | 'unavailable' | 'auth' | 'unknown';
  message: string;
  recoverable: boolean;
}

// Report Types
export interface WatchdogReport {
  generatedAt: number;
  reportId: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'critical';
  summary: string;
  health: HealthStatus | null;
  logAnalysis: LogAnalysis;
  modelStatus: ModelStatus;
  recommendations: Recommendation[];
  actionsPerformed: Action[];
}

export interface ModelStatus {
  failedModels: FailedModel[];
  activeModels: string[];
  quotaRecoveryPending: QuotaRecoveryCheck[];
}

export interface FailedModel {
  model: string;
  failedAt: number;
  reason: string;
  sessions: string[];
}

export interface QuotaRecoveryCheck {
  model: string;
  failedAt: number;
  nextCheckAt: number;
  checkCount: number;
}

export interface Recommendation {
  priority: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  message: string;
  suggestedAction?: string;
}

export interface Action {
  ts: number;
  type: 'restart' | 'model_switch' | 'notification' | 'report';
  description: string;
  dryRun: boolean;
  result?: 'success' | 'failed' | 'skipped';
}

// State Types
export interface WatchdogState {
  startedAt: number;
  lastHealthCheck: number | null;
  lastLogAnalysis: number | null;
  restartAttempts: number;
  lastRestartAt: number | null;
  failedModels: Map<string, FailedModel>;
  quotaRecoveryQueue: QuotaRecoveryCheck[];
}
