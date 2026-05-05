/**
 * DAL wrapper for `team_template` syncable resources.
 *
 * Mirror of loadouts.ts — thin typed layer over syncable-resources DAL.
 * Authored content (manifest, roles, loadouts, prompts) is stored in
 * metadata.content; openteams' TemplateLoader consumes the same shape at
 * resolution time.
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
  content: TeamTemplateContent;
  ownerAgentId: string;
  visibility?: ResourceVisibility;
  metadata?: Record<string, unknown>;
}

export function createTeamTemplate(input: CreateTeamTemplateInput): TeamTemplateResource {
  const created = resources.createResource({
    resource_type: 'team_template',
    name: input.name,
    description: input.description,
    git_remote_url: `local://team_template/${input.name}`,
    visibility: input.visibility,
    owner_agent_id: input.ownerAgentId,
    metadata: { ...(input.metadata ?? {}), content: input.content },
  });
  return created as TeamTemplateResource;
}

export function getTeamTemplate(id: string): TeamTemplateResource | null {
  const r = resources.findResourceById(id);
  if (!r || r.resource_type !== 'team_template') return null;
  return r as TeamTemplateResource;
}

export function getTeamTemplateByName(
  name: string,
  ownerAgentId: string,
): TeamTemplateResource | null {
  const r = resources.findResourceByName(ownerAgentId, 'team_template', name);
  return (r as TeamTemplateResource | null) ?? null;
}

/**
 * Extract authored team_template content from a resource's metadata.
 * Returns null if metadata is missing or malformed.
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
