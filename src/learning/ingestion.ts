import { EntireTrajectorySource, SessionBank } from 'cognitive-core';
import type { AtlasService } from './atlas-service.js';

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

/** Simple async queue — processes one ingestion at a time */
let ingestionQueue: Promise<void> = Promise.resolve();

/**
 * Trigger trajectory ingestion for a swarm that just went offline.
 * Runs in background — does not block the disconnect handler.
 * Errors are logged and skipped per-session.
 */
export function triggerIngestion(
  atlasService: AtlasService,
  swarmId: string,
  log: Logger,
): void {
  if (!atlasService.isAvailable()) return;

  ingestionQueue = ingestionQueue.then(async () => {
    try {
      await ingestSwarmSessions(atlasService, swarmId, log);
    } catch (err) {
      log.warn(`Ingestion failed for swarm ${swarmId}:`, (err as Error).message);
    }
  });
}

async function ingestSwarmSessions(
  atlasService: AtlasService,
  swarmId: string,
  log: Logger,
): Promise<void> {
  const atlas = atlasService.getAtlas();
  if (!atlas) return;

  // Get the learning pipeline's session bank
  // SessionBank is configured during Atlas init via sessionBank config
  const learning = atlasService.getLearning();
  if (!learning) {
    log.warn(`No learning pipeline available, skipping ingestion for swarm ${swarmId}`);
    return;
  }

  // Access the session bank from the learning pipeline's trajectory sources
  // For now, create a standalone SessionBank to scan for unprocessed sessions
  // This will be refined as we better understand the Atlas ↔ SessionBank wiring
  const baseDir = atlasService.getBaseDir();

  let sessionBank: SessionBank;
  try {
    sessionBank = new SessionBank({ stateDir: baseDir, cache: true });
    await sessionBank.init();
  } catch (err) {
    log.warn(`SessionBank init failed for swarm ${swarmId}:`, (err as Error).message);
    return;
  }

  if (!sessionBank.isAvailable()) {
    log.warn(`SessionBank not available (no git repo found), skipping ingestion for swarm ${swarmId}`);
    return;
  }

  // Query unprocessed sessions
  const { sessions } = await sessionBank.query({ unprocessedOnly: true });
  if (sessions.length === 0) return;

  log.info(`Processing ${sessions.length} unprocessed session(s) from swarm ${swarmId}`);

  const source = new EntireTrajectorySource(sessionBank, { outcomeStrategy: 'heuristic' });

  for (const session of sessions) {
    try {
      const trajectory = source.synthesize(session);
      await atlasService.processTrajectory(trajectory);
      await sessionBank.markProcessed(session.sessionId);
      log.info(`Processed session ${session.sessionId}`);
    } catch (err) {
      log.warn(`Failed to process session ${session.sessionId}:`, (err as Error).message);
      // Skip and continue with next session
    }
  }

  await sessionBank.close();
}
