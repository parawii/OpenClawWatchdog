/**
 * OpenClaw Watchdog - Report Generator
 * 
 * Generates detailed reports for analysis and recommendations.
 */

import { writeFile, mkdir, readdir, unlink, stat } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type {
  WatchdogReport,
  HealthStatus,
  LogAnalysis,
  ModelStatus,
  Recommendation,
  Action,
  ReportsConfig,
} from './types.js';
import { logger } from './logger.js';

export class ReportGenerator {
  private reportsDir: string;
  private actionsPerformed: Action[] = [];
  private lastStatus: WatchdogReport['status'] | null = null;
  private reportsConfig: ReportsConfig;

  constructor(reportsDir: string, reportsConfig?: ReportsConfig) {
    this.reportsDir = reportsDir;
    this.reportsConfig = reportsConfig || {
      saveOnChangeOnly: true,
      maxReports: 50,
      maxAgeDays: 7,
    };
  }

  /**
   * Generate a full watchdog report
   */
  async generateReport(
    health: HealthStatus | null,
    logAnalysis: LogAnalysis,
    modelStatus: ModelStatus,
    dryRun: boolean = true
  ): Promise<WatchdogReport> {
    const report: WatchdogReport = {
      generatedAt: Date.now(),
      reportId: randomUUID().slice(0, 8),
      status: this.determineStatus(health, logAnalysis, modelStatus),
      summary: '',
      health,
      logAnalysis,
      modelStatus,
      recommendations: this.buildRecommendations(health, logAnalysis, modelStatus),
      actionsPerformed: [...this.actionsPerformed],
    };

    report.summary = this.buildSummary(report);

    // Save report to file (respecting saveOnChangeOnly policy)
    const statusChanged = this.lastStatus !== null && this.lastStatus !== report.status;
    const isFirstReport = this.lastStatus === null;

    if (!this.reportsConfig.saveOnChangeOnly || isFirstReport || statusChanged) {
      await this.saveReport(report);

      if (statusChanged) {
        logger.info('Status changed, report saved', {
          from: this.lastStatus,
          to: report.status,
        });
      }
    } else {
      logger.debug('Status unchanged, skipping report save', { status: report.status });
    }

    // Update last status
    this.lastStatus = report.status;

    // Clear actions after generating report
    this.actionsPerformed = [];

    return report;
  }

  /**
   * Determine overall system status
   */
  private determineStatus(
    health: HealthStatus | null,
    logAnalysis: LogAnalysis,
    modelStatus: ModelStatus
  ): WatchdogReport['status'] {
    // Critical: Gateway unreachable
    if (!health || !health.ok) {
      return 'critical';
    }

    // Critical: Auth errors or multiple critical errors
    const criticalErrors = logAnalysis.errors.filter(e => e.severity === 'critical');
    if (criticalErrors.length > 0) {
      return 'critical';
    }

    // Unhealthy: Multiple high-severity errors or many failed models
    const highErrors = logAnalysis.errors.filter(e => e.severity === 'high');
    if (highErrors.length >= 3 || modelStatus.failedModels.length >= 3) {
      return 'unhealthy';
    }

    // Degraded: Some errors or failed models
    if (logAnalysis.errors.length > 0 || modelStatus.failedModels.length > 0) {
      return 'degraded';
    }

    return 'healthy';
  }

