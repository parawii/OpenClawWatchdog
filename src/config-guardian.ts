/**
 * OpenClaw Watchdog - Config Guardian
 * 
 * Manages backup and rollback of openclaw.json
 * Strategy:
 * - Backup only when config is new AND Gateway is healthy
 * - Rollback to last-known-good when Gateway fails to start
 * - Keep 10 recent backups + 1 last-known-good
 */

import { createHash } from 'crypto';
import { 
  readFile, 
  writeFile, 
  mkdir, 
  readdir, 
  unlink, 
  copyFile,
  stat,
  access,
} from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import { logger } from './logger.js';

export interface ConfigGuardianOptions {
  configPath?: string;
  backupDir?: string;
  maxBackups?: number;
}

export interface BackupInfo {
  filename: string;
  hash: string;
  timestamp: number;
  path: string;
}

export class ConfigGuardian {
  private configPath: string;
  private backupDir: string;
  private maxBackups: number;
  private lastKnownGoodFile: string;
  private hashIndexFile: string;

  constructor(options: ConfigGuardianOptions = {}) {
    this.configPath = options.configPath || join(homedir(), '.openclaw', 'openclaw.json');
    this.backupDir = options.backupDir || join(homedir(), '.openclaw', 'backups');
    this.maxBackups = options.maxBackups || 10;
    this.lastKnownGoodFile = join(this.backupDir, 'openclaw.json.last-known-good');
    this.hashIndexFile = join(this.backupDir, 'hash-index.json');
  }

  /**
   * Initialize backup directory
   */
  async init(): Promise<void> {
    try {
      await mkdir(this.backupDir, { recursive: true });
      logger.debug('Backup directory ready', { path: this.backupDir });
    } catch (error) {
      logger.error('Failed to create backup directory', { error: (error as Error).message });
    }
  }

  /**
   * Calculate hash of current config file
   */
  async getConfigHash(): Promise<string | null> {
    try {
      const content = await readFile(this.configPath, 'utf-8');
      return createHash('sha256').update(content).digest('hex').substring(0, 16);
    } catch {
      return null;
    }
  }

  /**
   * Check if current config version has been backed up
   */
  async isVersionBackedUp(hash: string): Promise<boolean> {
    try {
      const indexContent = await readFile(this.hashIndexFile, 'utf-8');
      const index = JSON.parse(indexContent) as Record<string, string>;
      return hash in index;
    } catch {
      // No index file yet
      return false;
    }
  }

