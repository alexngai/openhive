/**
 * DAL wrapper for `loadout` syncable resources.
 *
 * Thin layer over syncable-resources DAL that:
 *   - Stamps resource_type='loadout' on creates
 *   - Stores authored content in metadata.content
 *   - Provides typed accessors so callers don't repeat the cast
 *
 * The authored content shape matches openteams' LoadoutDefinition (see
 * references/openteams/schema/loadout.schema.json). Validation belongs in the
 * routes layer (Zod); this DAL trusts its inputs.
 */

import * as resources from './syncable-resources.js';
import type { SyncableResource, ResourceVisibility } from '../../types.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';

export interface LoadoutResource extends SyncableResource {
  resource_type: 'loadout';
}

export interface CreateLoadoutInput {
  name: string;
  description?: string;
  content: LoadoutContent;
  ownerAgentId: string;
  visibility?: ResourceVisibility;
  metadata?: Record<string, unknown>;
}

export function createLoadout(input: CreateLoadoutInput): LoadoutResource {
  const created = resources.createResource({
    resource_type: 'loadout',
    name: input.name,
    description: input.description,
    git_remote_url: `local://loadout/${input.name}`,
    visibility: input.visibility,
    owner_agent_id: input.ownerAgentId,
    metadata: { ...(input.metadata ?? {}), content: input.content },
  });
  return created as LoadoutResource;
}

export function getLoadout(id: string): LoadoutResource | null {
  const r = resources.findResourceById(id);
  if (!r || r.resource_type !== 'loadout') return null;
  return r as LoadoutResource;
}

/**
 * Look up a loadout by name within an owner's namespace.
 * Loadout names are unique per (owner_agent_id, resource_type='loadout', name)
 * via the existing UNIQUE constraint on syncable_resources.
 */
export function getLoadoutByName(name: string, ownerAgentId: string): LoadoutResource | null {
  const r = resources.findResourceByName(ownerAgentId, 'loadout', name);
  return (r as LoadoutResource | null) ?? null;
}

/**
 * Extract the authored loadout content from a loadout resource's metadata.
 * Returns null if the metadata is missing or malformed.
 */
export function getLoadoutContent(loadout: LoadoutResource): LoadoutContent | null {
  const meta = loadout.metadata as { content?: LoadoutContent } | null;
  return meta?.content ?? null;
}

export interface ListLoadoutsOptions {
  agentId: string;
  owned?: boolean;
  visibility?: ResourceVisibility;
  limit?: number;
  offset?: number;
}

export function listLoadouts(options: ListLoadoutsOptions) {
  return resources.listAccessibleResources({
    ...options,
    resourceType: 'loadout',
  });
}

export interface UpdateLoadoutInput {
  name?: string;
  description?: string;
  content?: LoadoutContent;
  visibility?: ResourceVisibility;
  metadata?: Record<string, unknown>;
}

export function updateLoadout(id: string, input: UpdateLoadoutInput): LoadoutResource | null {
  const existing = getLoadout(id);
  if (!existing) return null;

  // Merge content/metadata: content lives inside metadata, so we replay the
  // existing metadata + override only the fields explicitly passed in.
  let nextMetadata: Record<string, unknown> | undefined;
  if (input.content !== undefined || input.metadata !== undefined) {
    const existingMeta = (existing.metadata as Record<string, unknown> | null) ?? {};
    nextMetadata = {
      ...existingMeta,
      ...(input.metadata ?? {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
    };
  }

  const updated = resources.updateResource(id, {
    name: input.name,
    description: input.description,
    visibility: input.visibility,
    metadata: nextMetadata,
  });
  return (updated as LoadoutResource | null) ?? null;
}

export function deleteLoadout(id: string): boolean {
  const existing = getLoadout(id);
  if (!existing) return false;
  return resources.deleteResource(id);
}
