/**
 * Mock swarm — for documentation screenshots/GIFs only. It:
 *  - connects to the local demo hub over the MAP WebSocket and registers a live
 *    agent roster (so swarms show ONLINE), auto-answering pings;
 *  - serves /health at each swarm's endpoint so the hub's outbound reachability
 *    check passes;
 *  - drives a live multi-agent conversation via the SAME SqliteStorage mail
 *    backend the hub uses, posting a new turn every few seconds (the Threads UI
 *    picks them up on its poll) — for the "streaming conversation" GIF.
 *
 *   OPENHIVE_DATABASE=/tmp/demo/demo.db npx tsx scripts/demo/mock-swarm.ts
 *
 * Requires the demo hub already running on 127.0.0.1:7836 against the same DB.
 */
import WebSocket from 'ws';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { initDatabase, getDatabase } from '../../src/db/index.js';
import { createAgent, findAgentByName } from '../../src/db/dal/agents.js';
import { createIngestKey } from '../../src/db/dal/ingest-keys.js';
import { heartbeatSwarm } from '../../src/db/dal/map.js';

const DB = process.env.OPENHIVE_DATABASE;
if (!DB) { console.error('Set OPENHIVE_DATABASE to the demo DB path.'); process.exit(1); }
const HUB = process.env.HUB_WS || 'ws://127.0.0.1:7836/ws/map';

interface AgentDef { name: string; role: string; capabilities: Record<string, unknown>; }
interface SwarmDef { swarmId: string; healthPort: number; agents: AgentDef[]; }

const ACP = { protocols: ['acp'], acp: { version: '2024-10-07' }, messaging: { canReceive: true }, mail: { canJoin: true } };

const SWARMS: SwarmDef[] = [
  {
    swarmId: 'swarm_research', healthPort: 9101, agents: [
      { name: 'research-lead', role: 'coordinator', capabilities: ACP },
      { name: 'scout-01', role: 'worker', capabilities: { messaging: { canReceive: true }, mail: { canJoin: true } } },
      { name: 'scout-02', role: 'worker', capabilities: { messaging: { canReceive: true } } },
    ],
  },
  {
    swarmId: 'swarm_build', healthPort: 9102, agents: [
      { name: 'builder-lead', role: 'coordinator', capabilities: { ...ACP, tasks: { canCreate: true } } },
      { name: 'builder-01', role: 'worker', capabilities: { messaging: { canReceive: true }, tasks: { canCreate: true } } },
      { name: 'reviewer-01', role: 'reviewer', capabilities: { messaging: { canReceive: true } } },
    ],
  },
  {
    swarmId: 'swarm_ops', healthPort: 9103, agents: [
      { name: 'ops-runner', role: 'worker', capabilities: { mail: { canJoin: true } } },
    ],
  },
];

