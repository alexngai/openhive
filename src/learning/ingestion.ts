import { EntireTrajectorySource } from 'cognitive-core';
import type { AtlasService } from './atlas-service.js';
import type { DistributedLearningCoordinator } from './distributed.js';
import type { LearningLogger } from './types.js';

/** Simple async queue — processes one ingestion at a time */
let ingestionQueue: Promise<void> = Promise.resolve();

/**
 * Trigger trajectory ingestion for a swarm that just went offline.
 * Runs in background — does not block the disconnect handler.
 * Errors are logged and skipped per-session.
 *
 * If a DistributedLearningCoordinator is provided, trajectories may be
 * forwarded to a remote learning hive based on domain routing.
 */
export function triggerIngestion(
  atlasService: AtlasService,
  swarmId: string,
  log: LearningLogger,
  coordinator?: DistributedLearningCoordinator,
): void {
  if (!atlasService.isAvailable()) return;

  ingestionQueue = ingestionQueue.then(async () => {
    try {
      await ingestFromAllBanks(atlasService, swarmId, log, coordinator);
    } catch (err) {
      log.warn(`Ingestion failed for swarm ${swarmId}:`, (err as Error).message);
    }
  });
}

/**
 * Scan all configured SessionBanks for unprocessed sessions and process them.
 * Respects distributed routing — trajectories may be forwarded to remote hives.
 */
async function ingestFromAllBanks(
  atlasService: AtlasService,
  swarmId: string,
  log: LearningLogger,
  coordinator?: DistributedLearningCoordinator,
): Promise<void> {
  const sessionBanks = atlasService.getSessionBanks();
  if (sessionBanks.length === 0) {
    log.warn(`No SessionBanks configured, skipping ingestion for swarm ${swarmId}`);
    return;
  }

  for (let i = 0; i < sessionBanks.length; i++) {
    const sessionBank = sessionBanks[i];
    if (!sessionBank.isAvailable()) continue;

    try {
      // Invalidate cache so we pick up new checkpoints
      sessionBank.invalidateCache();

      const { sessions } = await sessionBank.query({ unprocessedOnly: true });
      if (sessions.length === 0) continue;

      log.info(`Ingesting ${sessions.length} unprocessed session(s) from bank ${i} (swarm ${swarmId})`);

      const source = new EntireTrajectorySource(sessionBank, { outcomeStrategy: 'heuristic' });

      for (const session of sessions) {
        try {
          const trajectory = source.synthesize(session);
          const domain = (trajectory as any).task?.domain || 'unknown';

          // Check distributed routing
          if (coordinator) {
            const target = coordinator.resolveTarget(domain);
            if (target !== 'local') {
              // Forward to remote learning hive
              const forwarded = await coordinator.forwardTrajectory(
                trajectory as unknown as Record<string, unknown>,
                target,
              );
              if (forwarded) {
                await sessionBank.markProcessed(session.sessionId);
                log.info(`Forwarded session ${session.sessionId} (domain: ${domain}) to ${target}`);
                continue;
              }
              // If forwarding failed, fall through to local processing
              log.warn(`Forward failed for ${session.sessionId}, processing locally`);
            }
          }

          // Process locally
          await atlasService.processTrajectory(trajectory);
          await sessionBank.markProcessed(session.sessionId);
          log.info(`Processed session ${session.sessionId}`);
        } catch (err) {
          log.warn(`Failed to process session ${session.sessionId}:`, (err as Error).message);
          // Skip and continue
        }
      }
    } catch (err) {
      log.warn(`SessionBank ${i} scan failed:`, (err as Error).message);
    }
  }
}
