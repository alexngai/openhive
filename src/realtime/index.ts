import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { findAgentByApiKey } from '../db/dal/agents.js';
import { findHiveByName, isHiveMember } from '../db/dal/hives.js';
import type { Agent, WSMessage, WSEvent } from '../types.js';

interface ClientConnection {
  ws: WebSocket;
  agent: Agent | null;
  channels: Set<string>;
  lastPing: number;
}

// Global state for WebSocket connections
const clients: Map<WebSocket, ClientConnection> = new Map();
const channelSubscribers: Map<string, Set<WebSocket>> = new Map();

// Heartbeat interval (30 seconds)
const HEARTBEAT_INTERVAL = 30000;
let heartbeatTimer: NodeJS.Timeout | null = null;

export function setupWebSocket(fastify: FastifyInstance): void {
  fastify.get('/ws', { websocket: true }, async (socket, request) => {
    const ws = socket as unknown as WebSocket;

    // Authenticate via query param
    const token = (request.query as { token?: string }).token;
    let agent: Agent | null = null;

    if (token) {
      agent = await findAgentByApiKey(token);
    }

    // Create client connection
    const client: ClientConnection = {
      ws,
      agent,
      channels: new Set(),
      lastPing: Date.now(),
    };

    clients.set(ws, client);

    // Send welcome message
    sendToClient(ws, {
      type: 'agent_online',
      data: {
        authenticated: !!agent,
        agent_id: agent?.id,
        agent_name: agent?.name,
      },
      timestamp: new Date().toISOString(),
    });

    // Handle messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as WSMessage;
        handleMessage(ws, client, message);
      } catch {
        sendToClient(ws, {
          type: 'agent_offline',
          data: { error: 'Invalid message format' },
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Handle close
    ws.on('close', () => {
      // Unsubscribe from all channels
      for (const channel of client.channels) {
        unsubscribeFromChannel(ws, channel);
      }

      // Remove client
      clients.delete(ws);

      // Broadcast offline if authenticated
      if (agent) {
        broadcast({
          type: 'agent_offline',
          data: { agent_id: agent.id },
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Handle errors
    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });

  // Start heartbeat
  startHeartbeat();
}

function handleMessage(ws: WebSocket, client: ClientConnection, message: WSMessage): void {
  switch (message.type) {
    case 'subscribe':
      if (message.channels) {
        const subscribed: string[] = [];
        const denied: string[] = [];

        for (const channel of message.channels) {
          // NEW-5: Check hive membership before allowing subscription to hive channels
          if (channel.startsWith('hive:')) {
            const hiveName = channel.slice(5); // strip "hive:" prefix
            const hive = findHiveByName(hiveName);
            if (hive && !hive.is_public) {
              // Private hive — require authenticated agent with membership
              if (!client.agent || !isHiveMember(hive.id, client.agent.id)) {
                denied.push(channel);
                continue;
              }
            }
          }

          subscribeToChannel(ws, channel);
          client.channels.add(channel);
          subscribed.push(channel);
        }

        sendToClient(ws, {
          type: 'agent_online',
          data: {
            subscribed,
            ...(denied.length > 0 ? { denied } : {}),
            current_channels: Array.from(client.channels),
          },
          timestamp: new Date().toISOString(),
        });
      }
      break;

    case 'unsubscribe':
      if (message.channels) {
        for (const channel of message.channels) {
          unsubscribeFromChannel(ws, channel);
          client.channels.delete(channel);
        }
        sendToClient(ws, {
          type: 'agent_online',
          data: {
            unsubscribed: message.channels,
            current_channels: Array.from(client.channels),
          },
          timestamp: new Date().toISOString(),
        });
      }
      break;

    case 'ping':
      client.lastPing = Date.now();
      sendToClient(ws, {
        type: 'agent_online',
        data: { pong: true },
        timestamp: new Date().toISOString(),
      });
      break;
  }
}

function subscribeToChannel(ws: WebSocket, channel: string): void {
  let subscribers = channelSubscribers.get(channel);
  if (!subscribers) {
    subscribers = new Set();
    channelSubscribers.set(channel, subscribers);
  }
  subscribers.add(ws);
}

function unsubscribeFromChannel(ws: WebSocket, channel: string): void {
  const subscribers = channelSubscribers.get(channel);
  if (subscribers) {
    subscribers.delete(ws);
    if (subscribers.size === 0) {
      channelSubscribers.delete(channel);
    }
  }
}

function sendToClient(ws: WebSocket, event: WSEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

export function broadcastToChannel(channel: string, event: Omit<WSEvent, 'timestamp' | 'channel'>): void {
  const subscribers = channelSubscribers.get(channel);
  if (!subscribers) return;

  const fullEvent: WSEvent = {
    ...event,
    channel,
    timestamp: new Date().toISOString(),
  } as WSEvent;

  const message = JSON.stringify(fullEvent);

  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

export function broadcast(event: WSEvent): void {
  const message = JSON.stringify(event);

  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

function startHeartbeat(): void {
  if (heartbeatTimer) return;

  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    const timeout = HEARTBEAT_INTERVAL * 2;

    for (const [ws, client] of clients) {
      if (now - client.lastPing > timeout) {
        // Client hasn't responded to ping, close connection
        ws.terminate();
        clients.delete(ws);
      } else if (ws.readyState === WebSocket.OPEN) {
        // Send ping
        sendToClient(ws, {
          type: 'agent_online',
          data: { ping: true },
          timestamp: new Date().toISOString(),
        });
      }
    }
  }, HEARTBEAT_INTERVAL);
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export function getConnectedClients(): number {
  return clients.size;
}

export function getChannelSubscriberCount(channel: string): number {
  return channelSubscribers.get(channel)?.size || 0;
}
