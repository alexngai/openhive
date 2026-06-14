/**
 * MAP core conformance against OpenHive's MAPServer.
 *
 * OpenHive runs the SDK's MAPServer (see src/map/map-server-setup.ts:
 * initMapServer → new MAPServer({...})). The core methods are SDK defaults;
 * OpenHive only adds extension handlers via additionalHandlers, which don't
 * affect core conformance. This boots a MAPServer with OpenHive's config shape
 * (resources enabled) and runs the shared core conformance suite from the SDK
 * — proving OpenHive's hub server passes core conformance, the second
 * deployment alongside the SDK's own MAPServer test.
 *
 * Runs against the pre-publish SDK via the node_modules symlink.
 */
import { describe, it, expect } from "vitest";
import {
  runCoreConformance,
  type CoreConformancePair,
} from "@multi-agent-protocol/sdk/conformance";
import { MAPServer } from "@multi-agent-protocol/sdk/server";
import {
  AgentConnection,
  ClientConnection,
  createStreamPair,
} from "@multi-agent-protocol/sdk";

async function openhivePair(): Promise<CoreConformancePair> {
  // Configured the way OpenHive's initMapServer configures it.
  const server = new MAPServer({
    name: "OpenHive",
    version: "0.1.0",
    resources: { enabled: true, kinds: ["x-workspace/repo"] },
  });

  const [aStream, aServer] = createStreamPair();
  server.accept(aServer, { role: "agent" }).start();
  const agent = new AgentConnection(aStream, { name: "worker", role: "worker" });
  const reg = await agent.connect();

  const [cStream, cServer] = createStreamPair();
  server.accept(cServer, { role: "client" }).start();
  const client = new ClientConnection(cStream, { name: "observer" });
  await client.connect();

  return { client, agentId: reg.agent.id };
}

runCoreConformance(
  { describe, it, expect },
  openhivePair,
  "OpenHive MAPServer (resources-enabled config)",
);
