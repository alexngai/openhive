/**
 * Stale-marker tests — §4.6: when `live()` returns null for a staged chip,
 * the fenced block's attrs carry `stale="true"`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import '../../components/chat-fab/context-types';
import { useChatFabStagedChipsStore } from '../../components/chat-fab/chat-fab-staged-chips-store';
import {
  applyLiveRefresh,
  composeTurn,
  composeTurnWithLiveRefresh,
  formatChipForSendWithFlags,
} from '../../components/chat-fab/chat-send-utils';
import {
  registerContextType,
  getContextType,
} from '../../components/chat-fab/context-registry';
import type { ChatFabContextItem } from '../../components/chat-fab/chat-fab-item';
import type { SpecData } from '../../components/chat-fab/context-types/spec';

function reset() {
  useChatFabStagedChipsStore.setState({ stagedChips: [] });
}

function freshQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

const specItem: ChatFabContextItem & { type: 'spec'; data: SpecData } = {
  type: 'spec',
  label: 'Spec A',
  data: { id: 'a', resource_id: 'r', title: 'Auth', content: 'body' },
};

describe('stale marker end-to-end', () => {
  beforeEach(reset);

  it('formatChipForSendWithFlags({stale:true}) appends stale="true" attr', () => {
    const out = formatChipForSendWithFlags(specItem, { stale: true });
    expect(out).toMatch(/stale="true"/);
    expect(out).toMatch(/<context [^>]*stale="true"[^>]*>/);
  });

  it('formatChipForSendWithFlags({}) omits stale attr', () => {
    const out = formatChipForSendWithFlags(specItem, {});
    expect(out).not.toMatch(/stale=/);
  });

  it('applyLiveRefresh returns stale=true when live returns null', async () => {
    // Register a shim spec type whose live always returns null.
    registerContextType<{ id: string }>({
      type: 'ghost',
      kind: 'openhive:ghost',
      description: 'ghost',
      icon: '👻',
      label: (d) => `Ghost ${d.id}`,
      identity: (d) => ({ id: d.id }),
      format: (d, flags) =>
        `<context kind="openhive:ghost" id="${d.id}"${flags?.stale ? ' stale="true"' : ''}></context>`,
      live: async () => null,
    });

    const chip = {
      chipId: 'c1',
      item: {
        type: 'ghost',
        label: 'Ghost 1',
        data: { id: '1' },
      } as ChatFabContextItem,
      stagedAt: Date.now(),
    };

    const qc = freshQc();
    const { item, stale } = await applyLiveRefresh(chip, qc);
    expect(stale).toBe(true);
    // Item data is still the snapshot (not replaced).
    expect((item.data as { id: string }).id).toBe('1');
  });

  it('composeTurnWithLiveRefresh emits stale="true" when live returns null', async () => {
    registerContextType<{ id: string }>({
      type: 'ghost2',
      kind: 'openhive:ghost',
      description: 'ghost2',
      icon: '👻',
      label: (d) => `Ghost ${d.id}`,
      identity: (d) => ({ id: d.id }),
      format: (d, flags) => {
        const attrs = `kind="openhive:ghost" id="${d.id}"${flags?.stale ? ' stale="true"' : ''}`;
        return `<context ${attrs}>\nbody\n</context>`;
      },
      live: async () => null,
    });

    const chip = {
      chipId: 'c2',
      item: {
        type: 'ghost2',
        label: 'Ghost 2',
        data: { id: '2' },
      } as ChatFabContextItem,
      stagedAt: Date.now(),
    };

    const composed = await composeTurnWithLiveRefresh(
      [chip],
      'hello',
      freshQc(),
    );
    expect(composed).toMatch(/stale="true"/);
    expect(composed).toContain('hello');
  });

  it('composeTurnWithLiveRefresh does NOT emit stale for a type with no live loader', async () => {
    // `tasks` intentionally has no `live` loader (step-7 decision).
    const tasksSpec = getContextType('tasks');
    expect(tasksSpec).toBeDefined();
    expect(tasksSpec?.live).toBeUndefined();

    const chip = {
      chipId: 'c3',
      item: {
        type: 'tasks',
        label: 'Linked tasks (1)',
        data: { tasks: [{ id: 't-1', title: 'First', status: 'open' }] },
      } as ChatFabContextItem,
      stagedAt: Date.now(),
    };

    const composed = await composeTurnWithLiveRefresh([chip], '', freshQc());
    expect(composed).not.toMatch(/stale="true"/);
  });

  it('synchronous composeTurn() never emits stale (no live path)', () => {
    const chip = {
      chipId: 'c4',
      item: specItem,
      stagedAt: Date.now(),
    };
    const out = composeTurn([chip], 'hi');
    expect(out).not.toMatch(/stale="true"/);
  });
});
