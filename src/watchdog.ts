/**
 * OpenClaw Watchdog - Main Entry Point
 * 
 * A monitoring daemon for OpenClaw Gateway.
 * Phase 2: Monitoring + Gateway restart capability
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';

const execAsync = promisify(exec);

import type { WatchdogConfig, WatchdogState, WatchdogReport } from './types.js';
import { logger, Logger } from './logger.js';
import { HealthMonitor } from './health-monitor.js';
import { LogAnalyzer } from './log-analyzer.js';
import { ModelQuotaGuard } from './model-guard.js';
import { ReportGenerator } from './report-generator.js';
import { RecoveryEngine } from './recovery.js';
import { ConfigGuardian } from './config-guardian.js';
import { Notifier } from './notifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Re-export Notifier for CLI use
export { Notifier };

export class Watchdog {
  private config: WatchdogConfig;
  private state: WatchdogState;
  private healthMonitor: HealthMonitor;
  private logAnalyzer: LogAnalyzer;
  private modelGuard: ModelQuotaGuard;
  private reportGenerator: ReportGenerator;
  private recoveryEngine: RecoveryEngine;
  private configGuardian: ConfigGuardian;
  private notifier: Notifier;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private healthyStreak = 0;  // Consecutive healthy checks

  constructor(config: WatchdogConfig) {
    this.config = config;
    this.state = {
      startedAt: Date.now(),
      lastHealthCheck: null,
      lastLogAnalysis: null,
      restartAttempts: 0,
      lastRestartAt: null,
      failedModels: new Map(),
      quotaRecoveryQueue: [],
    };

    // Initialize components
    this.healthMonitor = new HealthMonitor(
      config.gateway,
      config.monitor.healthTimeoutMs
    );
    this.logAnalyzer = new LogAnalyzer(config.monitor.logFile);
    this.modelGuard = new ModelQuotaGuard(config.models);
    this.reportGenerator = new ReportGenerator(config.monitor.reportsDir, config.monitor.reports);
    this.recoveryEngine = new RecoveryEngine(config.recovery, config.dryRun, config.models);
    this.configGuardian = new ConfigGuardian();
    this.notifier = new Notifier(config.notifications, config.dryRun);

    // Configure logger
    logger.setLevel(config.logging.level);
  }

  /**
   * Start the watchdog monitoring loop
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Watchdog already running');
      return;
    }

    logger.info('Starting OpenClaw Watchdog', {
      version: this.config.version,
      dryRun: this.config.dryRun,
      recoveryEnabled: this.config.recovery.enabled,
      intervalMs: this.config.monitor.intervalMs,
    });

    this.running = true;

    // Run initial check
    await this.runMonitoringCycle();

    // Start monitoring loop
    this.intervalHandle = setInterval(
      () => this.runMonitoringCycle(),
      this.config.monitor.intervalMs
    );

    logger.info('Watchdog started successfully');
  }

  /**
   * Stop the watchdog
   */
  stop(): void {
    if (!this.running) return;

    logger.info('Stopping watchdog...');

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    this.running = false;
    logger.info('Watchdog stopped');
  }

  /**
   * Run a single monitoring cycle
   */
  async runMonitoringCycle(): Promise<WatchdogReport> {
    logger.debug('Starting monitoring cycle');

    // 1. Check Gateway health
    const health = await this.healthMonitor.checkHealth();
    this.state.lastHealthCheck = Date.now();

    // 2. Analyze recent logs
    const logAnalysis = await this.logAnalyzer.analyzeRecent(30);
    this.state.lastLogAnalysis = Date.now();

    // 3. Process model errors
    if (logAnalysis.modelErrors.length > 0) {
      this.modelGuard.processModelErrors(logAnalysis.modelErrors);
    }

    // 4. Get model status
    const modelStatus = this.modelGuard.getStatus();

    // 5. Generate report
    const report = await this.reportGenerator.generateReport(
      health,
      logAnalysis,
      modelStatus,
      this.config.dryRun
    );

    // 6. Log status summary
    this.logStatusSummary(report);

    // 7. Track healthy streak for recovery reset + backup config if healthy
    if (report.status === 'healthy') {
      this.healthyStreak++;
      // Reset restart attempts after 5 consecutive healthy checks
      if (this.healthyStreak >= 5) {
        this.recoveryEngine.resetAttempts();
      }

      // Backup config if this version hasn't been backed up yet
      const backupResult = await this.configGuardian.backupIfNeeded();
      if (backupResult.backed) {
        logger.info('Config backed up', { reason: backupResult.reason });
      }
    } else {
      this.healthyStreak = 0;
    }

    // 8. Handle recovery actions (including config rollback)
    if (this.config.recovery.enabled) {
      await this.handleRecoveryActions(report);
    }

    return report;
  }

  /**
   * Log a brief status summary
   */
  private logStatusSummary(report: WatchdogReport): void {
    const statusEmoji = {
      healthy: '✅',
      degraded: '⚠️',
      unhealthy: '🔴',
      critical: '🚨',
    };

    const emoji = statusEmoji[report.status];
    const summary = `${emoji} Status: ${report.status} | Errors: ${report.logAnalysis.errors.length} | Failed models: ${report.modelStatus.failedModels.length}`;

    if (report.status === 'healthy') {
      logger.info(summary);
    } else if (report.status === 'degraded') {
      logger.warn(summary);
    } else {
      logger.error(summary);
    }
  }

  /**
   * Handle recovery actions
   */
  private async handleRecoveryActions(report: WatchdogReport): Promise<void> {
    // Check if config is valid first
    const configStatus = await this.configGuardian.isConfigValid();

    if (!configStatus.valid) {
      logger.error('Config file is invalid', { error: configStatus.error });

      // Attempt rollback to last-known-good
      if (!this.config.dryRun) {
        const rollbackResult = await this.configGuardian.rollbackToLastKnownGood();
        this.reportGenerator.recordAction({
          type: 'config_rollback' as any,
          description: rollbackResult.success
            ? `Config rolled back: ${rollbackResult.reason}`
            : `Config rollback failed: ${rollbackResult.reason}`,
          dryRun: false,
          result: rollbackResult.success ? 'success' : 'failed',
        });

        if (rollbackResult.success) {
          logger.info('Config rolled back successfully, will attempt Gateway restart');
        }
      } else {
        logger.info('[DRY-RUN] Would rollback config to last-known-good');
      }
    }

    // Use RecoveryEngine to handle restart logic
    const actions = await this.recoveryEngine.handleRecovery(report);

    // Record all actions
    for (const action of actions) {
      this.reportGenerator.recordAction(action);

      // Update state if restart was attempted
      if (action.type === 'restart' && action.result !== 'skipped') {
        this.state.restartAttempts++;
        this.state.lastRestartAt = action.ts;
      }
    }

    // Send notifications for recovery actions
    if (actions.length > 0) {
      await this.notifier.sendRecoveryAlert(actions);
    }

    // Send status notification if degraded or worse
    if (report.status !== 'healthy') {
      await this.notifier.sendStatusReport(report);
    }
  }

  /**
   * Run a single check and exit (for testing)
   */
  async runOnce(): Promise<WatchdogReport> {
    logger.info('Running single monitoring check...');
    const report = await this.runMonitoringCycle();

    // Print summary to console
    console.log('\n' + report.summary + '\n');

    return report;
  }

  /**
   * Get current state
   */
  getState(): WatchdogState {
    return { ...this.state };
  }

  /**
   * Get config
   */
  getConfig(): WatchdogConfig {
    return { ...this.config };
  }
}

