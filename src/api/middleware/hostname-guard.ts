import type { FastifyInstance } from "fastify";

/**
 * Hostname guard — defense-in-depth middleware that validates the Host header
 * against the instance's configured URL. Prevents a machine from accidentally
 * (or maliciously) serving content for a different hive in a shared hosting
 * environment.
 *
 * Exempts health check and well-known endpoints so infrastructure probes
 * and service discovery still work.
 */
export function registerHostnameGuard(
  fastify: FastifyInstance,
  instanceUrl: string | undefined,
): void {
  if (!instanceUrl) return;

  let expectedHost: string;
  try {
    expectedHost = new URL(instanceUrl).host;
  } catch {
    return; // Invalid URL — skip guard
  }

  const exemptPaths = new Set(["/health", "/.well-known/openhive.json"]);

  fastify.addHook("onRequest", async (request, reply) => {
    if (exemptPaths.has(request.url)) return;

    const host = request.hostname;
    if (host && host !== expectedHost) {
      return reply.status(421).send({
        error: "Misdirected Request",
        message: "This request was sent to the wrong server",
      });
    }
  });
}
