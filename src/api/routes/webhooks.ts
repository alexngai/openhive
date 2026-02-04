import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { broadcastToChannel } from '../../realtime/index.js';
import type { Config } from '../../config.js';

// Webhook payload types for different git hosts
interface GitHubPushPayload {
  ref: string;
  after: string;
  pusher?: { name?: string; email?: string };
  commits?: Array<{
    id: string;
    message: string;
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
}

interface GitLabPushPayload {
  ref: string;
  after: string;
  user_name?: string;
  commits?: Array<{
    id: string;
    message: string;
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
}

interface GiteaPushPayload {
  ref: string;
  after: string;
  pusher?: { login?: string; username?: string };
  commits?: Array<{
    id: string;
    message: string;
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
}

type WebhookPayload = GitHubPushPayload | GitLabPushPayload | GiteaPushPayload;

// GitHub App specific payload (includes repository info)
interface GitHubAppPushPayload extends GitHubPushPayload {
  repository: {
    id: number;
    full_name: string;
    html_url: string;
    clone_url: string;
    ssh_url: string;
  };
  installation?: {
    id: number;
  };
}

interface GitHubAppInstallationPayload {
  action: 'created' | 'deleted' | 'added' | 'removed' | 'suspend' | 'unsuspend';
  installation: {
    id: number;
    account: {
      login: string;
      type: 'User' | 'Organization';
    };
  };
  repositories?: Array<{
    id: number;
    full_name: string;
  }>;
  repositories_added?: Array<{
    id: number;
    full_name: string;
  }>;
  repositories_removed?: Array<{
    id: number;
    full_name: string;
  }>;
}

// Verify GitHub webhook signature
function verifyGitHubSignature(
  payload: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) return false;

  const expectedSignature = `sha256=${createHmac('sha256', secret)
    .update(payload)
    .digest('hex')}`;

  try {
    return timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}

// Verify GitLab webhook token
function verifyGitLabToken(
  token: string | undefined,
  secret: string
): boolean {
  if (!token) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(secret));
  } catch {
    return false;
  }
}

// Verify Gitea webhook signature
function verifyGiteaSignature(
  payload: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) return false;

