import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerHostnameGuard } from "../../api/middleware/hostname-guard.js";

async function buildApp(instanceUrl: string | undefined, allowedHosts?: string[]) {
  const app = Fastify();
  registerHostnameGuard(app, instanceUrl, allowedHosts);

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/.well-known/openhive.json", async () => ({ version: "1.0" }));
  app.get("/api/v1/test", async () => ({ data: "ok" }));

  await app.ready();
  return app;
}

describe("hostname-guard", () => {
  it("allows requests with matching Host header", async () => {
    const app = await buildApp("https://test.hive.swarmkit.ai");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/test",
      headers: { host: "test.hive.swarmkit.ai" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects requests with mismatched Host header", async () => {
    const app = await buildApp("https://test.hive.swarmkit.ai");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/test",
      headers: { host: "other.hive.swarmkit.ai" },
    });
    expect(res.statusCode).toBe(421);
    expect(res.json().error).toBe("Misdirected Request");
    await app.close();
  });

  it("exempts /health endpoint", async () => {
    const app = await buildApp("https://test.hive.swarmkit.ai");
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { host: "other.hive.swarmkit.ai" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("exempts /.well-known/openhive.json endpoint", async () => {
    const app = await buildApp("https://test.hive.swarmkit.ai");
    const res = await app.inject({
      method: "GET",
      url: "/.well-known/openhive.json",
      headers: { host: "other.hive.swarmkit.ai" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("skips guard when instanceUrl is undefined", async () => {
    const app = await buildApp(undefined);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/test",
      headers: { host: "anything.example.com" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("accepts a Host in allowedHosts (LAN / Tailscale reach of the same hub)", async () => {
    const app = await buildApp("https://test.hive.swarmkit.ai", [
      "100.101.102.103:7836",
      "mini.tailnet.ts.net:7836",
    ]);
    for (const host of ["100.101.102.103:7836", "mini.tailnet.ts.net:7836"]) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/test",
        headers: { host },
      });
      expect(res.statusCode).toBe(200);
    }
    // The canonical host still works alongside the allowlist.
    const canonical = await app.inject({
      method: "GET",
      url: "/api/v1/test",
      headers: { host: "test.hive.swarmkit.ai" },
    });
    expect(canonical.statusCode).toBe(200);
    await app.close();
  });

  it("still rejects a Host that is neither the instance URL nor allowlisted", async () => {
    const app = await buildApp("https://test.hive.swarmkit.ai", [
      "100.101.102.103:7836",
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/test",
      headers: { host: "evil.example.com" },
    });
    expect(res.statusCode).toBe(421);
    await app.close();
  });
});
