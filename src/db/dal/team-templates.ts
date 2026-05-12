/**
 * DAL wrapper for `team_template` syncable resources.
 *
 * Thin typed layer over `src/db/dal/syncable-resources.ts`. Stores the
 * authored openteams team template (manifest + sidecar files) inside
 * `metadata.content`. Layer 2 of the openteams MAP integration bundles this
 * content into a content-addressed `x-openteams/team` resource on demand.
 */

import * as resources from './syncable-resources.js';
import type { SyncableResource, ResourceVisibility } from '../../types.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';

export interface TeamTemplateResource extends SyncableResource {
  resource_type: 'team_template';
}

export interface CreateTeamTemplateInput {
  name: string;
  description?: string;
  /**
   * Inline authored content. Optional when `gitRemoteUrl` is set — the
   * row's canonical content then lives in the cloned git checkout.
   */
  content?: TeamTemplateContent;
  ownerAgentId: string;
  visibility?: ResourceVisibility;
  metadata?: Record<string, unknown>;
  /**
   * Layer 6 — git-backed authoring. Sidecar / editor pushes commits;
   * hub lazily clones via `sync_strategy: 'ls-remote'` on first read.
   */
  gitRemoteUrl?: string;
}

export function createTeamTemplate(input: CreateTeamTemplateInput): TeamTemplateResource {
  const gitBacked = typeof input.gitRemoteUrl === 'string' && input.gitRemoteUrl.length > 0;
  const created = resources.createResource({
    resource_type: 'team_template',
    name: input.name,
    description: input.description,
    // Git-backed rows carry the canonical remote URL; in-DB rows fall
    // back to the `local://` scheme that keeps them out of the
    // federation auto-detect path until the Layer 1 hook fans them out.
    git_remote_url: gitBacked
      ? input.gitRemoteUrl!
      : `local://team_template/${input.name}`,
    visibility: input.visibility,
    owner_agent_id: input.ownerAgentId,
    metadata: {
      ...(input.metadata ?? {}),
      // Inline content stays on the row even when git-backed — gives the
      // hub something to serve before the lazy clone completes, and acts
      // as a fallback if the remote is unreachable.
      ...(input.content !== undefined ? { content: input.content } : {}),
    },
    // ls-remote = lazy clone on first content read; auto-pull keeps the
    // checkout fresh on a 2-min poll. Webhooks at
    // `POST /webhooks/resource/:id` close the latency gap.
    sync_strategy: gitBacked ? 'ls-remote' : undefined,
  });
  return created as TeamTemplateResource;
}

export function getTeamTemplate(id: string): TeamTemplateResource | null {
  const r = resources.findResourceById(id);
  if (!r || r.resource_type !== 'team_template') return null;
  return r as TeamTemplateResource;
}

/**
 * Extract the authored content blob from a stored row. Returns `null` when
 * `metadata.content` is absent or malformed — the caller decides whether
 * that's a 404 or a 500.
 */
export function getTeamTemplateContent(
  template: TeamTemplateResource,
): TeamTemplateContent | null {
  const meta = template.metadata as { content?: TeamTemplateContent } | null;
  return meta?.content ?? null;
}

export interface ListTeamTemplatesOptions {
  agentId: string;
  owned?: boolean;
  visibility?: ResourceVisibility;
  limit?: number;
  offset?: number;
}

export function listTeamTemplates(options: ListTeamTemplatesOptions) {
  return resources.listAccessibleResources({
    ...options,
    resourceType: 'team_template',
  });
}

export interface UpdateTeamTemplateInput {
  name?: string;
  description?: string;
  content?: TeamTemplateContent;
  visibility?: ResourceVisibility;
  metadata?: Record<string, unknown>;
}

export function updateTeamTemplate(
  id: string,
  input: UpdateTeamTemplateInput,
): TeamTemplateResource | null {
  const existing = getTeamTemplate(id);
  if (!existing) return null;

  // Merge metadata: existing metadata ← caller's metadata ← new content.
  // This keeps non-content keys (e.g. publisher info added later) intact
  // while letting callers overwrite `metadata.content` either implicitly
  // (via `input.content`) or explicitly (via `input.metadata.content`).
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
  return (updated as TeamTemplateResource | null) ?? null;
}

export function deleteTeamTemplate(id: string): boolean {
  const existing = getTeamTemplate(id);
  if (!existing) return false;
  return resources.deleteResource(id);
}