  /**
   * Build recommendations list
   */
  private buildRecommendations(
    health: HealthStatus | null,
    logAnalysis: LogAnalysis,
    modelStatus: ModelStatus
  ): Recommendation[] {
    const recs: Recommendation[] = [];

    // Gateway health recommendations
    if (!health) {
      recs.push({
        priority: 'critical',
        category: 'gateway',
        message: 'Cannot reach Gateway. Process may have crashed.',
        suggestedAction: 'Run: openclaw gateway restart',
      });
    } else if (!health.ok) {
      recs.push({
        priority: 'critical',
        category: 'gateway',
        message: `Gateway health check failed: ${health.error}`,
        suggestedAction: 'Check logs with: openclaw logs --follow',
      });
    }

    // Channel recommendations
    if (health?.channels) {
      for (const [name, channel] of Object.entries(health.channels)) {
        if (channel.configured && !channel.probe?.ok) {
          recs.push({
            priority: 'high',
            category: 'channel',
            message: `Channel ${name} probe failed: ${channel.probe?.error || 'unknown'}`,
            suggestedAction: `Check ${name} configuration`,
          });
        }
      }
    }

    // Model recommendations
    for (const failed of modelStatus.failedModels) {
      if (failed.reason.includes('auth')) {
        recs.push({
          priority: 'critical',
          category: 'model',
          message: `Model ${failed.model} has authentication errors`,
          suggestedAction: 'Check API key in config',
        });
      } else if (failed.reason.includes('quota')) {
        recs.push({
          priority: 'high',
          category: 'model',
          message: `Model ${failed.model} quota exceeded`,
          suggestedAction: 'Switch to fallback model or wait for quota reset',
        });
      }
    }

    // Add log analysis recommendations
    for (const rec of logAnalysis.recommendations) {
      const priority = rec.startsWith('[CRITICAL]') ? 'critical' :
        rec.startsWith('[HIGH]') ? 'high' :
          rec.startsWith('[MEDIUM]') ? 'medium' : 'low';
      const message = rec.replace(/^\[(?:CRITICAL|HIGH|MEDIUM|LOW)\]\s*/, '');

      recs.push({
        priority,
        category: 'logs',
        message,
      });
    }

    // Sort by priority
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    recs.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return recs;
  }

  /**
   * Build human-readable summary
   */
  private buildSummary(report: WatchdogReport): string {
    const lines: string[] = [];

    // Status emoji
    const statusEmoji = {
      healthy: '✅',
      degraded: '⚠️',
      unhealthy: '🔴',
      critical: '🚨',
    };

    lines.push(`${statusEmoji[report.status]} System Status: ${report.status.toUpperCase()}`);
    lines.push('');

    // Quick stats
    lines.push(`📊 Quick Stats:`);
    lines.push(`  - Errors (last 30min): ${report.logAnalysis.errors.length}`);
    lines.push(`  - Model errors: ${report.logAnalysis.modelErrors.length}`);
    lines.push(`  - Failed models: ${report.modelStatus.failedModels.length}`);
    lines.push(`  - Pending recovery checks: ${report.modelStatus.quotaRecoveryPending.length}`);
    lines.push('');

    // Top recommendations
    if (report.recommendations.length > 0) {
      lines.push(`🔧 Top Recommendations:`);
      for (const rec of report.recommendations.slice(0, 3)) {
        lines.push(`  [${rec.priority.toUpperCase()}] ${rec.message}`);
        if (rec.suggestedAction) {
          lines.push(`    → ${rec.suggestedAction}`);
        }
      }
    } else {
      lines.push(`🎉 No issues detected.`);
    }

    return lines.join('\n');
  }

