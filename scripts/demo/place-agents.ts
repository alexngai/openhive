/**
 * Place demo agents onto the SwarmCraft Overview graph — for the screenshot
 * where several agents are shown working on different parts of the codebase.
 *
 * SwarmCraft positions an agent at the weighted centroid of the files it has
 * touched. That activity normally comes from real agent trajectories; here we
 * synthesize it: for a handful of personas we send a `trajectory/checkpoint`
 * over the MAP WS with `files_touched` set to ONE real file that exists as a
 * graph node, each in a different subsystem so the agents scatter across the
 * graph. OpenHive's session-bridge records the access + broadcasts a per-file
 * `agent.activity` event, and the frontend renders the agent at that node.
 *
 *   OPENHIVE_DATABASE=/tmp/oh-demo/demo.db npx tsx scripts/demo/place-agents.ts
 *
 * Requires the demo hub running on 127.0.0.1:7836 against the same DB, with the
 * SwarmCraft graph loaded (so file nodes exist to anchor onto).
 */
import WebSocket from 'ws';
import { initDatabase } from '../../src/db/index.js';
import { createAgent, findAgentByName } from '../../src/db/dal/agents.js';
import { createIngestKey } from '../../src/db/dal/ingest-keys.js';

const DB = process.env.OPENHIVE_DATABASE;
if (!DB) { console.error('Set OPENHIVE_DATABASE to the demo DB path.'); process.exit(1); }
const HUB = process.env.HUB_WS || 'ws://127.0.0.1:7836/ws/map';
const API = process.env.HUB_API || 'http://127.0.0.1:7836';
const SWARM_ID = process.env.SWARM_ID || 'swarm_build';

// Agent personas to scatter across the graph.
const PERSONAS = [
  'builder-01', 'reviewer-02', 'scout-03', 'ops-04',
  'researcher-05', 'planner-06', 'fixer-07', 'writer-08',
];

let rpcId = 0;
function rpc(ws: WebSocket, method: string, params: Record<string, unknown>): Promise<any> {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 8000);
    const handler = (data: WebSocket.RawData) => {
      try { const m = JSON.parse(data.toString()); if (m.id === id) { clearTimeout(timer); ws.off('message', handler); resolve(m); } } catch { /* ignore */ }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pull real File-node paths from the graph, one per distinct src/ subsystem. */
async function pickSpreadFiles(n: number): Promise<string[]> {
  const res = await fetch(`${API}/api/swarmcraft/pipeline/graph?limit=8000`);
  const j = await res.json() as { data?: { nodes?: Array<{ label?: string; properties?: { filePath?: string } }> } };
  const nodes = j.data?.nodes ?? [];
  const byDir = new Map<string, string>();
  for (const nd of nodes) {
    if (nd.label !== 'File') continue;
    const fp = nd.properties?.filePath ?? '';
    const parts = fp.split('/');
    if (parts[0] !== 'src' || parts.length < 3 || !/\.(ts|tsx)$/.test(fp)) continue;
    // Prefer a "meatier" file per subsystem (skip index/types barrels).
    const base = parts[parts.length - 1];
    if (base.startsWith('index.') || base === 'types.ts') { if (byDir.has(parts[1])) continue; }
    if (!byDir.has(parts[1])) byDir.set(parts[1], fp);
  }
  return [...byDir.values()].slice(0, n);
}

async function main(): Promise<void> {
  initDatabase(DB!);
  const connector = findAgentByName('mock-connector') ?? (await createAgent({ name: 'mock-connector', description: 'Mock swarm connector (screenshots)' })).agent;
  const { plaintext_key: token } = createIngestKey(connector.id, { label: 'place-agents', agent_id: connector.id });

  const files = await pickSpreadFiles(PERSONAS.length);
  if (files.length === 0) { console.error('No File nodes found in the graph — is the SwarmCraft graph loaded?'); process.exit(1); }
  console.log(`[place] ${files.length} anchor files:`, files);

  const ws = new WebSocket(`${HUB}?token=${token}&swarm_id=${SWARM_ID}`);
  ws.on('message', (data) => {
    try { const m = JSON.parse(data.toString()); if (m.method === 'ping') ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'pong', params: {} })); } catch { /* ignore */ }
  });
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  await sleep(400);

  for (let i = 0; i < files.length; i++) {
    const agent = PERSONAS[i % PERSONAS.length];
    const fp = files[i];
    try {
      // A couple of checkpoints on the same file so the centroid anchors firmly.
      for (let k = 0; k < 2; k++) {
        const r = await rpc(ws, 'trajectory/checkpoint', {
          checkpoint: {
            id: `demo-chk-${i}-${k}`,
            session_id: `demo-sess-${i}`,
            agent,
            branch: 'main',
            files_touched: [fp],
            metadata: { project: 'openhive', firstPrompt: `Working on ${fp}` },
          },
        });
        if (r.error) console.error(`[place] ${agent} @ ${fp} error:`, JSON.stringify(r.error));
      }
      console.log(`[place] ${agent} → ${fp}`);
    } catch (e) {
      console.error(`[place] ${agent} @ ${fp} failed:`, (e as Error).message);
    }
    await sleep(150);
  }

  await sleep(800);
  ws.close();
  console.log('[place] done');
  process.exit(0);
}

main().catch((err) => { console.error('place-agents failed:', err); process.exit(1); });
