/**
 * OpenTasks Client for OpenHive
 *
 * Connects to an existing OpenTasks daemon via Unix socket (JSON-RPC 2.0).
 * Falls back to reading graph.jsonl when the daemon is unavailable.
 *
 * OpenHive never manages the daemon lifecycle — connect only.
 */
import * as net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ============================================================================
// Types (replicated from OpenTasks to avoid hard dependency)
// ============================================================================

export interface OpenTasksNodeSummary {
  id: string;
  type: 'context' | 'task' | 'feedback' | 'external';
  title: string;
  status?: string;
  priority?: number;
  archived?: boolean;
}

export interface OpenTasksEdgeSummary {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
}

export interface OpenTasksQueryResult {
  items: OpenTasksNodeSummary[];
  total?: number;
}

export interface OpenTasksGraphSummary {
  node_count: number;
  edge_count: number;
  task_counts: {
    open: number;
    in_progress: number;
    blocked: number;
    closed: number;
  };
  context_count: number;
  feedback_count: number;
  ready_count: number;
}

// ============================================================================
// IPC Client (minimal JSON-RPC 2.0 over Unix socket)
// ============================================================================

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class IPCConnection {
  private socket: net.Socket | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';

  constructor(
    private readonly socketPath: string,
    private readonly timeout: number = 10000,
  ) {}

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      const connectTimeout = setTimeout(() => {
        sock.destroy();
        reject(new Error('Connection timed out'));
      }, this.timeout);

      sock.on('connect', () => {
        clearTimeout(connectTimeout);
        this.socket = sock;
        resolve();
      });
      sock.on('error', (err) => {
        clearTimeout(connectTimeout);
        reject(err);
      });
      sock.on('data', (data) => {
        this.buffer += data.toString();
        this.processBuffer();
      });
      sock.on('close', () => {
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('Connection closed'));
        }
        this.pending.clear();
        this.socket = null;
      });
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  async request<R = unknown>(method: string, params?: unknown): Promise<R> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Not connected to OpenTasks daemon');
    }
    const id = ++this.requestId;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, this.timeout);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.socket!.write(msg);
    });
  }

  private processBuffer(): void {
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        }
      } catch { /* ignore parse errors */ }
    }
  }
}

// ============================================================================
// OpenHive OpenTasks Client
// ============================================================================

export class OpenHiveOpenTasksClient {
  private ipc: IPCConnection | null = null;
  private readonly opentasksDir: string;

  constructor(resourcePath: string) {
    this.opentasksDir = resourcePath;
  }

  // ---- Daemon Connection ----

