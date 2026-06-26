/**
 * ChatFabStore — ACP resume plumbing
 *
 * When the user toggles the ChatFab between floating and docked mode, the
 * ChatPanel component unmounts in one render tree and remounts in the
 * other. If `resume` (the `{ acpStreamId, acpSessionId }` pair returned
 * by `/sessions/acp-connect`) isn't stashed in the store, the remounted
 * panel calls the ACP adapter's fresh-stream branch — which closes the
 * server-side stream and drops the chat history.
 *
 * These tests lock in the store's contract: resume info flows through
 * `setSession` and `clearSession`, and survives the mode toggle.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatFabStore, type ChatFabResume } from '../../../components/chat-fab/ChatFabStore';
import { api } from '../../../lib/api';

function resetStore() {
  useChatFabStore.setState({
    open: false,
    sessionId: null,
    swarmId: null,
    sessionLabel: null,
    agentRef: null,
    resume: null,
    transportMode: null,
    view: 'picker',
    mode: 'floating',
    connecting: false,
    connectError: null,
  });
}

describe('ChatFabStore resume plumbing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('setSession persists resume info when provided', () => {
    const resume: ChatFabResume = {
      acpStreamId: 'stream-1',
      acpSessionId: 'session-1',
    };
    useChatFabStore.getState().setSession('res-1', 'swarm-1', 'label-1', resume);

    const s = useChatFabStore.getState();
    expect(s.sessionId).toBe('res-1');
    expect(s.resume).toEqual(resume);
  });

  it('setSession without resume clears any prior resume', () => {
    // Start with a previous resume set
    useChatFabStore.getState().setSession('res-A', 'swarm-A', 'A', {
      acpStreamId: 'stream-A',
      acpSessionId: 'session-A',
    });
    expect(useChatFabStore.getState().resume).not.toBeNull();

    // Switching to a different session that doesn't carry ACP ids (mail
    // fallback) must null out the old resume — otherwise the new panel
    // would try to loadSession on a stream that belongs to a different
    // target.
    useChatFabStore.getState().setSession('mail:swarm-B:agent-x', 'swarm-B', 'B');
    expect(useChatFabStore.getState().resume).toBeNull();
  });

  it('clearSession nulls the resume', () => {
    useChatFabStore.getState().setSession('res-1', 'swarm-1', 'label', {
      acpStreamId: 'stream-1',
      acpSessionId: 'session-1',
    });
    useChatFabStore.getState().clearSession();
    expect(useChatFabStore.getState().resume).toBeNull();
    expect(useChatFabStore.getState().sessionId).toBeNull();
  });

  it('resume is preserved across mode toggles', () => {
    const resume: ChatFabResume = {
      acpStreamId: 'stream-1',
      acpSessionId: 'session-1',
      providerSessionId: 'prov-1',
    };
    useChatFabStore.getState().setSession('res-1', 'swarm-1', 'label', resume);

    // Simulate the mode toggles the user is hitting
    useChatFabStore.getState().toggleMode(); // floating → docked
    expect(useChatFabStore.getState().mode).toBe('docked');
    expect(useChatFabStore.getState().resume).toEqual(resume);

    useChatFabStore.getState().toggleMode(); // docked → floating
    expect(useChatFabStore.getState().mode).toBe('floating');
    expect(useChatFabStore.getState().resume).toEqual(resume);
  });

  it('toggling open/collapsed does not drop the resume descriptor', () => {
    useChatFabStore.getState().setSession('res-1', 'swarm-1', 'label', {
      acpStreamId: 'stream-1',
      acpSessionId: 'session-1',
    });
    useChatFabStore.getState().collapse();
    useChatFabStore.getState().toggle();
    expect(useChatFabStore.getState().resume).not.toBeNull();
  });

  it('connectMailAndOpen opens the real session resource returned by the API', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce({
      session_resource_id: 'res-mail-1',
      created: true,
    });

    await useChatFabStore.getState().connectMailAndOpen('swarm-mail', 'agent-mail', 'Mailer');

    expect(post).toHaveBeenCalledWith('/sessions/mail-connect', {
      swarm_id: 'swarm-mail',
      agent_id: 'agent-mail',
    });

    const s = useChatFabStore.getState();
    expect(s.sessionId).toBe('res-mail-1');
    expect(s.sessionId).not.toMatch(/^mail:/);
    expect(s.swarmId).toBe('swarm-mail');
    expect(s.sessionLabel).toBe('Mailer');
    expect(s.agentRef).toEqual({ swarmId: 'swarm-mail', agentId: 'agent-mail' });
    expect(s.resume).toBeNull();
    expect(s.transportMode).toBe('mail');
    expect(s.view).toBe('chat');
  });
});
