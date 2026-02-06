/**
 * OpenClaw Watchdog - Health Monitor
 * 
 * Monitors OpenClaw Gateway health without causing interference.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { HealthStatus, GatewayConfig } from './types.js';
import { logger } from './logger.js';

const execAsync = promisify(exec);

export class HealthMonitor {
  private config: GatewayConfig;
  private timeoutMs: number;

  constructor(config: GatewayConfig, timeoutMs: number = 10000) {
    this.config = config;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Check Gateway health using CLI (low-impact approach)
   * Uses 'gateway call health' which does NOT auto-start the Gateway
   */
  async checkHealth(): Promise<HealthStatus> {
    const startTs = Date.now();

    try {
      logger.debug('Checking Gateway health...');

      // First check if Gateway process is running (fast check)
      const isRunning = await this.isGatewayProcessRunning();
      if (!isRunning) {
        logger.warn('Gateway process not running');
        return {
          ok: false,
          ts: startTs,
          durationMs: Date.now() - startTs,
          channels: {},
          error: 'Gateway process not running',
        };
      }

      // Use 'gateway call health' - this does NOT auto-start Gateway
      const { stdout } = await execAsync('openclaw gateway call health --json', {
        timeout: this.timeoutMs,
        env: { ...process.env, NO_COLOR: '1' },
      });

      // Parse JSON output (may have leading notices like OpenCode Zen warnings)
      const firstBrace = stdout.indexOf('{');
      const lastBrace = stdout.lastIndexOf('}');
      
      if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
        throw new Error('Invalid health response: no JSON object found');
      }

      const jsonStr = stdout.substring(firstBrace, lastBrace + 1);
      const health = JSON.parse(jsonStr) as HealthStatus;
      health.durationMs = Date.now() - startTs;

      logger.debug('Health check completed', { ok: health.ok, durationMs: health.durationMs });
      return health;

    } catch (error) {
      const err = error as Error & { code?: string; killed?: boolean };
      const durationMs = Date.now() - startTs;

      logger.error('Health check failed', { error: err.message, durationMs });

      return {
        ok: false,
        ts: startTs,
        durationMs,
        channels: {},
        error: err.killed ? 'Health check timed out' : err.message,
      };
    }
  }

  /**
   * Check if Gateway process is running (without starting it)
   */
  private async isGatewayProcessRunning(): Promise<boolean> {
    try {
      // Use ps with grep to find openclaw-gateway process
      const { stdout } = await execAsync('ps -eo pid,comm | grep "openclaw-gateway" | head -1', {
        timeout: 3000,
        shell: '/bin/bash',
      });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Quick ping to check if Gateway is reachable
   */
  async ping(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('openclaw gateway status --json', {
        timeout: 5000,
        env: { ...process.env, NO_COLOR: '1' },
      });
      return stdout.includes('"running":true') || stdout.includes('"reachable":true');
    } catch {
      return false;
    }
  }

  /**
   * Get Gateway uptime and version
   */
  async getGatewayInfo(): Promise<{ version?: string; uptime?: number } | null> {
    try {
      const { stdout } = await execAsync('openclaw status --json', {
        timeout: 5000,
        env: { ...process.env, NO_COLOR: '1' },
      });
      
      const data = JSON.parse(stdout);
      return {
        version: data.version,
        uptime: data.uptime,
      };
    } catch {
      return null;
    }
  }
}