  const expectedSignature = createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  try {
    return timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}

// Detect git host from headers
function detectGitHost(headers: Record<string, unknown>): 'github' | 'gitlab' | 'gitea' | 'unknown' {
  if (headers['x-github-event']) return 'github';
  if (headers['x-gitlab-event']) return 'gitlab';
  if (headers['x-gitea-event']) return 'gitea';
  return 'unknown';
}

// Extract push info from payload
function extractPushInfo(payload: WebhookPayload, gitHost: string): {
  commitHash: string;
  commitMessage: string | null;
  pusher: string | null;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
} {
  const commits = payload.commits || [];

  let filesAdded = 0;
  let filesModified = 0;
  let filesRemoved = 0;

  for (const commit of commits) {
    filesAdded += commit.added?.length || 0;
    filesModified += commit.modified?.length || 0;
    filesRemoved += commit.removed?.length || 0;
  }

  const lastCommit = commits[commits.length - 1];
  const commitMessage = lastCommit?.message?.split('\n')[0] || null;

  let pusher: string | null = null;
  if (gitHost === 'github') {
    pusher = (payload as GitHubPushPayload).pusher?.name || null;
  } else if (gitHost === 'gitlab') {
    pusher = (payload as GitLabPushPayload).user_name || null;
  } else if (gitHost === 'gitea') {
    const giteaPayload = payload as GiteaPushPayload;
    pusher = giteaPayload.pusher?.login || giteaPayload.pusher?.username || null;
  }

  return {
    commitHash: payload.after,
    commitMessage,
    pusher,
    filesAdded,
    filesModified,
    filesRemoved,
  };
}

export async function webhooksRoutes(
  fastify: FastifyInstance,
  options?: { config?: Config }
): Promise<void> {
  const config = options?.config;

  // ============================================================================
  // Legacy Git webhook endpoint (for backward compatibility)
  // Redirects to /webhooks/resource/:resourceId internally
  // ============================================================================

  fastify.post<{
    Params: { bankId: string };
  }>(
    '/webhooks/git/:bankId',
    async (request: FastifyRequest<{ Params: { bankId: string } }>, reply: FastifyReply) => {
      const { bankId } = request.params;

      // Find the resource (memory banks are now resources)
      const resource = resourcesDAL.findResourceById(bankId);
      if (!resource) {
        return reply.status(404).send({ error: 'Memory bank not found' });
      }

      if (!resource.webhook_secret) {
        return reply.status(400).send({ error: 'Webhook secret not configured' });
      }

      // Get raw body for signature verification
      const rawBody = JSON.stringify(request.body);
      const headers = request.headers as Record<string, unknown>;

      // Detect git host and verify signature
      const gitHost = detectGitHost(headers);
      let isValid = false;

      switch (gitHost) {
        case 'github':
          isValid = verifyGitHubSignature(
            rawBody,
            headers['x-hub-signature-256'] as string | undefined,
            resource.webhook_secret
          );
          break;
        case 'gitlab':
          isValid = verifyGitLabToken(
            headers['x-gitlab-token'] as string | undefined,
            resource.webhook_secret
          );
          break;
        case 'gitea':
          isValid = verifyGiteaSignature(
            rawBody,
            headers['x-gitea-signature'] as string | undefined,
            resource.webhook_secret
          );
          break;
        default:
          // Unknown host - try all methods
          isValid =
            verifyGitHubSignature(rawBody, headers['x-hub-signature-256'] as string | undefined, resource.webhook_secret) ||
            verifyGitLabToken(headers['x-gitlab-token'] as string | undefined, resource.webhook_secret) ||
            verifyGiteaSignature(rawBody, headers['x-gitea-signature'] as string | undefined, resource.webhook_secret);
      }

      if (!isValid) {
        return reply.status(401).send({ error: 'Invalid webhook signature' });
      }

      // Check if this is a push event
      const eventType =
        headers['x-github-event'] ||
        headers['x-gitlab-event'] ||
        headers['x-gitea-event'];

      // Only process push events
      if (eventType !== 'push' && eventType !== 'Push Hook') {
        return reply.status(200).send({ ok: true, skipped: true, reason: 'Not a push event' });
      }

      const payload = request.body as WebhookPayload;

      // Extract push information
      const pushInfo = extractPushInfo(payload, gitHost);

      // Update resource sync state
      resourcesDAL.updateResourceSyncState(
        bankId,
        pushInfo.commitHash,
        pushInfo.pusher
      );

      // Create sync event
      const syncEvent = resourcesDAL.createSyncEvent({
        resource_id: bankId,
        commit_hash: pushInfo.commitHash,
        commit_message: pushInfo.commitMessage || undefined,
        pusher: pushInfo.pusher || undefined,
        files_added: pushInfo.filesAdded,
        files_modified: pushInfo.filesModified,
        files_removed: pushInfo.filesRemoved,
      });

      // Broadcast to WebSocket subscribers (use legacy channel for backward compatibility)
      broadcastToChannel(`memory-bank:${bankId}`, {
        type: 'memory_bank_updated',
        data: {
          bank_id: bankId,
          bank_name: resource.name,
          commit_hash: pushInfo.commitHash,
          commit_message: pushInfo.commitMessage,
          pusher: pushInfo.pusher,
          files_added: pushInfo.filesAdded,
          files_modified: pushInfo.filesModified,
          files_removed: pushInfo.filesRemoved,
          event_id: syncEvent.id,
        },
      });

      return reply.status(200).send({ ok: true, event_id: syncEvent.id });
    }
  );

  // ============================================================================
  // Generic Resource Webhook Endpoint
  // Supports all syncable resource types (memory banks, tasks, skills, etc.)
  // ============================================================================

  fastify.post<{
    Params: { resourceId: string };
  }>(
    '/webhooks/resource/:resourceId',
    async (request: FastifyRequest<{ Params: { resourceId: string } }>, reply: FastifyReply) => {
      const { resourceId } = request.params;

      // Find the resource
      const resource = resourcesDAL.findResourceById(resourceId);
      if (!resource) {
        return reply.status(404).send({ error: 'Resource not found' });
      }

      if (!resource.webhook_secret) {
        return reply.status(400).send({ error: 'Webhook secret not configured' });
      }

      // Get raw body for signature verification
      const rawBody = JSON.stringify(request.body);
      const headers = request.headers as Record<string, unknown>;

      // Detect git host and verify signature
      const gitHost = detectGitHost(headers);
      let isValid = false;

      switch (gitHost) {
        case 'github':
          isValid = verifyGitHubSignature(
            rawBody,
            headers['x-hub-signature-256'] as string | undefined,
            resource.webhook_secret
          );
          break;
        case 'gitlab':
          isValid = verifyGitLabToken(
            headers['x-gitlab-token'] as string | undefined,
            resource.webhook_secret
          );
          break;
        case 'gitea':
          isValid = verifyGiteaSignature(
            rawBody,
            headers['x-gitea-signature'] as string | undefined,
            resource.webhook_secret
          );
          break;
        default:
          // Unknown host - try all methods
          isValid =
            verifyGitHubSignature(rawBody, headers['x-hub-signature-256'] as string | undefined, resource.webhook_secret) ||
            verifyGitLabToken(headers['x-gitlab-token'] as string | undefined, resource.webhook_secret) ||
            verifyGiteaSignature(rawBody, headers['x-gitea-signature'] as string | undefined, resource.webhook_secret);
      }

      if (!isValid) {
        return reply.status(401).send({ error: 'Invalid webhook signature' });
      }

      // Check if this is a push event
      const eventType =
        headers['x-github-event'] ||
        headers['x-gitlab-event'] ||
        headers['x-gitea-event'];

      // Only process push events
      if (eventType !== 'push' && eventType !== 'Push Hook') {
        return reply.status(200).send({ ok: true, skipped: true, reason: 'Not a push event' });
      }

      const payload = request.body as WebhookPayload;

      // Extract push information
      const pushInfo = extractPushInfo(payload, gitHost);

      // Update resource sync state
      resourcesDAL.updateResourceSyncState(
        resourceId,
        pushInfo.commitHash,
        pushInfo.pusher
      );

      // Create sync event
      const syncEvent = resourcesDAL.createSyncEvent({
        resource_id: resourceId,
        commit_hash: pushInfo.commitHash,
        commit_message: pushInfo.commitMessage || undefined,
        pusher: pushInfo.pusher || undefined,
        files_added: pushInfo.filesAdded,
        files_modified: pushInfo.filesModified,
        files_removed: pushInfo.filesRemoved,
      });

      // Broadcast to WebSocket subscribers using resource-specific channel
      const channel = resourcesDAL.getResourceChannel(resource);
      broadcastToChannel(channel, {
        type: 'resource_updated',
        data: {
          resource_id: resourceId,
          resource_type: resource.resource_type,
          resource_name: resource.name,
          commit_hash: pushInfo.commitHash,
          commit_message: pushInfo.commitMessage,
          pusher: pushInfo.pusher,
          files_added: pushInfo.filesAdded,
          files_modified: pushInfo.filesModified,
          files_removed: pushInfo.filesRemoved,
          event_id: syncEvent.id,
        },
      });

      // Also broadcast to legacy memory-bank channel for backward compatibility
      if (resource.resource_type === 'memory_bank') {
        broadcastToChannel(`memory-bank:${resourceId}`, {
          type: 'memory_bank_updated',
          data: {
            bank_id: resourceId,
            bank_name: resource.name,
            commit_hash: pushInfo.commitHash,
            commit_message: pushInfo.commitMessage,
            pusher: pushInfo.pusher,
            files_added: pushInfo.filesAdded,
            files_modified: pushInfo.filesModified,
            files_removed: pushInfo.filesRemoved,
            event_id: syncEvent.id,
          },
        });
      }

      return reply.status(200).send({
        ok: true,
        resource_type: resource.resource_type,
        event_id: syncEvent.id,
      });
    }
  );

  // ============================================================================
  // GitHub App Webhook Endpoint
  // Receives events for ALL repositories where the app is installed
  // ============================================================================

  fastify.post(
    '/webhooks/github-app',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Check if GitHub App is configured
      if (!config?.githubApp?.enabled || !config.githubApp.webhookSecret) {
        return reply.status(404).send({ error: 'GitHub App not configured' });
      }

      const rawBody = JSON.stringify(request.body);
      const headers = request.headers as Record<string, unknown>;

      // Verify GitHub signature
      const signature = headers['x-hub-signature-256'] as string | undefined;
      if (!verifyGitHubSignature(rawBody, signature, config.githubApp.webhookSecret)) {
        return reply.status(401).send({ error: 'Invalid webhook signature' });
      }

      const eventType = headers['x-github-event'] as string;

      // Handle installation events (for logging/debugging)
      if (eventType === 'installation' || eventType === 'installation_repositories') {
        const payload = request.body as GitHubAppInstallationPayload;
        console.log(`GitHub App installation event: ${payload.action} for ${payload.installation.account.login}`);

        // Could track installations in database if needed
        return reply.status(200).send({
          ok: true,
          event: eventType,
          action: payload.action,
          account: payload.installation.account.login,
        });
      }

      // Handle push events
      if (eventType === 'push') {
        const payload = request.body as GitHubAppPushPayload;

        if (!payload.repository) {
          return reply.status(400).send({ error: 'Missing repository in payload' });
        }

        const repoFullName = payload.repository.full_name;
        const pushInfo = extractPushInfo(payload, 'github');

        // Find all resources matching this repository
        const matchingResources = resourcesDAL.findResourcesByRepoUrl(
          `github.com/${repoFullName}`
        );

        if (matchingResources.length === 0) {
          // No registered resources for this repo - that's okay
          return reply.status(200).send({
            ok: true,
            skipped: true,
            reason: `No resources registered for ${repoFullName}`,
          });
        }

        const resourceResults = [];

        // Process each matching resource
        for (const resource of matchingResources) {
          // Update resource sync state
          resourcesDAL.updateResourceSyncState(
            resource.id,
            pushInfo.commitHash,
            pushInfo.pusher
          );

          // Create sync event
          const syncEvent = resourcesDAL.createSyncEvent({
            resource_id: resource.id,
            commit_hash: pushInfo.commitHash,
            commit_message: pushInfo.commitMessage || undefined,
            pusher: pushInfo.pusher || undefined,
            files_added: pushInfo.filesAdded,
            files_modified: pushInfo.filesModified,
            files_removed: pushInfo.filesRemoved,
          });

          // Broadcast to WebSocket subscribers
          const channel = resourcesDAL.getResourceChannel(resource);
          broadcastToChannel(channel, {
            type: 'resource_updated',
            data: {
              resource_id: resource.id,
              resource_type: resource.resource_type,
              resource_name: resource.name,
              commit_hash: pushInfo.commitHash,
              commit_message: pushInfo.commitMessage,
              pusher: pushInfo.pusher,
              files_added: pushInfo.filesAdded,
              files_modified: pushInfo.filesModified,
              files_removed: pushInfo.filesRemoved,
              event_id: syncEvent.id,
            },
          });

          // Also broadcast to legacy memory-bank channel for backward compatibility
          if (resource.resource_type === 'memory_bank') {
            broadcastToChannel(`memory-bank:${resource.id}`, {
              type: 'memory_bank_updated',
              data: {
                bank_id: resource.id,
                bank_name: resource.name,
                commit_hash: pushInfo.commitHash,
                commit_message: pushInfo.commitMessage,
                pusher: pushInfo.pusher,
                files_added: pushInfo.filesAdded,
                files_modified: pushInfo.filesModified,
                files_removed: pushInfo.filesRemoved,
                event_id: syncEvent.id,
              },
            });
          }

          resourceResults.push({
            resource_id: resource.id,
            resource_type: resource.resource_type,
            event_id: syncEvent.id,
          });
        }

        return reply.status(200).send({
          ok: true,
          repository: repoFullName,
          resources_notified: resourceResults.length,
          results: resourceResults,
        });
      }

      // Other events (ping, etc.) - acknowledge but don't process
      return reply.status(200).send({
        ok: true,
        event: eventType,
        message: 'Event acknowledged',
      });
    }
  );
}
