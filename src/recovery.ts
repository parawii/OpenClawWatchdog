/**
 * OpenClaw Watchdog - Recovery Engine
 * 
 * Phase 2: Gateway restart + Model switching functionality
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { RecoveryConfig, WatchdogReport, Action, ModelConfig } from './types.js';
import { logger } from './logger.js';
import { ModelSwitcher, type ModelSwitchResult } from './model-switcher.js';

const execAsync = promisify(exec);

export interface RecoveryState {
  restartAttempts: number;
  lastRestartAt: number | null;
  consecutiveFailures: number;
  consecutiveCriticalCycles: number;
  modelSwitchAttempts: Map<string, number>;  // model -> switch count
  lastModelSwitch: number | null;
}

export class RecoveryEngine {
  private config: RecoveryConfig;
  private modelConfig: ModelConfig | null;
  private state: RecoveryState;
  private dryRun: boolean;
  private modelSwitcher: ModelSwitcher;

  constructor(config: RecoveryConfig, dryRun: boolean, modelConfig?: ModelConfig) {
    this.config = config;
    this.modelConfig = modelConfig || null;
    this.dryRun = dryRun;
    this.modelSwitcher = new ModelSwitcher('ws://127.0.0.1:18789', null, dryRun);
    this.state = {
      restartAttempts: 0,
      lastRestartAt: null,
      consecutiveFailures: 0,
      consecutiveCriticalCycles: 0,
      modelSwitchAttempts: new Map(),
      lastModelSwitch: null,
    };
  }

  /**
   * Check if restart is allowed based on cooldown and attempt limits
   */
  canRestart(): { allowed: boolean; reason?: string } {
    if (!this.config.enabled) {
      return { allowed: false, reason: 'Recovery disabled in config' };
    }

    // Check max attempts
    if (this.state.restartAttempts >= this.config.maxRestartAttempts) {
      return {
        allowed: false,
        reason: `Max restart attempts reached (${this.config.maxRestartAttempts})`
      };
    }

    // Check cooldown
    if (this.state.lastRestartAt) {
      const elapsed = Date.now() - this.state.lastRestartAt;
      if (elapsed < this.config.restartCooldownMs) {
        const remainingMs = this.config.restartCooldownMs - elapsed;
        return {
          allowed: false,
          reason: `Cooldown active (${Math.ceil(remainingMs / 1000)}s remaining)`
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Attempt to restart the Gateway
   */
  async restartGateway(): Promise<Action> {
    const action: Action = {
      ts: Date.now(),
      type: 'restart',
      description: '',
      dryRun: this.dryRun,
    };

    // Check if restart is allowed
    const check = this.canRestart();
    if (!check.allowed) {
      action.description = `Restart skipped: ${check.reason}`;
      action.result = 'skipped';
      logger.warn(action.description);
      return action;
    }

    // Dry-run mode
    if (this.dryRun) {
      action.description = '[DRY-RUN] Would restart Gateway';
      action.result = 'skipped';
      logger.info(action.description);
      return action;
    }

    // Perform restart
    logger.warn('Attempting Gateway restart...');
    this.state.restartAttempts++;
    this.state.lastRestartAt = Date.now();

    try {
      // Step 1: Kill any existing Gateway process
      logger.info('Stopping Gateway...');
      try {
        // Try graceful stop first
        await execAsync('openclaw gateway stop', { timeout: 10000 });
      } catch {
        // Ignore stop errors
      }

      // Force kill if still running
      try {
        // Kill by process name (openclaw-gateway)
        await execAsync('pkill -9 "openclaw-gateway" || true', { timeout: 5000, shell: '/bin/bash' });
        // Also kill parent openclaw process
        await execAsync('pkill -9 -f "openclaw gateway" || true', { timeout: 5000, shell: '/bin/bash' });
      } catch {
        // Ignore kill errors (process may not exist)
      }

      // Wait for cleanup
      await this.sleep(2000);

      // Step 2: Start Gateway directly (not via LaunchAgent service)
      logger.info('Starting Gateway...');
      // Use nohup to run in background, detached from this process
      await execAsync('nohup openclaw gateway --port 18789 > /tmp/openclaw-watchdog-restart.log 2>&1 &', {
        timeout: 5000,
        shell: '/bin/bash',
      });

      // Wait for startup
      await this.sleep(5000);

      // Step 3: Verify by checking if process is running AND port is listening
      const healthy = await this.verifyGateway();

      if (healthy) {
        action.description = 'Gateway restarted successfully';
        action.result = 'success';
        this.state.consecutiveFailures = 0;
        logger.info(action.description);
      } else {
        action.description = 'Gateway restart completed but health check failed';
        action.result = 'failed';
        this.state.consecutiveFailures++;
        logger.error(action.description);
      }

    } catch (error) {
      const err = error as Error;
      action.description = `Gateway restart failed: ${err.message}`;
      action.result = 'failed';
      this.state.consecutiveFailures++;
      logger.error(action.description);
    }

    return action;
  }

  /**
   * Verify Gateway is healthy after restart
   */
  private async verifyGateway(): Promise<boolean> {
    try {
      // First check if process is running using ps (more reliable)
      const { stdout: psOut } = await execAsync('ps -eo pid,comm | grep "openclaw-gateway" | head -1', {
        timeout: 5000,
        shell: '/bin/bash',
      });

      if (!psOut.trim()) {
        logger.error('Gateway process not found after restart');
        return false;
      }
      const pid = psOut.trim().split(/\s+/)[0];
      logger.debug('Gateway process found', { pid });

      // Then check if port is listening
      const { stdout: portOut } = await execAsync('lsof -i :18789 -t || echo ""', {
        timeout: 5000,
      });

      if (!portOut.trim()) {
        logger.error('Gateway not listening on port 18789');
        return false;
      }
      logger.debug('Port 18789 is listening');

      // Finally do a health check via gateway call (doesn't auto-start)
      const { stdout } = await execAsync('openclaw gateway call health --json', {
        timeout: 15000,
        env: { ...process.env, NO_COLOR: '1' },
      });

      const firstBrace = stdout.indexOf('{');
      const lastBrace = stdout.lastIndexOf('}');

      if (firstBrace === -1 || lastBrace === -1) {
        logger.error('Invalid health response');
        return false;
      }

      const json = JSON.parse(stdout.substring(firstBrace, lastBrace + 1));
      logger.debug('Health check result', { ok: json.ok });
      return json.ok === true;
    } catch (err) {
      logger.error('Health verification failed', { error: (err as Error).message });
      return false;
    }
  }

  /**
   * Decide if restart should be attempted based on report
   */
  shouldRestart(report: WatchdogReport): boolean {
    // Only restart on critical status
    if (report.status !== 'critical') {
      return false;
    }

    // Check if Gateway is actually down (not just channels)
    if (report.health?.ok === true) {
      // Gateway is OK, issue is elsewhere
      return false;
    }

    return true;
  }

  /**
   * Handle recovery actions based on report
   */
  async handleRecovery(report: WatchdogReport): Promise<Action[]> {
    const actions: Action[] = [];

    // Track consecutive critical cycles for grace period
    if (report.status === 'critical') {
      this.state.consecutiveCriticalCycles++;
      logger.info('Critical status detected', {
        consecutiveCycles: this.state.consecutiveCriticalCycles,
        gracePeriodCycles: this.config.gracePeriodCycles,
      });
    } else {
      if (this.state.consecutiveCriticalCycles > 0) {
        logger.info('Status recovered, resetting critical cycle counter', {
          previousCycles: this.state.consecutiveCriticalCycles,
        });
      }
      this.state.consecutiveCriticalCycles = 0;
    }

    // Check if restart is needed (with grace period)
    if (this.shouldRestart(report)) {
      if (this.state.consecutiveCriticalCycles >= this.config.gracePeriodCycles) {
        const action = await this.restartGateway();
        actions.push(action);
      } else {
        const remaining = this.config.gracePeriodCycles - this.state.consecutiveCriticalCycles;
        logger.warn(`Grace period active: ${remaining} more cycle(s) before restart`, {
          currentCycles: this.state.consecutiveCriticalCycles,
          required: this.config.gracePeriodCycles,
        });
        actions.push({
          ts: Date.now(),
          type: 'restart',
          description: `Restart deferred: grace period (${this.state.consecutiveCriticalCycles}/${this.config.gracePeriodCycles} cycles)`,
          dryRun: this.dryRun,
          result: 'skipped',
        });
      }
    }

    // Check if model switching is needed
    if (this.modelConfig?.autoSwitch) {
      const modelActions = await this.handleModelRecovery(report);
      actions.push(...modelActions);
    }

    return actions;
  }

  /**
   * Handle model-related recovery (quota/rate limit issues)
   */
  async handleModelRecovery(report: WatchdogReport): Promise<Action[]> {
    const actions: Action[] = [];

    // Check for model errors that need switching
    for (const modelError of report.logAnalysis.modelErrors) {
      if (!modelError.recoverable) continue;

      // Find fallback model
      const fallback = this.findFallbackModel(modelError.model, modelError.sessionKey);
      if (!fallback) {
        logger.warn('No fallback available for model', { model: modelError.model });
        continue;
      }

      // Check switch cooldown (10 seconds per model)
      const switchCount = this.state.modelSwitchAttempts.get(modelError.model) || 0;
      if (switchCount >= 3) {
        logger.warn('Max model switch attempts reached', { model: modelError.model });
        continue;
      }

      // Perform switch
      const action = await this.switchModel(
        modelError.sessionKey || '*',
        modelError.model,
        fallback
      );
      actions.push(action);

      // Update state
      this.state.modelSwitchAttempts.set(modelError.model, switchCount + 1);
      this.state.lastModelSwitch = Date.now();
    }

    return actions;
  }

  /**
   * Find a fallback model for the failed one
   */
  private findFallbackModel(failedModel: string, sessionKey?: string): string | null {
    if (!this.modelConfig) return null;

    // Find matching rule
    let rule = this.modelConfig.sessionRules['default'];

    if (sessionKey) {
      // Check for exact match
      if (this.modelConfig.sessionRules[sessionKey]) {
        rule = this.modelConfig.sessionRules[sessionKey];
      } else {
        // Check for pattern match
        for (const [pattern, patternRule] of Object.entries(this.modelConfig.sessionRules)) {
          if (pattern.includes('*')) {
            const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
            if (regex.test(sessionKey)) {
              rule = patternRule;
              break;
            }
          }
        }
      }
    }

    if (!rule) return null;

    // Find next model in fallback order
    const currentIndex = rule.fallbackOrder.indexOf(failedModel);
    if (currentIndex === -1) {
      // Model not in fallback order, use first available
      return rule.fallbackOrder[0] || null;
    }

    // Get next available model
    for (let i = currentIndex + 1; i < rule.fallbackOrder.length; i++) {
      const candidate = rule.fallbackOrder[i];
      // Skip if also marked as failed recently
      const switchCount = this.state.modelSwitchAttempts.get(candidate) || 0;
      if (switchCount < 3) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Switch model for a session
   */
  async switchModel(sessionKey: string, fromModel: string, toModel: string): Promise<Action> {
    const action: Action = {
      ts: Date.now(),
      type: 'model_switch',
      description: '',
      dryRun: this.dryRun,
    };

    if (this.dryRun) {
      action.description = `[DRY-RUN] Would switch ${sessionKey} from ${fromModel} to ${toModel}`;
      action.result = 'skipped';
      logger.info(action.description);
      return action;
    }

    logger.info('Switching model', { sessionKey, from: fromModel, to: toModel });

    let result: ModelSwitchResult;

    if (sessionKey === '*') {
      // Switch all sessions using the failed model
      const results = await this.modelSwitcher.switchAllSessionsFromModel(fromModel, toModel);
      const successCount = results.filter(r => r.success).length;

      if (successCount > 0) {
        action.description = `Switched ${successCount}/${results.length} sessions from ${fromModel} to ${toModel}`;
        action.result = 'success';
      } else if (results.length === 0) {
        action.description = `No sessions using ${fromModel}`;
        action.result = 'skipped';
      } else {
        action.description = `Failed to switch sessions from ${fromModel} to ${toModel}`;
        action.result = 'failed';
      }
    } else {
      // Switch specific session
      result = await this.modelSwitcher.switchSessionModel(sessionKey, toModel);

      if (result.success) {
        action.description = `Switched ${sessionKey} from ${fromModel} to ${toModel}`;
        action.result = 'success';
      } else {
        action.description = `Failed to switch ${sessionKey}: ${result.error}`;
        action.result = 'failed';
      }
    }

    logger.info('Model switch result', { description: action.description, result: action.result });
    return action;
  }

  /**
   * Reset model switch attempts (call when models recover)
   */
  resetModelSwitchAttempts(model?: string): void {
    if (model) {
      this.state.modelSwitchAttempts.delete(model);
    } else {
      this.state.modelSwitchAttempts.clear();
    }
  }

  /**
   * Reset attempt counter (call after successful period)
   */
  resetAttempts(): void {
    this.state.restartAttempts = 0;
    this.state.consecutiveFailures = 0;
  }

  /**
   * Get current state
   */
  getState(): RecoveryState {
    return { ...this.state };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
