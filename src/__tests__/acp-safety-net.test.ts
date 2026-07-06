/**
 * Unit test: the ACP-stream unhandled-rejection matcher. It must suppress ONLY
 * the two known orphaned-promise patterns originating in the MAP SDK's ACP
 * stream — over-suppressing would swallow genuine hub crashes.
 */

import { describe, it, expect } from 'vitest';
import { isAcpStreamRace } from '../acp-safety-net.js';

const SDK_STACK =
  'Error: x\n    at Timeout._onTimeout (/app/node_modules/@multi-agent-protocol/sdk/dist/acp/stream.js:569:16)\n    at listOnTimeout (node:internal/timers:588:17)';
const OTHER_STACK =
  'Error: x\n    at Object.<anonymous> (/app/src/api/routes/sessions.ts:1600:10)';

function err(message: string, stack: string): Error {
  const e = new Error(message);
  e.stack = stack;
  return e;
}

describe('isAcpStreamRace', () => {
  it('suppresses the close-race from the SDK acp stream', () => {
    expect(isAcpStreamRace(err('ACP stream closed', SDK_STACK))).toBe(true);
  });

  it('suppresses the request-timeout from the SDK acp stream', () => {
    expect(
      isAcpStreamRace(err('ACP request timed out after 90000ms: initialize', SDK_STACK)),
    ).toBe(true);
  });

  it('suppresses a timeout on any method (prompt, newSession, …)', () => {
    expect(
      isAcpStreamRace(err('ACP request timed out after 30000ms: prompt', SDK_STACK)),
    ).toBe(true);
  });

  it('does NOT suppress a matching message from outside the SDK acp stream', () => {
    expect(isAcpStreamRace(err('ACP stream closed', OTHER_STACK))).toBe(false);
    expect(
      isAcpStreamRace(err('ACP request timed out after 90000ms: initialize', OTHER_STACK)),
    ).toBe(false);
  });

  it('does NOT suppress unrelated errors even from the SDK stack', () => {
    expect(isAcpStreamRace(err('TypeError: cannot read x', SDK_STACK))).toBe(false);
    // "timed out" without the exact "after Nms" shape must not match.
    expect(isAcpStreamRace(err('ACP request timed out', SDK_STACK))).toBe(false);
  });

  it('does NOT suppress non-Error rejections', () => {
    expect(isAcpStreamRace('ACP stream closed')).toBe(false);
    expect(isAcpStreamRace(undefined)).toBe(false);
    expect(isAcpStreamRace({ message: 'ACP stream closed' })).toBe(false);
  });
});
