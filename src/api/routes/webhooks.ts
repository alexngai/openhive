import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import * as memoryBanksDAL from '../../db/dal/memory-banks.js';
import { broadcastToChannel } from '../../realtime/index.js';

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

export async function webhooksRoutes(fastify: FastifyInstance): Promise<void> {
  // Git webhook endpoint
  fastify.post<{
    Params: { bankId: string };
  }>(
    '/webhooks/git/:bankId',
    async (request: FastifyRequest<{ Params: { bankId: string } }>, reply: FastifyReply) => {
      const { bankId } = request.params;

      // Find the memory bank
      const bank = memoryBanksDAL.findMemoryBankById(bankId);
      if (!bank) {
        return reply.status(404).send({ error: 'Memory bank not found' });
      }

      if (!bank.webhook_secret) {
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
            bank.webhook_secret
          );
          break;
        case 'gitlab':
          isValid = verifyGitLabToken(
            headers['x-gitlab-token'] as string | undefined,
            bank.webhook_secret
          );
          break;
        case 'gitea':
          isValid = verifyGiteaSignature(
            rawBody,
            headers['x-gitea-signature'] as string | undefined,
            bank.webhook_secret
          );
          break;
        default:
          // Unknown host - try all methods
          isValid =
            verifyGitHubSignature(rawBody, headers['x-hub-signature-256'] as string | undefined, bank.webhook_secret) ||
            verifyGitLabToken(headers['x-gitlab-token'] as string | undefined, bank.webhook_secret) ||
            verifyGiteaSignature(rawBody, headers['x-gitea-signature'] as string | undefined, bank.webhook_secret);
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

      // Update memory bank sync state
      memoryBanksDAL.updateMemoryBankSyncState(
        bankId,
        pushInfo.commitHash,
        pushInfo.pusher
      );

      // Create sync event
      const syncEvent = memoryBanksDAL.createSyncEvent({
        bank_id: bankId,
        commit_hash: pushInfo.commitHash,
        commit_message: pushInfo.commitMessage || undefined,
        pusher: pushInfo.pusher || undefined,
        files_added: pushInfo.filesAdded,
        files_modified: pushInfo.filesModified,
        files_removed: pushInfo.filesRemoved,
      });

      // Broadcast to WebSocket subscribers
      broadcastToChannel(`memory-bank:${bankId}`, {
        type: 'memory_bank_updated',
        data: {
          bank_id: bankId,
          bank_name: bank.name,
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
}
