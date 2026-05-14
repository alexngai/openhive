import { describe, it, expect } from 'vitest';
import { translateCodexRequest, translateCodexNotification } from '../../swarm/hosted-chat-events.js';

describe('hosted-chat-events — translateCodexRequest', () => {
  const REQUEST_ID = 'r-42';

  describe('legacy v1 approvals', () => {
    it('translates execCommandApproval to permission.request (exec flavor)', () => {
      const ev = translateCodexRequest('execCommandApproval', {
        conversationId: 'c1',
        callId: 'call-1',
        approvalId: null,
        command: ['ls', '-la'],
        cwd: '/work',
        reason: 'list directory',
        parsedCmd: [],
      }, REQUEST_ID);
      expect(ev?.kind).toBe('permission.request');
      if (ev?.kind !== 'permission.request') throw new Error('narrowing');
      expect(ev.request.requestId).toBe(REQUEST_ID);
      expect(ev.request.flavor).toBe('exec');
      expect(ev.request.summary).toContain('ls -la');
      expect(ev.request.summary).toContain('/work');
      expect(ev.request.reason).toBe('list directory');
      expect(ev.request.providerMethod).toBe('execCommandApproval');
    });

    it('translates applyPatchApproval to permission.request (patch flavor)', () => {
      const ev = translateCodexRequest('applyPatchApproval', {
        conversationId: 'c1',
        callId: 'call-1',
        fileChanges: { 'src/foo.ts': {}, 'src/bar.ts': {} },
        reason: 'apply diff',
        grantRoot: null,
      }, REQUEST_ID);
      if (ev?.kind !== 'permission.request') throw new Error('expected permission.request');
      expect(ev.request.flavor).toBe('patch');
      expect(ev.request.summary).toBe('Apply patch to 2 files');
      expect(ev.request.reason).toBe('apply diff');
    });

    it('singular patch reads "Apply patch to <path>" when one file', () => {
      const ev = translateCodexRequest('applyPatchApproval', {
        fileChanges: { 'a/b.ts': {} },
      }, REQUEST_ID);
      if (ev?.kind !== 'permission.request') throw new Error('expected permission.request');
      expect(ev.request.summary).toBe('Apply patch to a/b.ts');
    });
  });

  describe('v2 approvals', () => {
    it('translates item/commandExecution/requestApproval to exec flavor', () => {
      const ev = translateCodexRequest('item/commandExecution/requestApproval', {
        threadId: 't1',
        turnId: 'tu1',
        itemId: 'i1',
        startedAtMs: Date.now(),
        command: 'rm -rf /tmp/x',
        cwd: '/work',
        reason: 'cleanup',
      }, REQUEST_ID);
      if (ev?.kind !== 'permission.request') throw new Error('expected permission.request');
      expect(ev.request.flavor).toBe('exec');
      expect(ev.request.summary).toContain('rm -rf /tmp/x');
      expect(ev.request.summary).toContain('/work');
    });

    it('translates item/fileChange/requestApproval to patch flavor', () => {
      const ev = translateCodexRequest('item/fileChange/requestApproval', {
        fileChanges: { 'README.md': {} },
        reason: 'docs update',
      }, REQUEST_ID);
      if (ev?.kind !== 'permission.request') throw new Error('expected permission.request');
      expect(ev.request.flavor).toBe('patch');
      expect(ev.request.reason).toBe('docs update');
    });

    it('translates item/permissions/requestApproval to other flavor', () => {
      const ev = translateCodexRequest('item/permissions/requestApproval', { reason: 'needs network' }, REQUEST_ID);
      if (ev?.kind !== 'permission.request') throw new Error('expected permission.request');
      expect(ev.request.flavor).toBe('other');
      expect(ev.request.reason).toBe('needs network');
    });
  });

  describe('non-approval requests', () => {
    it('returns raw for known non-approval methods (e.g. attestation/generate)', () => {
      const ev = translateCodexRequest('attestation/generate', { foo: 'bar' }, REQUEST_ID);
      expect(ev?.kind).toBe('raw');
      if (ev?.kind !== 'raw') return;
      expect(ev.method).toBe('attestation/generate');
      expect(ev.params).toEqual({ foo: 'bar' });
    });

    it('returns raw for unknown methods (forward-compat)', () => {
      const ev = translateCodexRequest('completely/unknown/method', null, REQUEST_ID);
      expect(ev?.kind).toBe('raw');
    });
  });

  describe('robustness', () => {
    it('handles missing command field on exec approval', () => {
      const ev = translateCodexRequest('execCommandApproval', {}, REQUEST_ID);
      if (ev?.kind !== 'permission.request') throw new Error('expected permission.request');
      expect(ev.request.summary).toBe('Run a shell command');
    });

    it('handles missing fileChanges on patch approval', () => {
      const ev = translateCodexRequest('applyPatchApproval', {}, REQUEST_ID);
      if (ev?.kind !== 'permission.request') throw new Error('expected permission.request');
      expect(ev.request.summary).toBe('Apply file changes');
    });

    it('handles null params', () => {
      const ev = translateCodexRequest('execCommandApproval', null, REQUEST_ID);
      if (ev?.kind !== 'permission.request') throw new Error('expected permission.request');
      expect(ev.request.summary).toBe('Run a shell command');
    });
  });
});

describe('hosted-chat-events — translateCodexNotification regression', () => {
  it('still translates turn/started (existing behavior unchanged)', () => {
    const ev = translateCodexNotification('turn/started', { turn: { id: 'turn-1' } });
    expect(ev?.kind).toBe('turn.started');
  });

  it('still falls back to raw for unknown notifications', () => {
    const ev = translateCodexNotification('mcpServer/startupStatus/updated', { status: 'ready' });
    expect(ev?.kind).toBe('raw');
  });
});