  /**
   * Save report to file
   */
  private async saveReport(report: WatchdogReport): Promise<void> {
    try {
      await mkdir(this.reportsDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `report-${timestamp}-${report.reportId}.json`;
      const filepath = join(this.reportsDir, filename);

      await writeFile(filepath, JSON.stringify(report, null, 2));
      logger.info('Report saved', { filepath, status: report.status });

      // Also save a human-readable version
      const txtFilename = `report-${timestamp}-${report.reportId}.txt`;
      const txtPath = join(this.reportsDir, txtFilename);
      await writeFile(txtPath, this.formatReportText(report));

      // Cleanup old reports
      await this.cleanupOldReports();

    } catch (error) {
      logger.error('Failed to save report', { error: (error as Error).message });
    }
  }

  /**
   * Cleanup old reports based on retention policy
   */
  private async cleanupOldReports(): Promise<void> {
    try {
      const files = await readdir(this.reportsDir);
      const reportFiles = files
        .filter(f => f.startsWith('report-') && (f.endsWith('.json') || f.endsWith('.txt')))
        .sort()  // Sorted by timestamp (ascending)
        .reverse();  // Most recent first

      // Group by report ID (each report has .json + .txt)
      const reportGroups = new Map<string, string[]>();
      for (const file of reportFiles) {
        // Extract base name without extension: report-TIMESTAMP-ID
        const base = file.replace(/\.(json|txt)$/, '');
        const group = reportGroups.get(base) || [];
        group.push(file);
        reportGroups.set(base, group);
      }

      const sortedGroups = Array.from(reportGroups.entries());
      let deletedCount = 0;

      // Remove excess reports (by count)
      if (sortedGroups.length > this.reportsConfig.maxReports) {
        const toRemove = sortedGroups.slice(this.reportsConfig.maxReports);
        for (const [, groupFiles] of toRemove) {
          for (const file of groupFiles) {
            await unlink(join(this.reportsDir, file));
            deletedCount++;
          }
        }
      }

      // Remove old reports (by age)
      const maxAgeMs = this.reportsConfig.maxAgeDays * 24 * 60 * 60 * 1000;
      const cutoffTs = Date.now() - maxAgeMs;

      for (const file of reportFiles) {
        const filePath = join(this.reportsDir, file);
        try {
          const fileStat = await stat(filePath);
          if (fileStat.mtimeMs < cutoffTs) {
            await unlink(filePath);
            deletedCount++;
          }
        } catch {
          // File may have been deleted already
        }
      }

      if (deletedCount > 0) {
        logger.info('Cleaned up old reports', { deletedCount });
      }
    } catch (error) {
      logger.error('Failed to cleanup reports', { error: (error as Error).message });
    }
  }

  /**
   * Format report as human-readable text
   */
  private formatReportText(report: WatchdogReport): string {
    const lines: string[] = [];
    const divider = '═'.repeat(60);

    lines.push(divider);
    lines.push('  OPENCLAW WATCHDOG REPORT');
    lines.push(`  Generated: ${new Date(report.generatedAt).toISOString()}`);
    lines.push(`  Report ID: ${report.reportId}`);
    lines.push(divider);
    lines.push('');
    lines.push(report.summary);
    lines.push('');
    lines.push(divider);
    lines.push('  FAILED MODELS');
    lines.push(divider);

    if (report.modelStatus.failedModels.length === 0) {
      lines.push('  None');
    } else {
      for (const model of report.modelStatus.failedModels) {
        lines.push(`  • ${model.model}`);
        lines.push(`    Failed at: ${new Date(model.failedAt).toISOString()}`);
        lines.push(`    Reason: ${model.reason}`);
        lines.push(`    Affected sessions: ${model.sessions.length}`);
      }
    }

    lines.push('');
    lines.push(divider);
    lines.push('  RECENT ERRORS');
    lines.push(divider);

    if (report.logAnalysis.errors.length === 0) {
      lines.push('  None');
    } else {
      for (const error of report.logAnalysis.errors.slice(0, 10)) {
        lines.push(`  [${error.severity.toUpperCase()}] ${error.category}`);
        lines.push(`    ${new Date(error.ts).toISOString()}`);
        lines.push(`    ${error.message.slice(0, 100)}${error.message.length > 100 ? '...' : ''}`);
        lines.push('');
      }
    }

    lines.push(divider);
    lines.push('  ALL RECOMMENDATIONS');
    lines.push(divider);

    for (const rec of report.recommendations) {
      lines.push(`  [${rec.priority.toUpperCase()}] ${rec.category}`);
      lines.push(`    ${rec.message}`);
      if (rec.suggestedAction) {
        lines.push(`    → ${rec.suggestedAction}`);
      }
      lines.push('');
    }

    lines.push(divider);
    lines.push('  END OF REPORT');
    lines.push(divider);

    return lines.join('\n');
  }

  /**
   * Record an action performed
   */
  recordAction(action: Omit<Action, 'ts'>): void {
    this.actionsPerformed.push({
      ts: Date.now(),
      ...action,
    });
  }

  /**
   * Get latest report summary (for notifications)
   */
  getLatestSummary(report: WatchdogReport): string {
    return report.summary;
  }
}
