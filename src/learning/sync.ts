/**
 * Learning Sync Hooks
 *
 * Emits sync events when the learning engine produces new artifacts
 * (playbooks published as skills, knowledge notes written).
 *
 * Follows the same pattern as src/sync/resource-hooks.ts.
 */

import { onResourceSynced } from '../sync/resource-hooks.js';
import { findResourceById } from '../db/dal/syncable-resources.js';

/**
 * Emit sync events after batch learning completes.
 * Called from the atlas-service after a successful batch run.
 *
 * Only emits for resources with 'shared' or 'public' visibility.
 * Imported playbooks from peer hives are NOT re-published
 * (prevents echo/amplification in the mesh).
 */
export function emitBatchSyncEvents(
  skillResourceId: string | null,
  knowledgeResourceId: string | null,
  agentId: string,
  batchResult: Record<string, unknown>,
): void {
  try {
    // Emit sync for skill resource (playbooks → skills)
    if (skillResourceId) {
      const resource = findResourceById(skillResourceId);
      if (resource && (resource.visibility === 'shared' || resource.visibility === 'public')) {
        onResourceSynced(
          resource.id,
          `batch-${Date.now()}`,
          `Batch learning: ${batchResult.playbooksExtracted ?? 0} playbooks extracted`,
          agentId,
          (batchResult.playbooksExtracted as number) ?? 0,
          0,
          0,
        );
      }
    }

    // Emit sync for knowledge resource
    if (knowledgeResourceId) {
      const resource = findResourceById(knowledgeResourceId);
      if (resource && (resource.visibility === 'shared' || resource.visibility === 'public')) {
        onResourceSynced(
          resource.id,
          `batch-${Date.now()}`,
          `Batch learning: knowledge notes updated`,
          agentId,
          (batchResult.knowledgeExtracted as number) ?? 0,
          0,
          0,
        );
      }
    }
  } catch (err) {
    console.warn('[learning-sync] Failed to emit sync events:', (err as Error).message);
  }
}
