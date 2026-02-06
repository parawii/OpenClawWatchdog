/**
 * OpenClaw Watchdog - Notification System
 * 
 * Sends alerts to Telegram when recovery actions occur.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { NotificationConfig, Action, WatchdogReport } from './types.js';
import { logger } from './logger.js';

const execAsync = promisify(exec);

export interface NotificationPayload {
  title: string;
  body: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  actions?: Action[];
}

export class Notifier {
  private config: NotificationConfig;
  private dryRun: boolean;
  private lastNotificationAt: number | null = null;
  private notificationCooldownMs = 60000; // 1 minute between notifications

  constructor(config: NotificationConfig, dryRun: boolean) {
    this.config = config;
    this.dryRun = dryRun;
  }

  /**
   * Check if notification should be sent (respects cooldown)
   */
  private canNotify(): boolean {
    if (!this.config.enabled) return false;
    
    if (this.lastNotificationAt) {
      const elapsed = Date.now() - this.lastNotificationAt;
      if (elapsed < this.notificationCooldownMs) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Format action for notification
   */
  private formatAction(action: Action): string {
    const emoji = {
      restart: '🔄',
      model_switch: '🔀',
      notification: '📢',
      report: '📊',
      config_rollback: '⏪',
    }[action.type] || '⚙️';

    const status = {
      success: '✅',
      failed: '❌',
      skipped: '⏭️',
    }[action.result || 'skipped'];

    return `${emoji} ${action.description} ${status}`;
  }

  /**
   * Build notification message
   */
  private buildMessage(payload: NotificationPayload): string {
    const priorityEmoji = {
      low: '📋',
      medium: '⚠️',
      high: '🔴',
      critical: '🚨',
    }[payload.priority];

    let message = `${priorityEmoji} **${payload.title}**\n\n${payload.body}`;

    if (payload.actions && payload.actions.length > 0) {
      message += '\n\n**Actions Taken:**\n';
      for (const action of payload.actions) {
        message += `• ${this.formatAction(action)}\n`;
      }
    }

    message += `\n_${new Date().toISOString()}_`;
    
    return message;
  }

  /**
   * Send notification via OpenClaw message tool
   */
  async send(payload: NotificationPayload): Promise<boolean> {
    if (!this.canNotify()) {
      logger.debug('Notification skipped (cooldown or disabled)');
      return false;
    }

    const message = this.buildMessage(payload);

    if (this.dryRun) {
      logger.info('[DRY-RUN] Would send notification', { 
        title: payload.title,
        channel: this.config.channel,
        target: this.config.target,
      });
      return true;
    }

    try {
      // Use openclaw CLI to send message
      const escapedMessage = message.replace(/'/g, "'\\''");
      
      let cmd = `openclaw message send --channel "${this.config.channel}" --target "${this.config.target}"`;
      
      // For Telegram forum topics, use --thread-id
      if (this.config.topic) {
        cmd += ` --thread-id "${this.config.topic}"`;
      }
      
      cmd += ` --message '${escapedMessage}'`;

      await execAsync(cmd, { 
        timeout: 30000,
        env: { ...process.env, NO_COLOR: '1' },
      });

      this.lastNotificationAt = Date.now();
      logger.info('Notification sent', { title: payload.title });
      return true;

    } catch (error) {
      logger.error('Failed to send notification', { error: (error as Error).message });
      return false;
    }
  }

  /**
   * Send alert for recovery actions
   */
  async sendRecoveryAlert(actions: Action[]): Promise<boolean> {
    if (actions.length === 0) return false;

    // Filter to only meaningful actions (not skipped)
    const meaningfulActions = actions.filter(a => a.result !== 'skipped');
    if (meaningfulActions.length === 0) return false;

    // Determine priority based on actions
    let priority: 'low' | 'medium' | 'high' | 'critical' = 'medium';
    const hasFailure = actions.some(a => a.result === 'failed');
    const hasRestart = actions.some(a => a.type === 'restart');
    const hasConfigRollback = actions.some(a => a.type === 'config_rollback' as any);

    if (hasFailure) priority = 'high';
    if (hasRestart || hasConfigRollback) priority = 'high';
    if (hasFailure && (hasRestart || hasConfigRollback)) priority = 'critical';

    const title = hasRestart 
      ? 'Gateway Recovery' 
      : hasConfigRollback 
        ? 'Config Rollback' 
        : 'Model Switch';

    const body = this.summarizeActions(actions);

    return this.send({
      title,
      body,
      priority,
      actions: meaningfulActions,
    });
  }

  /**
   * Summarize actions for notification body
   */
  private summarizeActions(actions: Action[]): string {
    const restarts = actions.filter(a => a.type === 'restart');
    const switches = actions.filter(a => a.type === 'model_switch');
    const rollbacks = actions.filter(a => (a.type as any) === 'config_rollback');

    const parts: string[] = [];

    if (restarts.length > 0) {
      const success = restarts.filter(a => a.result === 'success').length;
      parts.push(`Gateway restart: ${success}/${restarts.length} successful`);
    }

    if (switches.length > 0) {
      const success = switches.filter(a => a.result === 'success').length;
      parts.push(`Model switches: ${success}/${switches.length} successful`);
    }

    if (rollbacks.length > 0) {
      const success = rollbacks.filter(a => a.result === 'success').length;
      parts.push(`Config rollback: ${success}/${rollbacks.length} successful`);
    }

    return parts.join('\n') || 'Recovery actions performed';
  }

  /**
   * Send status report notification
   */
  async sendStatusReport(report: WatchdogReport): Promise<boolean> {
    const statusEmoji = {
      healthy: '✅',
      degraded: '⚠️',
      unhealthy: '🔴',
      critical: '🚨',
    }[report.status];

    const priority = {
      healthy: 'low',
      degraded: 'medium',
      unhealthy: 'high',
      critical: 'critical',
    }[report.status] as 'low' | 'medium' | 'high' | 'critical';

    // Only send for non-healthy status
    if (report.status === 'healthy') {
      return false;
    }

    const body = `Status: ${statusEmoji} ${report.status.toUpperCase()}\n` +
      `Errors: ${report.logAnalysis.errors.length}\n` +
      `Failed models: ${report.modelStatus.failedModels.length}\n` +
      `Recommendations: ${report.recommendations.length}`;

    return this.send({
      title: 'Watchdog Status Alert',
      body,
      priority,
    });
  }

  /**
   * Send test notification
   */
  async sendTest(): Promise<boolean> {
    return this.send({
      title: 'Watchdog Test',
      body: 'This is a test notification from OpenClaw Watchdog.',
      priority: 'low',
    });
  }
}
