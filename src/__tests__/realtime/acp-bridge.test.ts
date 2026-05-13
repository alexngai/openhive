/**
 * Integration tests for `installAcpBridge` (src/realtime/acp-bridge.ts).
 *
 * Pairs with the bridge-logic unit tests in
 * `src/__tests__/map/acp-ws-bridge.test.ts`. Those test the LOGIC of
 * the wrapper using a copy of it (`createBridge`); these test the
 * actual production helper that server.ts installs at boot, so a
 * refactor that breaks the wiring is caught here even if the logic
 * tests still pass.
 *
 * Why this matters for P3: the chat-surface verification gap (P3.4)
 * was that nothing in the test suite actually exercised the wsHub →
 * broadcastToChannel path with a `permission_request` payload. The
 * unit tests prove the bridge logic forwards anything with
 * `type.startsWith("acp.")`; this proves the production installer
 * actually replaces wsHub.broadcast with that logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { installAcpBridge } from "../../realtime/acp-bridge.js";

interface WsHub {
  broadcast: (message: unknown, topic?: string) => void;
}

describe("installAcpBridge — production bridge installer", () => {
  let wsHub: WsHub;
  let origBroadcast: ReturnType<typeof vi.fn>;
  let broadcastToChannel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    origBroadcast = vi.fn();
    broadcastToChannel = vi.fn();
    wsHub = { broadcast: origBroadcast };
  });

  it("replaces wsHub.broadcast with a wrapper that calls the original", () => {
    installAcpBridge(wsHub, broadcastToChannel);

    // wsHub.broadcast is no longer the same function reference.
    expect(wsHub.broadcast).not.toBe(origBroadcast);

    wsHub.broadcast({ type: "anything" }, "any-topic");
    expect(origBroadcast).toHaveBeenCalledWith({ type: "anything" }, "any-topic");
  });

  it("forwards acp.session.update from topic='acp' to global channel", () => {
    installAcpBridge(wsHub, broadcastToChannel);

    const payload = { streamId: "s-1", update: { content: { text: "hello" } } };
    wsHub.broadcast({ type: "acp.session.update", payload }, "acp");

    expect(broadcastToChannel).toHaveBeenCalledWith("global", {
      type: "acp.session.update",
      data: payload,
    });
  });

  // Closes the P3.4 gap — confirms permission_request payloads ride
  // through the production bridge intact.
  it("forwards acp.session.update carrying a permission_request payload (chat dialog path)", () => {
    installAcpBridge(wsHub, broadcastToChannel);

    const payload = {
      streamId: "stream-chat-1",
      sessionId: "sess-chat-1",
      update: {
        sessionUpdate: "permission_request",
        requestId: "perm-1",
        toolCall: {
          toolCallId: "toolu_1",
          title: "Read /tmp/sensitive.txt",
          kind: "read",
          status: "pending",
          rawInput: { file_path: "/tmp/sensitive.txt" },
        },
        options: [
          { kind: "allow_always", optionId: "allow_always" },
          { kind: "allow_once", optionId: "allow" },
          { kind: "reject_once", optionId: "reject" },
        ],
      },
    };

    wsHub.broadcast({ type: "acp.session.update", payload }, "acp");

    expect(broadcastToChannel).toHaveBeenCalledWith("global", {
      type: "acp.session.update",
      data: payload,
    });
    const lastCall = broadcastToChannel.mock.calls.at(-1);
    expect((lastCall?.[1] as any)?.data?.update?.sessionUpdate).toBe(
      "permission_request",
    );
    expect((lastCall?.[1] as any)?.data?.update?.requestId).toBe("perm-1");
    expect((lastCall?.[1] as any)?.data?.update?.options).toHaveLength(3);
  });

  it("does NOT forward acp events from non-acp topics (avoids duplicate fan-out)", () => {
    installAcpBridge(wsHub, broadcastToChannel);

    wsHub.broadcast({ type: "acp.session.update", payload: {} }, "events");

    expect(origBroadcast).toHaveBeenCalledTimes(1);
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it("does NOT forward non-acp events", () => {
    installAcpBridge(wsHub, broadcastToChannel);

    wsHub.broadcast({ type: "agent.registered", payload: {} }, "acp");
    wsHub.broadcast({ type: "agent.state.changed" }, "acp");

    expect(origBroadcast).toHaveBeenCalledTimes(2);
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it("returns a teardown that stops forwarding (restores pass-through)", () => {
    const teardown = installAcpBridge(wsHub, broadcastToChannel);
    const wrapped = wsHub.broadcast;
    expect(wrapped).not.toBe(origBroadcast);

    teardown();

    // After teardown, the original spy still receives calls (the bound
    // restoration delegates to it) but no forwarding to the global channel.
    wsHub.broadcast({ type: "acp.session.update", payload: {} }, "acp");
    expect(origBroadcast).toHaveBeenCalledTimes(1);
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it("handles malformed messages without crashing", () => {
    installAcpBridge(wsHub, broadcastToChannel);

    wsHub.broadcast(null, "acp");
    wsHub.broadcast(undefined, "acp");
    wsHub.broadcast({}, "acp");
    wsHub.broadcast({ type: 42 }, "acp");
    wsHub.broadcast({ type: "" }, "acp");

    expect(origBroadcast).toHaveBeenCalledTimes(5);
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });
});
