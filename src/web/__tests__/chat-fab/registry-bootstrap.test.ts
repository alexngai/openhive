import { describe, it, expect } from 'vitest';
import '../../components/chat-fab/context-types';
import { listContextTypes } from '../../components/chat-fab/context-registry';

describe('registry bootstrap', () => {
  it('registers at least eight built-in context types', () => {
    // Step 8 rollout added: stream, task, swarm, session, conversation.
    const types = listContextTypes();
    expect(types.length).toBeGreaterThanOrEqual(8);
  });

  it('includes every built-in type by name', () => {
    const names = listContextTypes().map((s) => s.type);
    expect(names).toContain('spec');
    expect(names).toContain('tasks');
    expect(names).toContain('dispatch');
    expect(names).toContain('stream');
    expect(names).toContain('task');
    expect(names).toContain('swarm');
    expect(names).toContain('session');
    expect(names).toContain('conversation');
  });
});
