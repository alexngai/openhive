import * as path from 'path';
import * as fs from 'fs';
import { resolveDataDir } from '../data-dir.js';
import { upsertDiscoveredResource } from '../db/dal/syncable-resources.js';
import { broadcastToChannel } from '../realtime/index.js';
import { mapHubEvents } from '../map/service.js';
import { triggerIngestion } from './ingestion.js';
import type { Config } from '../config.js';
import { type Atlas, createAtlas, type ProcessResult, type BatchResult } from 'cognitive-core';

export class AtlasService {
  private atlas: Atlas | null = null;
  private config: Config;
  private baseDir: string;
  private ownerAgentId: string;
  private log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

  constructor(config: Config, ownerAgentId: string, logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }) {
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
      // Ensure storage directories exist
      fs.mkdirSync(this.baseDir, { recursive: true });

      const atlasConfig = this.buildAtlasConfig();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.atlas = createAtlas(atlasConfig as any);
      await this.atlas.init();

      // Register output directories as discoverable resources
      this.registerLearningResources();

      // Listen for swarm offline events to trigger ingestion
      mapHubEvents.on('swarm_offline', ({ swarm_id }: { swarm_id: string }) => {
        triggerIngestion(this, swarm_id, this.log);
      });

      this.log.info('Atlas initialized successfully');
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
   * Enable agentic workspace template execution by wiring a SwarmAgentBackend.
   * Called after swarm infrastructure is available (Phase 1.5+).
   */
  enableAgenticCompute(backend: import('./swarm-agent-backend.js').SwarmAgentBackend): void {
    if (!this.atlas) {
      this.log.warn('Cannot enable agentic compute — Atlas not available');
      return;
    }

    // cognitive-core's Atlas.setAgentManager() wires an AgentBackend.
    // The SwarmAgentBackend is a simplified implementation that only needs
    // spawn() for workspace template execution.
    try {
      this.atlas.setAgentManager([backend as any]);
      this.log.info('Agentic compute enabled via SwarmAgentBackend');
    } catch (err) {
      this.log.warn('Failed to enable agentic compute:', (err as Error).message);
    }
  }

  /** Graceful shutdown */
  async close(): Promise<void> {
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
        enabled: true,
        autoIngest: false, // Controlled by OpenHive ingestion triggers
      },
      features: {
        instantLoop: true,
        reflexion: true,
        causalExtraction: true,
      },
      // taskRunner NOT set → fully programmatic, heuristic fallbacks
    };
  }

  /**
   * Register .skilltree/ and knowledge/ as discoverable resources.
   */
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