let rpcId = 0;
function rpc(ws: WebSocket, method: string, params: Record<string, unknown>): Promise<any> {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 5000);
    const handler = (data: WebSocket.RawData) => {
      try { const m = JSON.parse(data.toString()); if (m.id === id) { clearTimeout(timer); ws.off('message', handler); resolve(m); } } catch { /* ignore */ }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureAgent(name: string, description: string): Promise<string> {
  return (findAgentByName(name) ?? (await createAgent({ name, description })).agent).id;
}

/** Wipe any prior demo conversations so each run leaves exactly one clean thread. */
function purgeConversations(): void {
  const db = getDatabase();
  db.pragma('foreign_keys = OFF');
  for (const t of ['mail_turns', 'mail_participants', 'mail_threads', 'mail_messages', 'mail_recipients', 'mail_conversations']) {
    try { db.exec(`DELETE FROM ${t}`); } catch { /* table may not exist */ }
  }
  db.pragma('foreign_keys = ON');
}

/**
 * Live multi-agent conversation for the streaming GIF. Uses the same
 * SqliteStorage + MailJsonRpcServer the hub uses, so it renders identically;
 * the hub's UI picks up new turns on its poll.
 */
async function runConversation(): Promise<void> {
  const inbox: any = await import('agent-inbox');
  purgeConversations();
  const storage = new inbox.SqliteStorage({ db: getDatabase(), prefix: 'mail_' });
  const events = new EventEmitter();
  const router = new inbox.MessageRouter(storage, events, 'default');
  const mail = new inbox.MailJsonRpcServer(storage, router, events);

  const roster: Record<string, string> = {
    'research-lead': await ensureAgent('research-lead', 'Coordinator for the research swarm'),
    'scout-01': await ensureAgent('scout-01', 'Pulls pricing + product pages'),
    'scout-02': await ensureAgent('scout-02', 'Fans out searches + changelogs'),
  };

  const createRes: any = await mail.handleRequest({
    jsonrpc: '2.0', id: 'c', method: 'mail/create',
    params: { subject: 'Q3 competitive landscape research', scope: 'manual' },
  });
  const convId = createRes?.result?.id;
  if (!convId) { console.error('[mock] mail/create failed:', JSON.stringify(createRes)); return; }

  const nameById: Record<string, string> = {};
  for (const [name, id] of Object.entries(roster)) nameById[id] = name;
  const joinIds = new Set(Object.values(roster));
  // Also add the hub's "local" operator agent so the console viewer (which
  // authenticates as `local`) can read the conversation past the access gate.
  const local = findAgentByName('local');
  if (local) { joinIds.add(local.id); nameById[local.id] = 'operator'; }
  for (const agentId of joinIds) {
    // Pass `name` so participants render as agent names, not raw ids.
    await mail.handleRequest({ jsonrpc: '2.0', id: 'j', method: 'mail/join', params: { conversationId: convId, agentId, name: nameById[agentId], role: 'participant' } });
  }

  const post = (name: string, text: string) =>
    mail.handleRequest({ jsonrpc: '2.0', id: 't', method: 'mail/turn', params: { conversationId: convId, participantId: roster[name], contentType: 'text', content: { type: 'text', text } } });

  const SCRIPT: Array<[string, string]> = [
    ['research-lead', 'Kicking off the Q3 competitive landscape. scout-01 take pricing pages; scout-02 take changelogs + release notes.'],
    ['scout-01', 'On it — pulling pricing for the top 6 competitors now.'],
    ['scout-02', "Starting on changelogs. I'll flag anything shipped in the last 30 days."],
    ['scout-01', 'Competitor A moved to usage-based pricing last month; B is still seat-based.'],
    ['scout-02', 'Competitor C shipped multi-agent orchestration two weeks ago — worth a callout.'],
    ['scout-01', 'Full pricing table saved to research-notes; 6/6 done.'],
    ['scout-02', '3 of 6 shipped agent-orchestration features this quarter — details logged.'],
    ['research-lead', 'Nice. scout-01, any notable packaging changes to flag?'],
    ['scout-01', 'Two moved to usage-based; one added a free self-hosted tier.'],
    ['research-lead', 'Perfect — synthesizing into a brief now.'],
    ['scout-02', 'Changelog highlights attached to research-notes.'],
    ['research-lead', 'Brief posted to project-memory. Great turnaround, team.'],
  ];
  // Stream unique turns one at a time (finite, no loop, no history dump) so the
  // thread builds up cleanly on-camera. Slow cadence + finite length gives a
  // wide window to navigate in and capture the live build-up.
  console.log(`[mock] conversation ${convId} ready; streaming ${SCRIPT.length} turns…`);
  // Awaited loop → guaranteed spacing between turns (recursive setTimeout was
  // stacking and completing far too fast to capture on-camera).
  // Longer lead-in so a capture run has time to navigate to the (empty) thread
  // before turn 1 lands — then the whole build-up is on-camera. Turn spacing is
  // tuned to be slower than the screenshot tool's per-call latency so a
  // back-to-back capture loop lands roughly one new turn per frame.
  await sleep(10000);
  for (const [n, t] of SCRIPT) {
    await post(n, t).catch((e) => console.error('[mock] turn failed:', (e as Error).message));
    await sleep(9000);
  }
  console.log('[mock] conversation complete');
}

async function main(): Promise<void> {
  initDatabase(DB!); // kept open — runConversation writes mail via SqliteStorage on it
  const connector = findAgentByName('mock-connector') ?? (await createAgent({ name: 'mock-connector', description: 'Mock swarm connector (screenshots)' })).agent;
  const { plaintext_key: token } = createIngestKey(connector.id, { label: 'mock-connector', agent_id: connector.id });

  for (const swarm of SWARMS) {
    http.createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); }
      else { res.writeHead(404); res.end(); }
    }).listen(swarm.healthPort, '127.0.0.1');

    const ws = new WebSocket(`${HUB}?token=${token}&swarm_id=${swarm.swarmId}`);
    ws.on('message', (data) => {
      try { const m = JSON.parse(data.toString()); if (m.method === 'ping') ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'pong', params: {} })); } catch { /* ignore */ }
    });
    ws.on('open', async () => {
      await sleep(400);
      let n = 0;
      for (const a of swarm.agents) {
        try { await rpc(ws, 'map/agents/register', { name: a.name, role: a.role, capabilities: a.capabilities, metadata: { swarm: swarm.swarmId } }); n++; }
        catch (e) { console.error(`[mock] ${swarm.swarmId} register ${a.name} failed:`, (e as Error).message); }
      }
      console.log(`[mock] ${swarm.swarmId} online — registered ${n} agents`);
    });
    ws.on('error', (e) => console.error(`[mock] ${swarm.swarmId} ws error:`, (e as Error).message));
    ws.on('close', (code) => console.error(`[mock] ${swarm.swarmId} ws closed: ${code}`));
  }

  await sleep(1500);
  runConversation().catch((e) => console.error('[mock] conversation error:', (e as Error).message));

  // Keep the swarms marked online. These are inbound-connected demo swarms;
  // the swarmcraft bridge periodically tries an OUTBOUND connect to a MAP
  // server they don't run (port+2/map) and would otherwise flip them to
  // 'unreachable'. Re-assert the heartbeat faster than BRIDGE_RETRY_MS (30s)
  // so the console consistently shows them online.
  console.log('[mock] connecting swarms + streaming; staying alive (Ctrl-C to stop)…');
  setInterval(() => {
    for (const s of SWARMS) { try { heartbeatSwarm(s.swarmId); } catch { /* ignore */ } }
  }, 2000);
}

main().catch((err) => { console.error('mock-swarm failed:', err); process.exit(1); });
