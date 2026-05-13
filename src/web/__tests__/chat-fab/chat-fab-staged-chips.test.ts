import { describe, it, expect, beforeEach } from 'vitest';
import {
  useChatFabStagedChipsStore,
} from '../../components/chat-fab/chat-fab-staged-chips-store';
import { useChatFabStore } from '../../components/chat-fab/ChatFabStore';
import type { ChatFabContextItem } from '../../components/chat-fab/chat-fab-item';

function reset() {
  useChatFabStagedChipsStore.setState({ stagedChips: [] });
  useChatFabStore.setState({
    sessionId: null,
    swarmId: null,
    sessionLabel: null,
    agentRef: null,
    resume: null,
  });
}

const itemSpec1: ChatFabContextItem = {
  type: 'spec',
  label: 'Spec: Auth',
  data: { id: 'spec-1', title: 'Auth' },
};
const itemSpec1Dup: ChatFabContextItem = {
  type: 'spec',
  label: 'Spec: Auth (dup click)',
  data: { id: 'spec-1', title: 'Auth' },
};
const itemTaskA: ChatFabContextItem = {
  type: 'task',
  label: 'Task A',
  data: { id: 't-a' },
};

describe('ChatFabStagedChipsStore', () => {
  beforeEach(reset);

  it('addChip appends to stagedChips with a unique chipId + timestamp', () => {
    const { addChip } = useChatFabStagedChipsStore.getState();
    addChip(itemSpec1);
    addChip(itemTaskA);
    const chips = useChatFabStagedChipsStore.getState().stagedChips;
    expect(chips).toHaveLength(2);
    expect(chips[0]?.item).toBe(itemSpec1);
    expect(chips[1]?.item).toBe(itemTaskA);
    expect(chips[0]?.chipId).not.toBe(chips[1]?.chipId);
    expect(typeof chips[0]?.stagedAt).toBe('number');
  });

  it('addChip dedupes by kind+id (same entity staged twice is a no-op)', () => {
    const { addChip } = useChatFabStagedChipsStore.getState();
    addChip(itemSpec1);
    addChip(itemSpec1Dup);
    const chips = useChatFabStagedChipsStore.getState().stagedChips;
    expect(chips).toHaveLength(1);
  });

  it('removeChip removes by chipId', () => {
    const { addChip, removeChip } = useChatFabStagedChipsStore.getState();
    addChip(itemSpec1);
    addChip(itemTaskA);
    const firstId = useChatFabStagedChipsStore.getState().stagedChips[0]!
      .chipId;
    removeChip(firstId);
    const chips = useChatFabStagedChipsStore.getState().stagedChips;
    expect(chips).toHaveLength(1);
    expect(chips[0]?.item.type).toBe('task');
  });

  it('clearChips empties everything', () => {
    const { addChip, clearChips } = useChatFabStagedChipsStore.getState();
    addChip(itemSpec1);
    addChip(itemTaskA);
    clearChips();
    expect(useChatFabStagedChipsStore.getState().stagedChips).toEqual([]);
  });

  it('clears staged chips on session swap', () => {
    // Seed an initial session + stage a chip.
    useChatFabStore.getState().setSession('sess-1', 'swarm-1', 'Agent A');
    useChatFabStagedChipsStore.getState().addChip(itemSpec1);
    expect(useChatFabStagedChipsStore.getState().stagedChips).toHaveLength(1);

    // Swap to a different session — chips should clear.
    useChatFabStore.getState().setSession('sess-2', 'swarm-1', 'Agent B');
    expect(useChatFabStagedChipsStore.getState().stagedChips).toEqual([]);
  });

  it('does NOT clear chips when setSession is called with the same id', () => {
    useChatFabStore.getState().setSession('sess-1', 'swarm-1', 'Agent A');
    useChatFabStagedChipsStore.getState().addChip(itemSpec1);
    // Re-seed the same session (e.g. label update)
    useChatFabStore.getState().setSession('sess-1', 'swarm-1', 'Agent A renamed');
    expect(useChatFabStagedChipsStore.getState().stagedChips).toHaveLength(1);
  });

  it('clearSession() empties staged chips', () => {
    useChatFabStore.getState().setSession('sess-1', 'swarm-1', 'Agent A');
    useChatFabStagedChipsStore.getState().addChip(itemSpec1);
    useChatFabStore.getState().clearSession();
    expect(useChatFabStagedChipsStore.getState().stagedChips).toEqual([]);
  });
});
