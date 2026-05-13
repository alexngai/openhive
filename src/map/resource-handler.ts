/**
 * MAP Resource Protocol handler — map/resources/list and map/resources/get.
 *
 * Per-type dispatch: repos route to repos DAL (metadata-visibility scoping),
 * other types route to listAccessibleResources (column-level scoping).
 * Returns MAPResource envelope on the MAP wire.
 */

import type { SyncableResource, SyncableResourceType } from '../types.js';
import * as repos from '../db/dal/repos.js';
import * as resources from '../db/dal/syncable-resources.js';

// ── Type namespace mapping ───────────────────────────────────────────────────

const INTERNAL_TO_NAMESPACED: Record<string, string> = {
  repo: 'x-workspace/repo',
  memory_bank: 'x-minimem/memory-bank',
  session: 'x-sessionlog/session',
  task: 'x-opentasks/task-board',
  skill: 'x-skill-tree/skill',
  playbook: 'x-openhive/playbook',
  team_template: 'x-openhive/team-template',
  loadout: 'x-openhive/loadout',
};

const NAMESPACED_TO_INTERNAL: Record<string, SyncableResourceType> = {};
for (const [internal, namespaced] of Object.entries(INTERNAL_TO_NAMESPACED)) {
  NAMESPACED_TO_INTERNAL[namespaced] = internal as SyncableResourceType;
}

export function toNamespacedType(internal: string): string {
  return INTERNAL_TO_NAMESPACED[internal] ?? internal;
}

export function toInternalType(namespaced: string): SyncableResourceType | null {
  return NAMESPACED_TO_INTERNAL[namespaced] ?? null;
}

export function getAdvertisedKinds(): string[] {
  return Object.values(INTERNAL_TO_NAMESPACED);
}

// ── MAPResource projection ──────────────────────────────────────────────────

interface MAPResource {
  id: string;
  type: string;
  name: string;
  status: string;
  owner_id: string;
  origin_hub_id: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
}

function toMAPResource(r: SyncableResource): MAPResource {
  return {
    id: r.id,
    type: toNamespacedType(r.resource_type),
    name: r.name,
    status: r.status ?? 'active',
    owner_id: r.owner_agent_id,
    origin_hub_id: (r.metadata as Record<string, unknown>)?.origin_hub_id as string | null ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    metadata: r.metadata ?? {},
  };
}

// ── Handlers ────────────────────────────────────────────────────────────────

export async function handleResourceList(
  params: {
    type: string;
    filter?: Record<string, unknown>;
    cursor?: string | null;
    limit?: number;
  },
  ctx: { session?: { metadata?: Record<string, unknown> } },
): Promise<{ resources: MAPResource[]; cursor: string | null; total: number | null }> {
  const { type, filter, limit = 50 } = params;
  const cursor = params.cursor ?? null;
  const offset = cursor ? parseInt(cursor, 10) : 0;

  const internalType = toInternalType(type);
  if (!internalType) {
    throw Object.assign(
      new Error(`Unknown resource type: ${type}`),
      { code: -32001 },
    );
  }

  const agentId = ctx.session?.metadata?.agentId as string
    || ctx.session?.metadata?.hubAgentId as string
    || '';

  if (internalType === 'repo') {
    const allRepos = repos.listRepos(filter as repos.ListReposFilter | undefined);
    const visible = filterReposByVisibility(allRepos, agentId);
    const page = visible.slice(offset, offset + limit);
    const nextCursor = offset + limit < visible.length
      ? String(offset + limit)
      : null;
    return {
      resources: page.map(toMAPResource),
      cursor: nextCursor,
      total: visible.length,
    };
  }

  const result = resources.listAccessibleResources({
    agentId,
    resourceType: internalType,
    limit,
    offset,
  });

  const nextCursor = offset + limit < result.total
    ? String(offset + limit)
    : null;

  return {
    resources: result.data.map(toMAPResource),
    cursor: nextCursor,
    total: result.total,
  };
}

export async function handleResourceGet(
  params: { id: string; type?: string },
  ctx: { session?: { metadata?: Record<string, unknown> } },
): Promise<MAPResource> {
  const { id } = params;

  const agentId = ctx.session?.metadata?.agentId as string
    || ctx.session?.metadata?.hubAgentId as string
    || '';

  const resource = resources.findResourceById(id);
  if (!resource) {
    throw Object.assign(
      new Error('Resource not found'),
      { code: -32004 },
    );
  }

  if (params.type) {
    const expectedInternal = toInternalType(params.type);
    if (expectedInternal && resource.resource_type !== expectedInternal) {
      throw Object.assign(
        new Error('Resource not found'),
        { code: -32004 },
      );
    }
  }

  if (resource.resource_type === 'repo') {
    const meta = resource.metadata as Record<string, unknown> | null;
    const repoVis = meta?.visibility as string | undefined;
    if (repoVis === 'private' && resource.owner_agent_id !== agentId) {
      throw Object.assign(
        new Error('Resource not found'),
        { code: -32004 },
      );
    }
  } else {
    if (!resources.canAccessResource(agentId, resource)) {
      throw Object.assign(
        new Error('Resource not found'),
        { code: -32004 },
      );
    }
  }

  return toMAPResource(resource);
}

// ── Visibility helpers ──────────────────────────────────────────────────────

function filterReposByVisibility(
  allRepos: SyncableResource[],
  viewerAgentId: string,
): SyncableResource[] {
  return allRepos.filter((r) => {
    const meta = r.metadata as Record<string, unknown> | null;
    const vis = meta?.visibility as string | undefined;
    if (vis === 'private') return r.owner_agent_id === viewerAgentId;
    return true;
  });
}