/**
 * Load configuration from file
 */
async function loadConfig(configPath?: string): Promise<WatchdogConfig> {
  const defaultPath = join(__dirname, '../config/watchdog.json');
  const path = configPath || defaultPath;

  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as WatchdogConfig;
  } catch (error) {
    throw new Error(`Failed to load config from ${path}: ${(error as Error).message}`);
  }
}

/**
 * CLI entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || 'run';

  console.log(`
╔════════════════════════════════════════════════════════════╗
║           🐕 OpenClaw Watchdog v1.2.0 (Phase 3)           ║
║     Monitoring + Gateway Restart + Model Auto-Switch      ║
╚════════════════════════════════════════════════════════════╝
`);

  try {
    const configPath = args.find(a => a.startsWith('--config='))?.split('=')[1];
    const config = await loadConfig(configPath);

    const watchdog = new Watchdog(config);

    if (command === 'check' || command === 'once') {
      // Run single check
      await watchdog.runOnce();
      process.exit(0);
    } else if (command === 'run' || command === 'start') {
      // Run continuous monitoring
      await watchdog.start();

      // Handle shutdown signals
      const shutdown = () => {
        watchdog.stop();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // Keep process alive
      await new Promise(() => { }); // Never resolves
    } else if (command === 'notify-test') {
      // Send test notification
      const notifier = new Notifier(config.notifications, config.dryRun);
      const success = await notifier.sendTest();
      console.log(success ? '✅ Test notification sent' : '❌ Failed to send notification');
      process.exit(success ? 0 : 1);
    } else if (command === 'service-install') {
      const plistSource = join(__dirname, '../com.openclaw.watchdog.plist');
      const plistDest = join(homedir(), 'Library/LaunchAgents/com.openclaw.watchdog.plist');

      console.log('Installing launchd service...');
      try {
        await execAsync(`cp "${plistSource}" "${plistDest}"`);
        await execAsync(`launchctl load "${plistDest}"`);
        console.log('✅ Service installed and loaded successfully');
        console.log(`Path: ${plistDest}`);
      } catch (error) {
        console.error('❌ Failed to install service:', (error as Error).message);
        process.exit(1);
      }
      process.exit(0);
    } else if (command === 'service-uninstall') {
      const plistDest = join(homedir(), 'Library/LaunchAgents/com.openclaw.watchdog.plist');

      console.log('Uninstalling launchd service...');
      try {
        await execAsync(`launchctl unload "${plistDest}"`);
        await execAsync(`rm "${plistDest}"`);
        console.log('✅ Service uninstalled successfully');
      } catch (error) {
        console.error('❌ Failed to uninstall service:', (error as Error).message);
        process.exit(1);
      }
      process.exit(0);
    } else if (command === 'service-status') {
      console.log('Checking service status...');
      try {
        const { stdout } = await execAsync('launchctl list | grep com.openclaw.watchdog || echo "Not found"');
        console.log(stdout.trim());
      } catch (error) {
        console.error('❌ Failed to check status:', (error as Error).message);
      }
      process.exit(0);
    } else if (command === 'help') {
      console.log(`
Usage: npx tsx src/watchdog.ts [command] [options]

Commands:
  run, start      Start continuous monitoring (default)
  check, once     Run a single check and exit
  notify-test     Send a test notification
  service-install Install as a launchd service (macOS)
  service-uninstall Remove the launchd service
  service-status  Show launchd service status
  help            Show this help message

Options:
  --config=<path>   Path to config file (default: config/watchdog.json)

Examples:
  npx tsx src/watchdog.ts
  npx tsx src/watchdog.ts check
  npx tsx src/watchdog.ts notify-test
  npx tsx src/watchdog.ts run --config=./my-config.json
`);
      process.exit(0);
    } else {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
  } catch (error) {
    console.error('Fatal error:', (error as Error).message);
    process.exit(1);
  }
}

// Run if executed directly
main().catch(console.error);

export { loadConfig };
