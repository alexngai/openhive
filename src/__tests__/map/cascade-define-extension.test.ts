/**
 * MAP consolidation Phase 2 fit-test — defineExtension mounts OpenHive's
 * cascade methods with NO bypass.
 *
 * OpenHive's hub-driven pattern (src/map/map-server-setup.ts) builds a
 * per-method HandlerRegistry by looping CASCADE_METHOD_SET, each handler
 * closing over hub state (rate limiter + handleCascadeRequest + the
 * ctx.session.metadata swarmId/agentId). That is exactly the shape
 * defineExtension.handlers(impl) consumes.
 *
 * This reproduces that construction verbatim, wraps it with
 * cascadeExtension.handlers(), mounts it on a real MAPServer, and round-trips a
 * cascade call from a client — proving the framework fits the pattern (the only
 * delta vs. today is the .handlers() wrapper, which validates the prefix and
 * returns the same registry; the hub-closing handlers are untouched).
 *
 * Runs against the pre-publish SDK via the node_modules symlink.
 */
import { describe, it, expect, vi } from "vitest";
import {
  defineExtension,
  ClientConnection,
  createStreamPair,
} from "@multi-agent-protocol/sdk";
import { MAPServer } from "@multi-agent-protocol/sdk/server";
import { CASCADE_METHODS, CASCADE_METHOD_SET } from "../../map/cascade-types.js";

const cascadeExtension = defineExtension({
  name: "x-cascade",
  uri: "urn:map:ext:x-cascade:0",
  methodPrefix: "x-cascade/",
});

describe("defineExtension fit-test: OpenHive cascade", () => {
  it("cascade methods are under the x-cascade/ prefix (sanity)", () => {
    expect(CASCADE_METHODS.STREAM_PAUSED.startsWith("x-cascade/")).toBe(true);
    for (const m of CASCADE_METHOD_SET) expect(m.startsWith("x-cascade/")).toBe(true);
  });

  it("handlers() rejects a non-cascade method (prefix is load-bearing)", () => {
    expect(() =>
      cascadeExtension.handlers({ "mail/create": async () => ({}) }),
    ).toThrow(/outside methodPrefix/);
  });

  it("mounts the real hub-driven handler map and round-trips with no bypass", async () => {
    // Stand-ins for the hub services the real handlers close over.
    const consumeCascadeToken = vi.fn(() => true); // rate limiter: allow
    const dispatch = vi.fn(() => ({ ok: true, stream_row_id: "row-1" })); // handleCascadeRequest

    // Built EXACTLY as map-server-setup.ts builds it (per-method, hub-closing).
    const cascadeHandlers: Record<string, (p: any, c: any) => Promise<unknown>> = {};
    for (const method of CASCADE_METHOD_SET) {
      cascadeHandlers[method] = async (params: any, ctx: any) => {
        const swarmId = ctx.session?.metadata?.swarmId;
        const agentId = ctx.session?.metadata?.agentId;
        if (!consumeCascadeToken(swarmId ?? "")) {
          throw Object.assign(new Error("rate limited"), { code: -32005 });
        }
        return dispatch(method, params, { swarmId, agentId });
      };
    }

    const server = new MAPServer({
      name: "OpenHiveFitTest",
      // The whole integration. Today this is `additionalHandlers: cascadeHandlers`;
      // the only change is the .handlers() wrapper — no bypass.
      additionalHandlers: cascadeExtension.handlers(cascadeHandlers),
      capabilities: cascadeExtension.capabilityFragment() as any,
    });
    expect(server.handlers[CASCADE_METHODS.STREAM_PAUSED]).toBeDefined();

    const [clientStream, serverStream] = createStreamPair();
    server.accept(serverStream, { role: "agent" }).start();
    const client = new ClientConnection(clientStream, { name: "sidecar" });
    await client.connect();

    const params = { stream_id: "s1", reason: "fit-test" };
    const res = await client.callExtension(CASCADE_METHODS.STREAM_PAUSED, params);

    expect(res).toEqual({ ok: true, stream_row_id: "row-1" });
    expect(dispatch).toHaveBeenCalledWith(
      CASCADE_METHODS.STREAM_PAUSED,
      params,
      expect.any(Object),
    );

    await client.disconnect();
  });

  it("capabilityFragment() advertises the cascade extension URI", () => {
    expect(cascadeExtension.capabilityFragment().extensions).toContainEqual({
      uri: "urn:map:ext:x-cascade:0",
    });
  });
});
