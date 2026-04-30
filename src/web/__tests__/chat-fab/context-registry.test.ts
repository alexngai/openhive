import { describe, it, expect } from 'vitest';
import '../../components/chat-fab/context-types';
import { listContextTypes } from '../../components/chat-fab/context-registry';

const FENCED_RE =
  /^<context kind="[a-z]+:[a-z]+"( [a-z_]+="[^"]*")+>[\s\S]*<\/context>$/;

const SAMPLES: Record<string, unknown> = {
  spec: {
    id: 'spec-1',
    resource_id: 'res-xyz',
    title: 'My Spec',
    content: 'body text',
  },
  tasks: {
    tasks: [
      { id: 't-1', title: 'First', status: 'open' },
      { id: 't-2', title: 'Second', status: 'in_progress' },
    ],
  },
  dispatch: {
    id: 'd-abc123',
    spec_id: 'spec-xyz',
    target_swarm_id: 'swarm-1',
    status: 'running',
    created_at: '2026-04-22T00:00:00Z',
  },
  stream: {
    id: 'stream-row-1',
    stream_id: 'stream-abc',
    source_swarm_id: 'swarm-1',
    source_agent_id: 'agent-1',
    name: 'feature/x',
    status: 'active',
    publish_branch: 'refs/cascade/feature-x',
    commit_count: 3,
    open_conflict_count: 0,
  },
  task: {
    id: 't-node-1',
    resource_id: 'res-tasks',
    title: 'Wire OAuth',
    status: 'in_progress',
    assignee: 'agent-42',
    blocked_by: ['t-node-0'],
    blocks: ['t-node-2'],
  },
  swarm: {
    id: 'swarm-1',
    name: 'dev-swarm',
    status: 'online',
    agent_count: 5,
    registered_agent_count: 3,
    last_seen_at: '2026-04-22T00:00:00Z',
  },
  session: {
    id: 'session-1',
    swarm_id: 'swarm-1',
    name: 'claude-session-1',
    project: 'openhive',
    project_path: '/Users/alex/openhive',
    branch: 'main',
    first_prompt: 'help me tighten section 2',
    state: 'active',
    checkpoint_count: 4,
  },
  conversation: {
    id: 'conv-1',
    swarm_id: 'swarm-1',
    subject: 'Auth plan',
    status: 'active',
    participant_count: 3,
    turn_count: 7,
    recent_turns: [
      {
        participant_id: 'agent-a',
        content_text: 'First turn content',
        created_at: '2026-04-22T00:00:00Z',
      },
      {
        participant_id: 'agent-b',
        content_text: 'Second turn',
        created_at: '2026-04-22T00:01:00Z',
      },
    ],
  },
};

describe('context registry integrity', () => {
  for (const spec of listContextTypes()) {
    describe(`type=${spec.type}`, () => {
      const data = SAMPLES[spec.type];

      it('has a sample defined in the test', () => {
        expect(data).toBeDefined();
      });

      if (data === undefined) return;

      it('identity(data).id or count is non-empty', () => {
        const id = spec.identity(data);
        const keys = Object.keys(id);
        expect(keys.length).toBeGreaterThan(0);
        for (const v of Object.values(id)) {
          expect(v.length).toBeGreaterThan(0);
        }
      });

      it('identity is stable for the same input', () => {
        expect(spec.identity(data)).toEqual(spec.identity(data));
      });

      it('format(data) contains every identity attr value', () => {
        const formatted = spec.format(data);
        for (const [k, v] of Object.entries(spec.identity(data))) {
          expect(formatted).toContain(`${k}="${v}"`);
        }
      });

      it('format(data) matches the fenced-block regex', () => {
        const formatted = spec.format(data);
        expect(formatted).toMatch(FENCED_RE);
      });

      it('kind is qualified (ns:name)', () => {
        expect(spec.kind).toMatch(/^[a-z]+:[a-z]+$/);
      });

      it('format(data, { stale: true }) appends stale="true" attr and still matches the fenced-block regex', () => {
        const formatted = spec.format(data, { stale: true });
        expect(formatted).toMatch(/stale="true"/);
        // Existing regex already tolerates any `[a-z_]+="…"` attr.
        expect(formatted).toMatch(FENCED_RE);
      });

      it('format(data, { stale: false }) does not emit stale attr', () => {
        const formatted = spec.format(data, { stale: false });
        expect(formatted).not.toMatch(/stale="/);
      });

      it('format(data) with no flags matches format(data, {}) — stale omitted', () => {
        const a = spec.format(data);
        const b = spec.format(data, {});
        expect(a).toBe(b);
        expect(a).not.toMatch(/stale="/);
      });
    });
  }
});
