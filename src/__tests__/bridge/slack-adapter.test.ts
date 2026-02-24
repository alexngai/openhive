import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackAdapter } from '../../bridge/adapters/slack.js';
import type { InboundMessage } from '../../bridge/types.js';

// Mock @slack/socket-mode
vi.mock('@slack/socket-mode', () => ({
  SocketModeClient: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock @slack/web-api
const mockPostMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1234567890.123456' });
const mockUsersInfo = vi.fn().mockResolvedValue({
  ok: true,
  user: {
    id: 'U0USER1',
    name: 'testuser',
    real_name: 'Test User',
    profile: {
      display_name: 'Test User',
      image_72: 'https://example.com/avatar.png',
    },
  },
});

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    chat: { postMessage: mockPostMessage },
    users: { info: mockUsersInfo },
  })),
}));

describe('SlackAdapter', () => {
  let adapter: SlackAdapter;

  beforeEach(() => {
    adapter = new SlackAdapter();
    mockPostMessage.mockClear();
    mockUsersInfo.mockClear();
  });

  it('has correct platform identifier', () => {
    expect(adapter.platform).toBe('slack');
  });

  // ── Connection ──

  it('connects in outbound mode (Socket Mode)', async () => {
    await adapter.connect({
      mode: 'outbound',
      credentials: {
        bot_token: 'xoxb-test',
        app_token: 'xapp-test',
      },
      channelMappings: [],
    });

    // Should not throw
    await adapter.disconnect();
  });

  it('connects in webhook mode without app_token', async () => {
    await adapter.connect({
      mode: 'webhook',
      credentials: {
        bot_token: 'xoxb-test',
      },
      channelMappings: [],
    });

    await adapter.disconnect();
  });

  it('throws if bot_token is missing', async () => {
    await expect(adapter.connect({
      mode: 'outbound',
      credentials: {},
      channelMappings: [],
    })).rejects.toThrow('bot_token');
  });

  it('throws if app_token missing in outbound mode', async () => {
    await expect(adapter.connect({
      mode: 'outbound',
      credentials: { bot_token: 'xoxb-test' },
      channelMappings: [],
    })).rejects.toThrow('app_token');
  });

  // ── Message pushing (webhook mode flow) ──

  it('pushes and consumes inbound messages', async () => {
    await adapter.connect({
      mode: 'webhook',
      credentials: { bot_token: 'xoxb-test' },
      channelMappings: [],
    });

    const testMessage: InboundMessage = {
      platformMessageId: '1234.5678',
      platform: 'slack',
      platformChannelId: 'C0ABC123',
      author: {
        platformUserId: 'U0USER1',
        displayName: 'Test User',
      },
      content: { text: 'Hello from Slack' },
      timestamp: new Date().toISOString(),
      platformMeta: {},
    };

    adapter.pushInboundMessage(testMessage);

    const iterator = adapter.messages()[Symbol.asyncIterator]();
    const result = await iterator.next();

    expect(result.done).toBe(false);
    expect(result.value.content.text).toBe('Hello from Slack');
    expect(result.value.platformMessageId).toBe('1234.5678');

    await adapter.disconnect();
  });

  it('queues messages when no consumer is waiting', async () => {
    await adapter.connect({
      mode: 'webhook',
      credentials: { bot_token: 'xoxb-test' },
      channelMappings: [],
    });

    // Push multiple messages before consuming
    adapter.pushInboundMessage({
      platformMessageId: 'msg1',
      platform: 'slack',
      platformChannelId: 'C1',
      author: { platformUserId: 'U1', displayName: 'User 1' },
      content: { text: 'First' },
      timestamp: new Date().toISOString(),
      platformMeta: {},
    });
    adapter.pushInboundMessage({
      platformMessageId: 'msg2',
      platform: 'slack',
      platformChannelId: 'C1',
      author: { platformUserId: 'U1', displayName: 'User 1' },
      content: { text: 'Second' },
      timestamp: new Date().toISOString(),
      platformMeta: {},
    });

    const iterator = adapter.messages()[Symbol.asyncIterator]();
    const r1 = await iterator.next();
    const r2 = await iterator.next();

    expect(r1.value.content.text).toBe('First');
    expect(r2.value.content.text).toBe('Second');

    await adapter.disconnect();
  });

  it('ends message stream on disconnect', async () => {
    await adapter.connect({
      mode: 'webhook',
      credentials: { bot_token: 'xoxb-test' },
      channelMappings: [],
    });

    const iterator = adapter.messages()[Symbol.asyncIterator]();

    // Start waiting for a message
    const promise = iterator.next();

    // Disconnect should resolve the pending promise as done
    await adapter.disconnect();

    const result = await promise;
    expect(result.done).toBe(true);
  });

  // ── Sending messages ──

  it('sends a message to Slack', async () => {
    await adapter.connect({
      mode: 'webhook',
      credentials: { bot_token: 'xoxb-test' },
      channelMappings: [],
    });

    await adapter.send(
      { platformChannelId: 'C0ABC123' },
      { text: 'Hello from OpenHive' },
    );

    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: 'C0ABC123',
      text: 'Hello from OpenHive',
      thread_ts: undefined,
      unfurl_links: false,
    });

    await adapter.disconnect();
  });

  it('sends a threaded reply', async () => {
    await adapter.connect({
      mode: 'webhook',
      credentials: { bot_token: 'xoxb-test' },
      channelMappings: [],
    });

    await adapter.send(
      { platformChannelId: 'C0ABC123', threadId: '1234567890.001200' },
      { text: 'Thread reply' },
    );

    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: 'C0ABC123',
      text: 'Thread reply',
      thread_ts: '1234567890.001200',
      unfurl_links: false,
    });

    await adapter.disconnect();
  });

  it('converts markdown to mrkdwn when sending', async () => {
    await adapter.connect({
      mode: 'webhook',
      credentials: { bot_token: 'xoxb-test' },
      channelMappings: [],
    });

    await adapter.send(
      { platformChannelId: 'C1' },
      { text: '**bold** and ~~strike~~ and [link](https://example.com)' },
    );

    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: '*bold* and ~strike~ and <https://example.com|link>',
    }));

    await adapter.disconnect();
  });

  it('throws when sending without connection', async () => {
    await expect(
      adapter.send({ platformChannelId: 'C1' }, { text: 'test' })
    ).rejects.toThrow('not connected');
  });

  // ── Ignored messages after disconnect ──

  it('ignores pushInboundMessage after disconnect', async () => {
    await adapter.connect({
      mode: 'webhook',
      credentials: { bot_token: 'xoxb-test' },
      channelMappings: [],
    });

    await adapter.disconnect();

    // Should not throw
    adapter.pushInboundMessage({
      platformMessageId: 'ignored',
      platform: 'slack',
      platformChannelId: 'C1',
      author: { platformUserId: 'U1', displayName: 'User' },
      content: { text: 'ignored' },
      timestamp: new Date().toISOString(),
      platformMeta: {},
    });
  });
});
