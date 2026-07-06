import type { FastifyInstance } from "fastify";

/**
 * Hostname guard — defense-in-depth middleware that validates the Host header
 * against the instance's configured URL. Prevents a machine from accidentally
 * (or maliciously) serving content for a different hive in a shared hosting
 * environment.
 *
 * `allowedHosts` widens the accepted set beyond `instanceUrl`'s host — used so
 * a hub whose `url` is its public domain can still be reached over LAN /
 * Tailscale (by IP or MagicDNS name) by a remote client.
 *
 * Exempts health check and well-known endpoints so infrastructure probes
 * and service discovery still work.
 */
export function registerHostnameGuard(
  fastify: FastifyInstance,
  instanceUrl: string | undefined,
  allowedHosts: string[] = [],
): void {
  if (!instanceUrl) return;

  let expectedHost: string;
  try {
    expectedHost = new URL(instanceUrl).host;
  } catch {
    return; // Invalid URL — skip guard
  }

  // Compare host identity port-agnostically. Fastify's `request.hostname`
  // drops the port, whereas `new URL(...).host` and allowlist entries commonly
  // carry one (e.g. `mini.tailnet.ts.net:7836`), so normalize both sides.
  const stripPort = (h: string): string => h.replace(/:\d+$/, "");

  // Accepted Host values: the instance URL's host plus any explicitly
  // allowlisted hosts a remote client uses to reach this same hub.
  const permitted = new Set<string>(
    [expectedHost, ...allowedHosts].map(stripPort),
  );

  const exemptPaths = new Set(["/health", "/.well-known/openhive.json"]);

  fastify.addHook("onRequest", async (request, reply) => {
    if (exemptPaths.has(request.url)) return;

    const host = request.hostname ? stripPort(request.hostname) : request.hostname;
    if (host && !permitted.has(host)) {
      return reply.status(421).send({
        error: "Misdirected Request",
        message: "This request was sent to the wrong server",
      });
    }
  });
}
