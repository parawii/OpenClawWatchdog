/**
 * OpenClaw Watchdog - Model Switcher
 * 
 * Handles automatic model switching via Gateway API when quota/rate limits hit.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger.js';

const execAsync = promisify(exec);

export interface ModelSwitchResult {
  success: boolean;
  previousModel: string | null;
  newModel: string;
  sessionKey: string;
  error?: string;
}

export interface SessionInfo {
  key: string;
  model: string;
  kind: string;
}

export class ModelSwitcher {
  private gatewayUrl: string;
  private gatewayToken: string | null;
  private dryRun: boolean;

  constructor(gatewayUrl: string, gatewayToken: string | null, dryRun: boolean) {
    this.gatewayUrl = gatewayUrl;
    this.gatewayToken = gatewayToken;
    this.dryRun = dryRun;
  }

  /**
   * Get current session info including model
   */
  async getSessionInfo(sessionKey: string): Promise<SessionInfo | null> {
    try {
      const { stdout } = await execAsync(
        `openclaw sessions list --json`,
        { timeout: 10000, env: { ...process.env, NO_COLOR: '1' } }
      );

      const firstBracket = stdout.indexOf('[');
      const lastBracket = stdout.lastIndexOf(']');
      if (firstBracket === -1 || lastBracket === -1) {
        return null;
      }

      const sessions = JSON.parse(stdout.substring(firstBracket, lastBracket + 1));
      const session = sessions.find((s: any) => s.key === sessionKey);
      
      if (!session) return null;

      return {
        key: session.key,
        model: session.model || 'unknown',
        kind: session.kind || 'unknown',
      };
    } catch (error) {
      logger.error('Failed to get session info', { error: (error as Error).message });
      return null;
    }
  }

  /**
   * List all active sessions
   */
  async listActiveSessions(): Promise<SessionInfo[]> {
    try {
      const { stdout } = await execAsync(
        `openclaw sessions list --json`,
        { timeout: 10000, env: { ...process.env, NO_COLOR: '1' } }
      );

      const firstBracket = stdout.indexOf('[');
      const lastBracket = stdout.lastIndexOf(']');
      if (firstBracket === -1 || lastBracket === -1) {
        return [];
      }

      const sessions = JSON.parse(stdout.substring(firstBracket, lastBracket + 1));
      return sessions.map((s: any) => ({
        key: s.key,
        model: s.model || 'unknown',
        kind: s.kind || 'unknown',
      }));
    } catch (error) {
      logger.error('Failed to list sessions', { error: (error as Error).message });
      return [];
    }
  }

  /**
   * Switch model for a specific session using Gateway API
   */
  async switchSessionModel(sessionKey: string, newModel: string): Promise<ModelSwitchResult> {
    const result: ModelSwitchResult = {
      success: false,
      previousModel: null,
      newModel,
      sessionKey,
    };

    // Get current model
    const sessionInfo = await this.getSessionInfo(sessionKey);
    if (sessionInfo) {
      result.previousModel = sessionInfo.model;
    }

    // Dry-run check
    if (this.dryRun) {
      logger.info('[DRY-RUN] Would switch model', {
        sessionKey,
        from: result.previousModel,
        to: newModel,
      });
      result.success = true;
      return result;
    }

    try {
      // Use Gateway call to set session model override
      // Format: openclaw gateway call session.setModel --json '{"sessionKey":"...","model":"..."}'
      const payload = JSON.stringify({ sessionKey, model: newModel });
      
      const { stdout, stderr } = await execAsync(
        `openclaw gateway call session.setModel --json '${payload}'`,
        { timeout: 15000, env: { ...process.env, NO_COLOR: '1' } }
      );

      // Check for success
      if (stdout.includes('"ok":true') || stdout.includes('success')) {
        result.success = true;
        logger.info('Model switched successfully', {
          sessionKey,
          from: result.previousModel,
          to: newModel,
        });
      } else {
        result.error = stderr || stdout;
        logger.error('Model switch failed', { sessionKey, error: result.error });
      }
    } catch (error) {
      result.error = (error as Error).message;
      logger.error('Model switch error', { sessionKey, error: result.error });
    }

    return result;
  }

  /**
   * Switch model for all sessions using a specific model
   */
  async switchAllSessionsFromModel(
    fromModel: string, 
    toModel: string
  ): Promise<ModelSwitchResult[]> {
    const results: ModelSwitchResult[] = [];
    const sessions = await this.listActiveSessions();

    // Find sessions using the failing model
    const affectedSessions = sessions.filter(s => s.model === fromModel);
    
    if (affectedSessions.length === 0) {
      logger.debug('No sessions using model', { model: fromModel });
      return results;
    }

    logger.info('Switching sessions from failing model', {
      fromModel,
      toModel,
      sessionCount: affectedSessions.length,
    });

    for (const session of affectedSessions) {
      const result = await this.switchSessionModel(session.key, toModel);
      results.push(result);
      
      // Small delay between switches to avoid overwhelming the gateway
      await this.sleep(100);
    }

    return results;
  }

  /**
   * Test if a model is working by making a simple API call
   */
  async testModel(model: string): Promise<boolean> {
    try {
      // Use openclaw to test the model with a minimal prompt
      const { stdout } = await execAsync(
        `openclaw chat --model "${model}" --message "hi" --max-tokens 5 --no-stream 2>&1`,
        { timeout: 30000, env: { ...process.env, NO_COLOR: '1' } }
      );

      // Check for common error patterns
      const errorPatterns = [
        'rate limit',
        'quota',
        'exceeded',
        '429',
        '403',
        'unauthorized',
        'unavailable',
      ];

      const lowerOutput = stdout.toLowerCase();
      for (const pattern of errorPatterns) {
        if (lowerOutput.includes(pattern)) {
          logger.debug('Model test failed', { model, pattern });
          return false;
        }
      }

      logger.debug('Model test passed', { model });
      return true;
    } catch (error) {
      logger.debug('Model test error', { model, error: (error as Error).message });
      return false;
    }
  }

  /**
   * Find the best available model from a fallback list
   */
  async findAvailableModel(fallbackOrder: string[], excludeModels: string[] = []): Promise<string | null> {
    for (const model of fallbackOrder) {
      if (excludeModels.includes(model)) {
        continue;
      }

      // Quick test if model is available
      const available = await this.testModel(model);
      if (available) {
        return model;
      }
    }

    return null;
  }

  /**
   * Set default model for new sessions
   */
  async setDefaultModel(model: string): Promise<boolean> {
    if (this.dryRun) {
      logger.info('[DRY-RUN] Would set default model', { model });
      return true;
    }

    try {
      // Use gateway config.patch to update default model
      const { stdout } = await execAsync(
        `openclaw gateway call config.patch --json '{"agents":{"defaults":{"model":{"primary":"${model}"}}}}'`,
        { timeout: 15000, env: { ...process.env, NO_COLOR: '1' } }
      );

      if (stdout.includes('"ok":true')) {
        logger.info('Default model updated', { model });
        return true;
      }
      
      return false;
    } catch (error) {
      logger.error('Failed to set default model', { error: (error as Error).message });
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
