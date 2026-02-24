/**
 * Slack Bridge Adapter
 *
 * Implements the BridgeAdapter interface for Slack using:
 * - Socket Mode (outbound transport) via @slack/socket-mode
 * - Web API (sending messages) via @slack/web-api
 *
 * Webhook mode (Events API) is handled externally via the
 * bridge webhook route; this adapter focuses on Socket Mode
 * for outbound transport and Web API for message sending.
 */

import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import type {
  BridgeAdapter,
  AdapterConfig,
  InboundMessage,
  OutboundMessage,
  PlatformDestination,
} from '../types.js';

// ============================================================================
// Types
// ============================================================================

interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  files?: Array<{
    url_private: string;
    name: string;
    mimetype: string;
  }>;
  bot_id?: string;
}

interface SlackUserInfo {
  id: string;
  name: string;
  real_name?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
    image_48?: string;
    image_72?: string;
  };
}

// ============================================================================
// Slack Adapter
// ============================================================================

export class SlackAdapter implements BridgeAdapter {
  readonly platform = 'slack';

  private socketClient: SocketModeClient | null = null;
  private webClient: WebClient | null = null;
  private messageQueue: InboundMessage[] = [];
  private messageResolve: ((value: IteratorResult<InboundMessage>) => void) | null = null;
  private closed = false;
  private userCache = new Map<string, SlackUserInfo>();
  private mappedChannelIds = new Set<string>();

  async connect(config: AdapterConfig): Promise<void> {
    const botToken = config.credentials.bot_token;
    const appToken = config.credentials.app_token;

    if (!botToken) {
      throw new Error('Slack adapter requires bot_token credential');
    }

    this.webClient = new WebClient(botToken);

    // Build set of channels we care about
    for (const mapping of config.channelMappings) {
      this.mappedChannelIds.add(mapping.platform_channel_id);
    }

    if (config.mode === 'outbound') {
      if (!appToken) {
        throw new Error('Slack Socket Mode requires app_token credential');
      }

      this.socketClient = new SocketModeClient({ appToken });

      // Listen for message events
      this.socketClient.on('message', async ({ event, ack }) => {
        await ack();
        await this.handleMessageEvent(event as SlackMessageEvent);
      });

      // Start Socket Mode connection
      await this.socketClient.start();
    }
    // Webhook mode: messages are pushed via pushInboundMessage() from the webhook route
  }

  messages(): AsyncIterable<InboundMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<InboundMessage>> {
            if (self.closed) {
              return Promise.resolve({ done: true, value: undefined });
            }
            if (self.messageQueue.length > 0) {
              return Promise.resolve({ done: false, value: self.messageQueue.shift()! });
            }
            return new Promise((resolve) => {
              self.messageResolve = resolve;
            });
          },
        };
      },
    };
  }

  async send(destination: PlatformDestination, message: OutboundMessage): Promise<void> {
    if (!this.webClient) {
      throw new Error('Slack adapter not connected');
    }

    const text = convertMarkdownToMrkdwn(message.text);

    await this.webClient.chat.postMessage({
      channel: destination.platformChannelId,
      text,
      thread_ts: destination.threadId,
      unfurl_links: false,
    });
  }

  async disconnect(): Promise<void> {
    this.closed = true;

    if (this.socketClient) {
      await this.socketClient.disconnect();
      this.socketClient = null;
    }

    // Resolve any pending message iterator
    if (this.messageResolve) {
      this.messageResolve({ done: true, value: undefined });
      this.messageResolve = null;
    }

    this.webClient = null;
  }

  /**
   * Push an inbound message from an external source (webhook route).
   * Used in webhook mode where the adapter doesn't own the transport.
   */
  pushInboundMessage(message: InboundMessage): void {
    if (this.closed) return;

    if (this.messageResolve) {
      this.messageResolve({ done: false, value: message });
      this.messageResolve = null;
    } else {
      this.messageQueue.push(message);
    }
  }

  // ── Internal ──

  private async handleMessageEvent(event: SlackMessageEvent): Promise<void> {
    // Skip bot messages and message subtypes (edits, deletes, etc.)
    if (event.bot_id || (event.subtype && event.subtype !== 'file_share')) {
      return;
    }

    // Skip if channel is not in our mapped set
    if (!this.mappedChannelIds.has(event.channel)) {
      return;
    }

    if (!event.user || !event.text) {
      return;
    }

    // Resolve user info
    const userInfo = await this.resolveUser(event.user);
    const displayName = userInfo?.profile?.display_name
      || userInfo?.profile?.real_name
      || userInfo?.real_name
      || userInfo?.name
      || event.user;
    const avatarUrl = userInfo?.profile?.image_72 || userInfo?.profile?.image_48;

    // Resolve mentions in message text: <@U0XYZ789> → display name
    const { text, mentions } = await this.resolveMentions(event.text);

    const message: InboundMessage = {
      platformMessageId: event.ts,
      platform: 'slack',
      platformChannelId: event.channel,
      author: {
        platformUserId: event.user,
        displayName,
        avatarUrl,
      },
      content: {
        text,
        attachments: event.files?.map(f => ({
          type: 'file' as const,
          url: f.url_private,
          name: f.name,
          mimeType: f.mimetype,
        })),
      },
      timestamp: new Date(parseFloat(event.ts) * 1000).toISOString(),
      mentions: mentions.length > 0 ? mentions : undefined,
      platformMeta: {
        ts: event.ts,
        thread_ts: event.thread_ts,
        channel: event.channel,
      },
    };

    // Set thread info if this is a threaded reply
    if (event.thread_ts && event.thread_ts !== event.ts) {
      message.thread = {
        parentMessageId: event.thread_ts,
      };
    }

    this.pushInboundMessage(message);
  }

  private async resolveUser(userId: string): Promise<SlackUserInfo | null> {
    // Check cache
    const cached = this.userCache.get(userId);
    if (cached) return cached;

    if (!this.webClient) return null;

    try {
      const result = await this.webClient.users.info({ user: userId });
      if (result.ok && result.user) {
        const userInfo = result.user as unknown as SlackUserInfo;
        this.userCache.set(userId, userInfo);
        return userInfo;
      }
    } catch {
      // Failed to resolve user, return null
    }

    return null;
  }

  /**
   * Resolve Slack-style mentions (<@U0XYZ789>) to display names.
   * Returns the cleaned text and an array of resolved mention names.
   */
  private async resolveMentions(text: string): Promise<{ text: string; mentions: string[] }> {
    const mentionPattern = /<@(U[A-Z0-9]+)>/g;
    const mentions: string[] = [];
    let resolvedText = text;

    const matches = [...text.matchAll(mentionPattern)];
    for (const match of matches) {
      const userId = match[1];
      const userInfo = await this.resolveUser(userId);
      const displayName = userInfo?.profile?.display_name
        || userInfo?.real_name
        || userInfo?.name
        || userId;

      mentions.push(displayName.toLowerCase());
      resolvedText = resolvedText.replace(match[0], `@${displayName}`);
    }

    return { text: resolvedText, mentions };
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert standard markdown to Slack mrkdwn format.
 * Slack uses *bold* instead of **bold**, and ~strike~ instead of ~~strike~~.
 */
function convertMarkdownToMrkdwn(markdown: string): string {
  let text = markdown;

  // **bold** → *bold*
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // ~~strike~~ → ~strike~
  text = text.replace(/~~(.+?)~~/g, '~$1~');

  // [text](url) → <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  return text;
}