  /**
   * Load hash index
   */
  private async loadHashIndex(): Promise<Record<string, string>> {
    try {
      const content = await readFile(this.hashIndexFile, 'utf-8');
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  /**
   * Save hash index
   */
  private async saveHashIndex(index: Record<string, string>): Promise<void> {
    await writeFile(this.hashIndexFile, JSON.stringify(index, null, 2));
  }

  /**
   * Backup current config if it's a new version and Gateway is healthy
   * Call this AFTER confirming Gateway is healthy
   */
  async backupIfNeeded(): Promise<{ backed: boolean; reason: string }> {
    await this.init();

    // Get current config hash
    const hash = await this.getConfigHash();
    if (!hash) {
      return { backed: false, reason: 'Cannot read config file' };
    }

    // Check if already backed up
    if (await this.isVersionBackedUp(hash)) {
      return { backed: false, reason: 'Version already backed up' };
    }

    // Validate config is valid JSON
    try {
      const content = await readFile(this.configPath, 'utf-8');
      JSON.parse(content);
    } catch {
      return { backed: false, reason: 'Config is not valid JSON' };
    }

    // Create timestamped backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `openclaw.json.${timestamp}.bak`;
    const backupPath = join(this.backupDir, backupFilename);

    try {
      await copyFile(this.configPath, backupPath);
      
      // Update hash index
      const index = await this.loadHashIndex();
      index[hash] = backupFilename;
      await this.saveHashIndex(index);

      // Update last-known-good
      await copyFile(this.configPath, this.lastKnownGoodFile);

      logger.info('Config backed up', { hash, filename: backupFilename });

      // Cleanup old backups
      await this.cleanupOldBackups();

      return { backed: true, reason: `Backed up as ${backupFilename}` };
    } catch (error) {
      logger.error('Failed to backup config', { error: (error as Error).message });
      return { backed: false, reason: (error as Error).message };
    }
  }

  /**
   * Remove old backups, keeping only maxBackups + last-known-good
   */
  private async cleanupOldBackups(): Promise<void> {
    try {
      const files = await readdir(this.backupDir);
      const backups = files
        .filter(f => f.endsWith('.bak'))
        .map(f => ({
          name: f,
          path: join(this.backupDir, f),
        }));

      // Sort by name (which includes timestamp) descending
      backups.sort((a, b) => b.name.localeCompare(a.name));

      // Remove excess backups
      const toRemove = backups.slice(this.maxBackups);
      for (const backup of toRemove) {
        await unlink(backup.path);
        logger.debug('Removed old backup', { filename: backup.name });
      }

      // Update hash index to remove deleted backups
      const index = await this.loadHashIndex();
      const remainingFiles = new Set(backups.slice(0, this.maxBackups).map(b => b.name));
      for (const [hash, filename] of Object.entries(index)) {
        if (!remainingFiles.has(filename)) {
          delete index[hash];
        }
      }
      await this.saveHashIndex(index);

    } catch (error) {
      logger.error('Failed to cleanup old backups', { error: (error as Error).message });
    }
  }

  /**
   * Check if config file is valid JSON
   */
  async isConfigValid(): Promise<{ valid: boolean; error?: string }> {
    try {
      const content = await readFile(this.configPath, 'utf-8');
      JSON.parse(content);
      return { valid: true };
    } catch (error) {
      return { valid: false, error: (error as Error).message };
    }
  }

  /**
   * Rollback to last-known-good config
   */
  async rollbackToLastKnownGood(): Promise<{ success: boolean; reason: string }> {
    try {
      // Check if last-known-good exists
      await access(this.lastKnownGoodFile);
    } catch {
      return { success: false, reason: 'No last-known-good backup exists' };
    }

    try {
      // Backup current (broken) config before overwriting
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const corruptedBackup = join(this.backupDir, `openclaw.json.corrupted-${timestamp}.bak`);
      
      try {
        await copyFile(this.configPath, corruptedBackup);
        logger.info('Saved corrupted config', { path: corruptedBackup });
      } catch {
        // Config might not exist or be unreadable
      }

      // Restore last-known-good
      await copyFile(this.lastKnownGoodFile, this.configPath);
      
      logger.info('Rolled back to last-known-good config');
      return { success: true, reason: 'Restored from last-known-good backup' };

    } catch (error) {
      logger.error('Rollback failed', { error: (error as Error).message });
      return { success: false, reason: (error as Error).message };
    }
  }

  /**
   * List available backups
   */
  async listBackups(): Promise<BackupInfo[]> {
    try {
      await this.init();
      const files = await readdir(this.backupDir);
      const index = await this.loadHashIndex();
      
      // Reverse the index for filename -> hash lookup
      const filenameToHash: Record<string, string> = {};
      for (const [hash, filename] of Object.entries(index)) {
        filenameToHash[filename] = hash;
      }

      const backups: BackupInfo[] = [];
      
      for (const file of files) {
        if (!file.endsWith('.bak')) continue;
        
        const filePath = join(this.backupDir, file);
        try {
          const fileStat = await stat(filePath);
          backups.push({
            filename: file,
            hash: filenameToHash[file] || 'unknown',
            timestamp: fileStat.mtimeMs,
            path: filePath,
          });
        } catch {
          // Skip unreadable files
        }
      }

      // Sort by timestamp descending
      backups.sort((a, b) => b.timestamp - a.timestamp);
      
      return backups;
    } catch {
      return [];
    }
  }

  /**
   * Rollback to a specific backup
   */
  async rollbackTo(filename: string): Promise<{ success: boolean; reason: string }> {
    const backupPath = join(this.backupDir, filename);
    
    try {
      await access(backupPath);
    } catch {
      return { success: false, reason: `Backup not found: ${filename}` };
    }

    try {
      // Validate backup is valid JSON
      const content = await readFile(backupPath, 'utf-8');
      JSON.parse(content);
    } catch {
      return { success: false, reason: 'Backup is not valid JSON' };
    }

    try {
      // Save current config before overwriting
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const preRollbackBackup = join(this.backupDir, `openclaw.json.pre-rollback-${timestamp}.bak`);
      
      try {
        await copyFile(this.configPath, preRollbackBackup);
      } catch {
        // Current config might be unreadable
      }

      // Restore selected backup
      await copyFile(backupPath, this.configPath);
      
      logger.info('Rolled back to specific backup', { filename });
      return { success: true, reason: `Restored from ${filename}` };

    } catch (error) {
      return { success: false, reason: (error as Error).message };
    }
  }

  /**
   * Get status summary
   */
  async getStatus(): Promise<{
    configValid: boolean;
    configHash: string | null;
    hasLastKnownGood: boolean;
    backupCount: number;
  }> {
    const configCheck = await this.isConfigValid();
    const hash = await this.getConfigHash();
    
    let hasLastKnownGood = false;
    try {
      await access(this.lastKnownGoodFile);
      hasLastKnownGood = true;
    } catch {
      // No last-known-good
    }

    const backups = await this.listBackups();

    return {
      configValid: configCheck.valid,
      configHash: hash,
      hasLastKnownGood,
      backupCount: backups.filter(b => !b.filename.includes('corrupted') && !b.filename.includes('pre-rollback')).length,
    };
  }
}
