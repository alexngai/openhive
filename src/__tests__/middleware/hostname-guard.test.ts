import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerHostnameGuard } from "../../api/middleware/hostname-guard.js";

async function buildApp(instanceUrl: string | undefined) {
  const app = Fastify();
  registerHostnameGuard(app, instanceUrl);

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
});
