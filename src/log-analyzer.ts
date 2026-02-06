/**
 * OpenClaw Watchdog - Log Analyzer
 * 
 * Analyzes OpenClaw logs to detect errors and infer root causes.
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, basename } from 'path';
import type { 
  LogEntry, 
  LogAnalysis, 
  AnalyzedError, 
  ModelError,
  ErrorCategory 
} from './types.js';
import { logger } from './logger.js';

// Error patterns for classification
const ERROR_PATTERNS: Array<{
  pattern: RegExp;
  category: ErrorCategory;
  severity: AnalyzedError['severity'];
  modelError?: boolean;
  errorType?: ModelError['errorType'];
}> = [
  // Model quota/rate limit errors
  {
    pattern: /quota|rate.?limit|too.?many.?requests|429|exceeded/i,
    category: 'model_quota',
    severity: 'high',
    modelError: true,
    errorType: 'quota',
  },
  {
    pattern: /rate.?limited|throttl/i,
    category: 'model_quota',
    severity: 'medium',
    modelError: true,
    errorType: 'rate_limit',
  },
  // Model unavailable
  {
    pattern: /model.*(unavailable|not.?found|does.?not.?exist)|503|service.?unavailable/i,
    category: 'model_unavailable',
    severity: 'high',
    modelError: true,
    errorType: 'unavailable',
  },
  {
    pattern: /overloaded|capacity|temporarily/i,
    category: 'model_unavailable',
    severity: 'medium',
    modelError: true,
    errorType: 'unavailable',
  },
  // Auth errors
  {
    pattern: /auth|unauthorized|401|403|invalid.?key|api.?key|token.?(expired|invalid)/i,
    category: 'auth',
    severity: 'critical',
    modelError: true,
    errorType: 'auth',
  },
  // Network errors
  {
    pattern: /network|connection|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket|timeout/i,
    category: 'network',
    severity: 'medium',
  },
  // Config errors
  {
    pattern: /config|invalid.?configuration|missing.?required|validation.?failed/i,
    category: 'config',
    severity: 'high',
  },
  // Channel errors
  {
    pattern: /channel|telegram|whatsapp|discord|webhook/i,
    category: 'channel',
    severity: 'medium',
  },
  // Internal errors
  {
    pattern: /internal|crash|fatal|unhandled|uncaught|SIGTERM|SIGKILL/i,
    category: 'internal',
    severity: 'critical',
  },
];

export class LogAnalyzer {
  private logDir: string;
  private logFilePattern: string;

  constructor(logFilePattern: string = '/tmp/openclaw/openclaw-{{date}}.log') {
    // Extract directory and pattern
    const parts = logFilePattern.split('/');
    const filename = parts.pop() || 'openclaw-{{date}}.log';
    this.logDir = parts.join('/') || '/tmp/openclaw';
    this.logFilePattern = filename;
  }

  /**
   * Get today's log file path
   */
  private getTodayLogPath(): string {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const filename = this.logFilePattern.replace('{{date}}', today);
    return join(this.logDir, filename);
  }

  /**
   * Analyze recent logs (last N minutes)
   */
  async analyzeRecent(minutesBack: number = 30): Promise<LogAnalysis> {
    const analysis: LogAnalysis = {
      errors: [],
      warnings: [],
      modelErrors: [],
      recommendations: [],
    };

    try {
      const logPath = this.getTodayLogPath();
      logger.debug('Analyzing log file', { path: logPath, minutesBack });

      const content = await readFile(logPath, 'utf-8').catch(() => '');
      if (!content) {
        logger.debug('No log file found or empty');
        return analysis;
      }

      const cutoffTs = Date.now() - (minutesBack * 60 * 1000);
      const lines = content.split('\n').filter(Boolean);

      for (const line of lines) {
        const entry = this.parseLine(line);
        if (!entry) continue;

        // Skip old entries
        if (entry.ts < cutoffTs) continue;

        // Analyze error/warn entries
        if (entry.level === 'error' || entry.level === 'warn') {
          const classified = this.classifyError(entry);
          
          if (entry.level === 'error') {
            analysis.errors.push(classified);
          } else {
            analysis.warnings.push(entry.message);
          }

          // Check if it's a model error
          const modelError = this.extractModelError(entry, classified);
          if (modelError) {
            analysis.modelErrors.push(modelError);
          }
        }
      }

      // Generate recommendations based on analysis
      analysis.recommendations = this.generateRecommendations(analysis);

      logger.info('Log analysis complete', {
        errors: analysis.errors.length,
        warnings: analysis.warnings.length,
        modelErrors: analysis.modelErrors.length,
      });

    } catch (error) {
      logger.error('Log analysis failed', { error: (error as Error).message });
    }

    return analysis;
  }

  /**
   * Parse a single log line (JSONL format)
   */
  private parseLine(line: string): LogEntry | null {
    try {
      const data = JSON.parse(line);
      return {
        ts: data.ts || data.time || Date.now(),
        level: data.level || 'info',
        subsystem: data.subsystem || data.name,
        message: data.msg || data.message || '',
        error: data.error || data.err,
        details: data,
      };
    } catch {
      // Plain text log line - try to extract basic info
      const match = line.match(/\[(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}[^\]]*)\]\s*\[(\w+)\]\s*(.*)/);
      if (match) {
        return {
          ts: new Date(match[1]).getTime(),
          level: match[2].toLowerCase(),
          message: match[3],
        };
      }
      return null;
    }
  }

  /**
   * Classify an error entry
   */
  private classifyError(entry: LogEntry): AnalyzedError {
    const text = `${entry.message} ${entry.error || ''}`;
    
    for (const { pattern, category, severity } of ERROR_PATTERNS) {
      if (pattern.test(text)) {
        return {
          ts: entry.ts,
          message: entry.message,
          category,
          severity,
          context: entry.details,
        };
      }
    }

    return {
      ts: entry.ts,
      message: entry.message,
      category: 'unknown',
      severity: 'low',
      context: entry.details,
    };
  }

  /**
   * Extract model-specific error info
   */
  private extractModelError(entry: LogEntry, classified: AnalyzedError): ModelError | null {
    // Check if this matches a model error pattern
    const text = `${entry.message} ${entry.error || ''}`;
    
    for (const { pattern, modelError, errorType } of ERROR_PATTERNS) {
      if (modelError && pattern.test(text)) {
        // Try to extract model name from the log
        const modelMatch = text.match(/model[:\s]+([a-zA-Z0-9\-_\/]+)/i) ||
                          text.match(/(anthropic|openai|google|deepseek|gemini)[\/\-]([a-zA-Z0-9\-_.]+)/i);
        
        const model = modelMatch 
          ? (modelMatch[1].includes('/') ? modelMatch[1] : `${modelMatch[1]}/${modelMatch[2]}`)
          : 'unknown';

        // Try to extract session key
        const sessionMatch = text.match(/session[:\s]+([a-zA-Z0-9:\-_]+)/i);
        
        return {
          ts: entry.ts,
          model,
          sessionKey: sessionMatch?.[1],
          errorType: errorType || 'unknown',
          message: entry.message,
          recoverable: errorType !== 'auth', // Auth errors need manual intervention
        };
      }
    }

    return null;
  }

  /**
   * Generate recommendations based on analysis
   */
  private generateRecommendations(analysis: LogAnalysis): string[] {
    const recs: string[] = [];

    // Group model errors by type
    const quotaErrors = analysis.modelErrors.filter(e => e.errorType === 'quota');
    const authErrors = analysis.modelErrors.filter(e => e.errorType === 'auth');
    const unavailErrors = analysis.modelErrors.filter(e => e.errorType === 'unavailable');

    if (quotaErrors.length > 0) {
      const models = [...new Set(quotaErrors.map(e => e.model))];
      recs.push(`[HIGH] Quota exceeded for: ${models.join(', ')}. Consider switching to fallback models.`);
    }

    if (authErrors.length > 0) {
      const models = [...new Set(authErrors.map(e => e.model))];
      recs.push(`[CRITICAL] Authentication errors for: ${models.join(', ')}. Check API keys in config.`);
    }

    if (unavailErrors.length > 0) {
      const models = [...new Set(unavailErrors.map(e => e.model))];
      recs.push(`[MEDIUM] Models temporarily unavailable: ${models.join(', ')}. Will auto-retry.`);
    }

    // Check for network issues
    const networkErrors = analysis.errors.filter(e => e.category === 'network');
    if (networkErrors.length >= 3) {
      recs.push(`[MEDIUM] Multiple network errors detected (${networkErrors.length}). Check connectivity.`);
    }

    // Check for config issues
    const configErrors = analysis.errors.filter(e => e.category === 'config');
    if (configErrors.length > 0) {
      recs.push(`[HIGH] Configuration errors detected. Run 'openclaw doctor' to diagnose.`);
    }

    // Check for internal/crash errors
    const criticalErrors = analysis.errors.filter(e => e.severity === 'critical');
    if (criticalErrors.length > 0) {
      recs.push(`[CRITICAL] ${criticalErrors.length} critical error(s) detected. Gateway may need restart.`);
    }

    return recs;
  }

  /**
   * Get list of available log files
   */
  async getLogFiles(): Promise<string[]> {
    try {
      const files = await readdir(this.logDir);
      return files
        .filter(f => f.startsWith('openclaw-') && f.endsWith('.log'))
        .map(f => join(this.logDir, f))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }
}
