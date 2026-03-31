import * as path from 'path';
import * as fs from 'fs';
import { resolveDataDir } from '../data-dir.js';
import { upsertDiscoveredResource } from '../db/dal/syncable-resources.js';
import { broadcastToChannel } from '../realtime/index.js';
import { mapHubEvents } from '../map/service.js';
import { triggerIngestion } from './ingestion.js';
import type { Config } from '../config.js';
import { type Atlas, createAtlas, type ProcessResult, type BatchResult, SessionBank } from 'cognitive-core';

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export class AtlasService {
  private atlas: Atlas | null = null;
  private sessionBanks: SessionBank[] = [];
  private config: Config;
  private baseDir: string;
  private ownerAgentId: string;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private log: Logger;

  constructor(config: Config, ownerAgentId: string, logger?: Logger) {
    this.config = config;
    this.ownerAgentId = ownerAgentId;
    this.baseDir = path.join(resolveDataDir(), 'data', 'cognitive-core');
    this.log = logger || {
      info: (...args: unknown[]) => console.log('[learning]', ...args),
      warn: (...args: unknown[]) => console.warn('[learning]', ...args),
      error: (...args: unknown[]) => console.error('[learning]', ...args),
    };
  }

  /**
   * Initialize Atlas. Called after DB is ready.
   * Gracefully degrades on error — rest of OpenHive continues to function.
   */
  async init(): Promise<void> {
    if (!this.config.learning.enabled) {
      this.log.info('Learning engine disabled');
      return;
    }

    try {
      fs.mkdirSync(this.baseDir, { recursive: true });

      const atlasConfig = this.buildAtlasConfig();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.atlas = createAtlas(atlasConfig as any);
      await this.atlas.init();

      // Initialize SessionBanks from sessionlog config
      await this.initSessionBanks();

      // Register output directories as discoverable resources
      this.registerLearningResources();

      // Listen for swarm offline events to trigger ingestion
      mapHubEvents.on('swarm_offline', ({ swarm_id }: { swarm_id: string }) => {
        triggerIngestion(this, swarm_id, this.log);
      });

      // Start maintenance scheduler
      this.startMaintenanceScheduler();

      this.log.info('Atlas initialized successfully');
      this.log.info(`SessionBanks: ${this.sessionBanks.length} configured, ${this.sessionBanks.filter(sb => sb.isAvailable()).length} available`);
    } catch (err) {
      this.log.error('Atlas initialization failed:', (err as Error).message);
      this.log.warn('Learning features will be unavailable');
      this.atlas = null;
    }
  }

  /** Get the Atlas instance. Returns null if disabled or init failed. */
  getAtlas(): Atlas | null {
    return this.atlas;
  }

  /** Check if learning is operational */
  isAvailable(): boolean {
    return this.atlas !== null;
  }

  /** Get the base directory for cognitive-core data */
  getBaseDir(): string {
    return this.baseDir;
  }

  /** Get all initialized SessionBanks */
  getSessionBanks(): SessionBank[] {
    return this.sessionBanks;
  }

  /**
   * Process a trajectory through the learning pipeline.
   * Broadcasts learning:instant WS event on completion.
   */
  async processTrajectory(trajectory: Parameters<Atlas['processTrajectory']>[0]): Promise<ProcessResult | null> {
    if (!this.atlas) return null;

    try {
      const result = await this.atlas.processTrajectory(trajectory);

      broadcastToChannel('learning', {
        type: 'learning:instant',
        data: result,
      });

      return result;
    } catch (err) {
      this.log.error('processTrajectory failed:', (err as Error).message);
      return null;
    }
  }

  /**
   * Trigger batch learning.
   * Broadcasts learning:batch WS event on completion.
   */
  async runBatchLearning(): Promise<BatchResult> {
    if (!this.atlas) {
      throw new Error('Learning engine is not available');
    }

    const result = await this.atlas.runBatchLearning();

    broadcastToChannel('learning', {
      type: 'learning:batch',
      data: result,
    });

    return result;
  }

  /** Get Atlas stats. */
  async getStats(): Promise<ReturnType<Atlas['getStats']> extends Promise<infer T> ? T : never> {
    if (!this.atlas) {
      throw new Error('Learning engine is not available');
    }
    return await this.atlas.getStats();
  }

  /** Get the memory system for direct queries. */
  getMemory(): ReturnType<Atlas['getMemory']> | null {
    return this.atlas?.getMemory() ?? null;
  }

  /** Get the knowledge bank for search. */
  getKnowledgeBank(): ReturnType<Atlas['getKnowledgeBank']> {
    return this.atlas?.getKnowledgeBank() ?? null;
  }

  /** Get the learning pipeline. */
  getLearning(): ReturnType<Atlas['getLearning']> | null {
    return this.atlas?.getLearning() ?? null;
  }

  /**
   * Get a detailed status snapshot for monitoring.
   */
  async getDetailedStatus(): Promise<LearningStatus> {
    const available = this.isAvailable();

    if (!available) {
      return {
        available: false,
        reason: this.config.learning.enabled ? 'Atlas initialization failed' : 'Learning engine disabled',
        session_banks: [],
        maintenance: { scheduled: false },
      };
    }

    const stats = await this.atlas!.getStats();
    const hasAgentExecution = this.atlas!.hasAgentExecution();

    return {
      available: true,
      agentic_compute: hasAgentExecution,
      trajectories_processed: (stats as any).learning?.trajectoriesProcessed ?? 0,
      pending_trajectories: (stats as any).learning?.pendingTrajectories ?? 0,
      experience_count: (stats as any).memory?.experienceCount ?? 0,
      playbook_count: (stats as any).memory?.playbookCount ?? 0,
      session_banks: this.sessionBanks.map((sb, i) => ({
        index: i,
        available: sb.isAvailable(),
        processed: sb.getProcessingLog().length,
      })),
      maintenance: {
        scheduled: this.maintenanceTimer !== null,
        schedule: this.config.learning.maintenance.schedule,
        auto_run: this.config.learning.maintenance.autoRun,
      },
    };
  }

  /**
   * Enable agentic workspace template execution by wiring a SwarmAgentBackend.
   * Called after swarm infrastructure is available (Phase 1.5+).
   */
  enableAgenticCompute(backend: import('./swarm-agent-backend.js').SwarmAgentBackend): void {
    if (!this.atlas) {
      this.log.warn('Cannot enable agentic compute — Atlas not available');
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.atlas.setAgentManager([backend as any]);
      this.log.info('Agentic compute enabled via SwarmAgentBackend');
    } catch (err) {
      this.log.warn('Failed to enable agentic compute:', (err as Error).message);
    }
  }

  /** Graceful shutdown */
  async close(): Promise<void> {
    // Stop maintenance scheduler
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }

    // Close session banks
    for (const sb of this.sessionBanks) {
      try {
        await sb.close();
      } catch { /* non-critical */ }
    }
    this.sessionBanks = [];

    // Close Atlas
    if (this.atlas) {
      try {
        await this.atlas.close();
      } catch (err) {
        this.log.error('Atlas shutdown error:', (err as Error).message);
      }
      this.atlas = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Initialize SessionBanks from sessionlog configuration.
   *
   * Resolution order:
   * 1. Configured sessionlog.sessionDirs → derive repo paths (parent of sessionlog-sessions/)
   * 2. Default: cwd (SessionBank's own default)
   *
   * Each SessionBank points to a git repo that has the sessionlog orphan branch.
   */
  private async initSessionBanks(): Promise<void> {
    const sessionDirs = this.config.sessionlog?.sessionDirs ?? [];
    const stateDir = path.join(this.baseDir, 'session-bank');

    if (sessionDirs.length > 0) {
      // Derive repo paths from configured session directories.
      // sessionDirs point to .git/sessionlog-sessions/ or /path/to/repo/sessionlog-sessions/
      // The repo root is the parent of the parent (sessionlog-sessions is inside .git or repo root)
      for (let i = 0; i < sessionDirs.length; i++) {
        const sessionDir = sessionDirs[i];
        // Try to find the git repo root by walking up from the session dir
        const repoPath = this.resolveRepoPath(sessionDir);
        if (!repoPath) {
          this.log.warn(`Could not resolve git repo from sessionDir: ${sessionDir}`);
          continue;
        }

        try {
          const sb = new SessionBank({
            repoPath,
            stateDir: path.join(stateDir, `bank-${i}`),
            cache: true,
          });
          await sb.init();
          this.sessionBanks.push(sb);
          this.log.info(`SessionBank ${i} initialized: ${repoPath} (available: ${sb.isAvailable()})`);
        } catch (err) {
          this.log.warn(`SessionBank ${i} failed to init from ${repoPath}:`, (err as Error).message);
        }
      }
    } else {
      // Default: use cwd (SessionBank's default behavior)
      try {
        const sb = new SessionBank({
          stateDir: path.join(stateDir, 'bank-default'),
          cache: true,
        });
        await sb.init();
        this.sessionBanks.push(sb);
        this.log.info(`SessionBank default initialized (cwd: ${process.cwd()}, available: ${sb.isAvailable()})`);
      } catch (err) {
        this.log.warn('Default SessionBank failed to init:', (err as Error).message);
      }
    }
  }

  /**
   * Resolve a git repo root from a sessionlog session directory path.
   *
   * Handles two cases:
   * - /path/to/repo/.git/sessionlog-sessions → repo is /path/to/repo
   * - /path/to/session-repo/sessionlog-sessions → repo is /path/to/session-repo
   */
  private resolveRepoPath(sessionDir: string): string | null {
    const resolved = path.resolve(sessionDir);
    const dirname = path.basename(resolved);

    // If the path ends in sessionlog-sessions, go up
    if (dirname === 'sessionlog-sessions') {
      const parent = path.dirname(resolved);
      // If parent is .git, go up one more
      if (path.basename(parent) === '.git') {
        return path.dirname(parent);
      }
      return parent;
    }

    // If the path itself looks like a repo (has .git), use it directly
    if (fs.existsSync(path.join(resolved, '.git'))) {
      return resolved;
    }

    // Try the parent as a repo
    const parent = path.dirname(resolved);
    if (fs.existsSync(path.join(parent, '.git'))) {
      return parent;
    }

    return null;
  }

  /**
   * Start periodic maintenance scheduler.
   * Parses the cron-style schedule to a simple interval.
   */
  private startMaintenanceScheduler(): void {
    if (!this.config.learning.maintenance.autoRun) return;

    // Parse the cron schedule to determine interval.
    // For simplicity, we use a fixed interval approach:
    // "0 3 * * *" (daily at 3am) → check every hour, run if due
    const schedule = this.config.learning.maintenance.schedule;
    const intervalMs = this.parseScheduleInterval(schedule);

    if (intervalMs <= 0) {
      this.log.warn(`Invalid maintenance schedule: ${schedule}`);
      return;
    }

    let lastRunDate = '';

    this.maintenanceTimer = setInterval(async () => {
      if (!this.atlas) return;

      const now = new Date();
      const today = now.toISOString().split('T')[0]; // YYYY-MM-DD

      // Run at most once per day (matches cron daily pattern)
      if (today === lastRunDate) return;

      // Check if current hour matches schedule
      const targetHour = this.parseScheduleHour(schedule);
      if (targetHour !== null && now.getHours() !== targetHour) return;

      lastRunDate = today;
      this.log.info('Running scheduled maintenance cycle');

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pipeline = this.atlas!.getLearning() as any;
        if (pipeline?.runMaintenance) {
          const result = await pipeline.runMaintenance();
          broadcastToChannel('learning', {
            type: 'learning:maintenance',
            data: result,
          });
          this.log.info('Scheduled maintenance completed');
        }
      } catch (err) {
        this.log.error('Scheduled maintenance failed:', (err as Error).message);
      }
    }, intervalMs);

    this.log.info(`Maintenance scheduler started (schedule: ${schedule})`);
  }

  /** Parse a cron schedule to check interval in ms (default: 1 hour) */
  private parseScheduleInterval(_schedule: string): number {
    // For cron-style schedules like "0 3 * * *", check every hour
    return 60 * 60 * 1000;
  }

  /** Extract hour from a cron schedule like "0 3 * * *" → 3 */
  private parseScheduleHour(schedule: string): number | null {
    const parts = schedule.trim().split(/\s+/);
    if (parts.length >= 2) {
      const hour = parseInt(parts[1], 10);
      if (!isNaN(hour) && hour >= 0 && hour <= 23) return hour;
    }
    return null;
  }

  private buildAtlasConfig() {
    const lc = this.config.learning;
    return {
      storage: {
        baseDir: this.baseDir,
        persistenceEnabled: true,
      },
      learning: {
        creditStrategy: lc.atlas.creditStrategy,
        minTrajectories: lc.atlas.minTrajectories,
      },
      memory: {
        maxExperiences: lc.atlas.maxExperiences,
        maxContextTokens: lc.atlas.maxContextTokens,
      },
      embedding: {
        provider: lc.atlas.embedding.provider,
        ...(lc.atlas.embedding.apiKey && { apiKey: lc.atlas.embedding.apiKey }),
        ...(lc.atlas.embedding.model && { model: lc.atlas.embedding.model }),
      },
      knowledgeBank: {
        enabled: true,
        minimemAware: true,
      },
      skillTree: {
        enabled: true,
      },
      sessionBank: {
        enabled: false, // We manage SessionBanks ourselves for multi-project support
      },
      features: {
        instantLoop: true,
        reflexion: true,
        causalExtraction: true,
      },
    };
  }

  private registerLearningResources(): void {
    const skilltreeDir = path.join(this.baseDir, '.skilltree');
    fs.mkdirSync(skilltreeDir, { recursive: true });
    try {
      upsertDiscoveredResource({
        resource_type: 'skill',
        name: 'learning/skills',
        description: 'Skills extracted from learning engine playbooks',
        git_remote_url: skilltreeDir,
        owner_agent_id: this.ownerAgentId,
        scope: 'manual',
        sync_strategy: 'local',
        local_path: skilltreeDir,
      });
    } catch (err) {
      this.log.warn('Failed to register skill resource:', (err as Error).message);
    }

    const knowledgeDir = path.join(this.baseDir, 'knowledge');
    fs.mkdirSync(knowledgeDir, { recursive: true });
    try {
      upsertDiscoveredResource({
        resource_type: 'memory_bank',
        name: 'learning/knowledge',
        description: 'Knowledge notes from the learning engine',
        git_remote_url: knowledgeDir,
        owner_agent_id: this.ownerAgentId,
        scope: 'manual',
        sync_strategy: 'local',
        local_path: knowledgeDir,
      });
    } catch (err) {
      this.log.warn('Failed to register knowledge resource:', (err as Error).message);
    }
  }
}

/** Detailed learning status for monitoring */
export interface LearningStatus {
  available: boolean;
  reason?: string;
  agentic_compute?: boolean;
  trajectories_processed?: number;
  pending_trajectories?: number;
  experience_count?: number;
  playbook_count?: number;
  session_banks: Array<{
    index: number;
    available: boolean;
    processed: number;
  }>;
  maintenance: {
    scheduled: boolean;
    schedule?: string;
    auto_run?: boolean;
  };
}