  private getSocketPath(): string | null {
    const configPath = join(this.opentasksDir, 'config.json');
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        const sockRelative = config.daemon?.socketPath || 'daemon.sock';
        return join(this.opentasksDir, sockRelative);
      } catch { /* fallthrough */ }
    }
    return join(this.opentasksDir, 'daemon.sock');
  }

  get connected(): boolean {
    return this.ipc?.connected === true;
  }

  async isDaemonRunning(): Promise<boolean> {
    const sockPath = this.getSocketPath();
    if (!sockPath || !existsSync(sockPath)) return false;
    try {
      const conn = new IPCConnection(sockPath, 3000);
      await conn.connect();
      conn.disconnect();
      return true;
    } catch {
      return false;
    }
  }

  async connectDaemon(): Promise<boolean> {
    const sockPath = this.getSocketPath();
    if (!sockPath || !existsSync(sockPath)) return false;
    try {
      this.ipc = new IPCConnection(sockPath);
      await this.ipc.connect();
      return true;
    } catch {
      this.ipc = null;
      return false;
    }
  }

  disconnect(): void {
    this.ipc?.disconnect();
    this.ipc = null;
  }

  // ---- High-Level Queries ----

  /** Get ready tasks (unblocked, open) via daemon or JSONL fallback */
  async getReady(options?: { limit?: number }): Promise<OpenTasksNodeSummary[]> {
    if (this.ipc?.connected) {
      try {
        const result = await this.ipc.request<OpenTasksQueryResult>(
          'tools.query', { ready: { limit: options?.limit } }
        );
        const items = result.items;
        return options?.limit ? items.slice(0, options.limit) : items;
      } catch { /* fall through to JSONL */ }
    }
    return this.readReadyFromJsonl(options?.limit);
  }

  /** Get graph summary — always reads from JSONL for consistency */
  async getGraphSummary(): Promise<OpenTasksGraphSummary> {
    return this.readGraphSummaryFromJsonl();
  }

  /** Query task nodes via daemon (returns null if daemon unavailable) */
  async queryNodes(filter: Record<string, unknown>): Promise<OpenTasksQueryResult | null> {
    if (!this.ipc?.connected) return null;
    try {
      return await this.ipc.request<OpenTasksQueryResult>('tools.query', { nodes: filter });
    } catch {
      return null;
    }
  }

  // ---- JSONL Parsing ----

  private readGraphSummaryFromJsonl(): OpenTasksGraphSummary {
    const graphPath = join(this.opentasksDir, 'graph.jsonl');
    const summary: OpenTasksGraphSummary = {
      node_count: 0,
      edge_count: 0,
      task_counts: { open: 0, in_progress: 0, blocked: 0, closed: 0 },
      context_count: 0,
      feedback_count: 0,
      ready_count: 0,
    };
    if (!existsSync(graphPath)) return summary;

    const content = readFileSync(graphPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const nodesById = new Map<string, Record<string, unknown>>();
    const blockedBy = new Map<string, Set<string>>();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.from_id && obj.to_id) {
          summary.edge_count++;
          if (obj.type === 'blocks' && !obj.deleted) {
            if (!blockedBy.has(obj.to_id)) blockedBy.set(obj.to_id, new Set());
            blockedBy.get(obj.to_id)!.add(obj.from_id);
          }
        } else if (obj.id && obj.type) {
          nodesById.set(obj.id, obj);
          summary.node_count++;
          if (obj.type === 'task' && !obj.archived) {
            const status = (obj.status || 'open') as string;
            if (status in summary.task_counts) {
              summary.task_counts[status as keyof typeof summary.task_counts]++;
            }
          }
          if (obj.type === 'context' && !obj.archived) summary.context_count++;
          if (obj.type === 'feedback' && !obj.archived) summary.feedback_count++;
        }
      } catch { /* skip malformed lines */ }
    }

    // Compute ready: open tasks with no active blockers
    for (const [id, node] of nodesById) {
      if (node.type !== 'task' || node.archived || (node.status || 'open') !== 'open') continue;
      const blockers = blockedBy.get(id);
      if (!blockers || blockers.size === 0) {
        summary.ready_count++;
      } else {
        let allResolved = true;
        for (const blockerId of blockers) {
          const blocker = nodesById.get(blockerId);
          if (blocker && blocker.status !== 'closed' && !blocker.archived) {
            allResolved = false;
            break;
          }
        }
        if (allResolved) summary.ready_count++;
      }
    }

    return summary;
  }

  private readReadyFromJsonl(limit?: number): OpenTasksNodeSummary[] {
    const graphPath = join(this.opentasksDir, 'graph.jsonl');
    if (!existsSync(graphPath)) return [];

    const content = readFileSync(graphPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const nodesById = new Map<string, Record<string, unknown>>();
    const blockedBy = new Map<string, Set<string>>();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.from_id && obj.to_id) {
          if (obj.type === 'blocks' && !obj.deleted) {
            if (!blockedBy.has(obj.to_id)) blockedBy.set(obj.to_id, new Set());
            blockedBy.get(obj.to_id)!.add(obj.from_id);
          }
        } else if (obj.id && obj.type) {
          nodesById.set(obj.id, obj);
        }
      } catch { /* skip */ }
    }

    const ready: OpenTasksNodeSummary[] = [];
    const maxResults = limit || 50;

    for (const [id, node] of nodesById) {
      if (node.type !== 'task' || node.archived || (node.status || 'open') !== 'open') continue;

      const blockers = blockedBy.get(id);
      let isReady = true;
      if (blockers && blockers.size > 0) {
        for (const blockerId of blockers) {
          const blocker = nodesById.get(blockerId);
          if (blocker && blocker.status !== 'closed' && !blocker.archived) {
            isReady = false;
            break;
          }
        }
      }

      if (isReady) {
        ready.push({
          id: node.id as string,
          type: 'task',
          title: (node.title as string) || (node.id as string),
          status: (node.status as string) || 'open',
          priority: node.priority as number | undefined,
          archived: false,
        });
        if (ready.length >= maxResults) break;
      }
    }

    // Sort by priority (lower number = higher priority)
    ready.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
    return ready;
  }
}
