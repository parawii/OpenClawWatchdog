/**
 * OpenClaw Watchdog - Model Quota Guard
 * 
 * Monitors model quota usage and manages fallback switching.
 */

import type { 
  ModelConfig, 
  ModelStatus, 
  FailedModel, 
  QuotaRecoveryCheck,
  ModelError 
} from './types.js';
import { logger } from './logger.js';

export class ModelQuotaGuard {
  private config: ModelConfig;
  private failedModels: Map<string, FailedModel> = new Map();
  private quotaRecoveryQueue: QuotaRecoveryCheck[] = [];

  constructor(config: ModelConfig) {
    this.config = config;
  }

  /**
   * Process model errors and update failed models registry
   */
  processModelErrors(errors: ModelError[]): void {
    for (const error of errors) {
      if (error.model === 'unknown') continue;

      const existing = this.failedModels.get(error.model);
      
      if (existing) {
        // Update existing entry
        if (error.sessionKey && !existing.sessions.includes(error.sessionKey)) {
          existing.sessions.push(error.sessionKey);
        }
      } else {
        // New failed model
        this.failedModels.set(error.model, {
          model: error.model,
          failedAt: error.ts,
          reason: `${error.errorType}: ${error.message}`,
          sessions: error.sessionKey ? [error.sessionKey] : [],
        });

        // Schedule recovery check if recoverable
        if (error.recoverable) {
          this.scheduleRecoveryCheck(error.model, error.ts);
        }

        logger.warn('Model marked as failed', { 
          model: error.model, 
          reason: error.errorType 
        });
      }
    }
  }

  /**
   * Schedule a quota recovery check
   */
  private scheduleRecoveryCheck(model: string, failedAt: number): void {
    const existing = this.quotaRecoveryQueue.find(c => c.model === model);
    if (existing) return; // Already scheduled

    this.quotaRecoveryQueue.push({
      model,
      failedAt,
      nextCheckAt: failedAt + this.config.quotaRecoveryCheckIntervalMs,
      checkCount: 0,
    });
  }

  /**
   * Get the fallback model for a session
   */
  getFallbackModel(sessionKey: string, currentModel: string): string | null {
    // Find matching rule
    const rule = this.findMatchingRule(sessionKey);
    if (!rule) return null;

    const fallbackOrder = rule.fallbackOrder;
    const currentIndex = fallbackOrder.indexOf(currentModel);

    // Find next available model in fallback order
    for (let i = currentIndex + 1; i < fallbackOrder.length; i++) {
      const candidate = fallbackOrder[i];
      if (!this.failedModels.has(candidate)) {
        return candidate;
      }
    }

    // No fallback available
    return null;
  }

  /**
   * Find the matching session rule
   */
  private findMatchingRule(sessionKey: string): { allowedModels: string[]; fallbackOrder: string[] } | null {
    // Check for exact match first
    if (this.config.sessionRules[sessionKey]) {
      return this.config.sessionRules[sessionKey];
    }

    // Check for pattern matches
    for (const [pattern, rule] of Object.entries(this.config.sessionRules)) {
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        if (regex.test(sessionKey)) {
          return rule;
        }
      }
    }

    // Return default rule
    return this.config.sessionRules['default'] || null;
  }

  /**
   * Check if a model is allowed for a session
   */
  isModelAllowed(sessionKey: string, model: string): boolean {
    const rule = this.findMatchingRule(sessionKey);
    if (!rule) return true; // No rule = allow all

    return rule.allowedModels.includes(model);
  }

  /**
   * Get pending recovery checks that are due
   */
  getDueRecoveryChecks(): QuotaRecoveryCheck[] {
    const now = Date.now();
    return this.quotaRecoveryQueue.filter(c => c.nextCheckAt <= now);
  }

  /**
   * Mark a model as recovered
   */
  markModelRecovered(model: string): void {
    this.failedModels.delete(model);
    this.quotaRecoveryQueue = this.quotaRecoveryQueue.filter(c => c.model !== model);
    logger.info('Model marked as recovered', { model });
  }

  /**
   * Update recovery check after an attempt
   */
  updateRecoveryCheck(model: string, stillFailed: boolean): void {
    const check = this.quotaRecoveryQueue.find(c => c.model === model);
    if (!check) return;

    if (stillFailed) {
      check.checkCount++;
      // Exponential backoff (max 1 hour)
      const backoffMs = Math.min(
        this.config.quotaRecoveryCheckIntervalMs * Math.pow(2, check.checkCount),
        60 * 60 * 1000
      );
      check.nextCheckAt = Date.now() + backoffMs;
      logger.debug('Recovery check rescheduled', { model, nextCheckAt: new Date(check.nextCheckAt).toISOString() });
    } else {
      this.markModelRecovered(model);
    }
  }

  /**
   * Get current model status
   */
  getStatus(): ModelStatus {
    return {
      failedModels: Array.from(this.failedModels.values()),
      activeModels: this.getActiveModels(),
      quotaRecoveryPending: [...this.quotaRecoveryQueue],
    };
  }

  /**
   * Get list of active (non-failed) models
   */
  private getActiveModels(): string[] {
    const allModels = new Set<string>();
    for (const rule of Object.values(this.config.sessionRules)) {
      for (const model of rule.allowedModels) {
        if (!this.failedModels.has(model)) {
          allModels.add(model);
        }
      }
    }
    return Array.from(allModels);
  }

  /**
   * Clear all failed models (for testing/reset)
   */
  reset(): void {
    this.failedModels.clear();
    this.quotaRecoveryQueue = [];
  }
}
