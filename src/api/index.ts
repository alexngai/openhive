import { FastifyInstance } from "fastify";
import { agentsRoutes } from "./routes/agents.js";
import { hivesRoutes } from "./routes/hives.js";
import { uploadsRoutes } from "./routes/uploads.js";
import { authRoutes } from "./routes/auth.js";
import { federationRoutes } from "./routes/federation.js";
import { adminRoutes } from "./routes/admin.js";
import { memoryBanksRoutes } from "./routes/memory-banks.js";
import { resourcesRoutes } from "./routes/resources.js";
import { resourceContentRoutes } from "./routes/resource-content.js";
import { webhooksRoutes } from "./routes/webhooks.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { mapRoutes } from "./routes/map.js";
import { swarmHostingRoutes } from "./routes/swarm-hosting.js";
import { syncRoutes } from "./routes/sync.js";
import { bridgesRoutes } from "./routes/bridges.js";
import { cascadeRoutes } from "./routes/cascade.js";
import { eventsRoutes } from "./routes/events.js";
import { coordinationRoutes } from "./routes/coordination.js";
import { mailRoutes } from "./routes/mail.js";
import { learningRoutes } from "./routes/learning.js";
import { swarmkitConfigRoutes } from "./routes/swarmkit-config.js";
import { skillManagementRoutes } from "./routes/skill-management.js";
import { specsRoutes } from "./routes/specs.js";
import { dispatchesRoutes } from "./routes/dispatches.js";
import { teamsRoutes } from "./routes/teams.js";
import { loadoutsRoutes } from "./routes/loadouts.js";
import { reposRoutes } from "./routes/repos.js";
import { versionRoutes } from "./routes/version.js";
import type { Config } from "../config.js";
import type { BridgeManager } from "../bridge/manager.js";
import type { SwarmHubConnector } from "../swarmhub/connector.js";

export async function registerRoutes(
  fastify: FastifyInstance,
  config: Config,
  bridgeManager?: BridgeManager,
  swarmhubConnector?: SwarmHubConnector | null,
): Promise<void> {
  // Health check
  fastify.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  // API v1 routes
  await fastify.register(
    async (api) => {
      await api.register(agentsRoutes, { config });
      await api.register(hivesRoutes);
      await api.register(uploadsRoutes);
      await api.register(authRoutes, {
        config: {
          authMode: config.auth.mode,
          swarmhubApiUrl:
            config.swarmhub.apiUrl || process.env.SWARMHUB_API_URL,
          swarmhubOAuthClientId: config.swarmhub.oauth.clientId,
          swarmhubOAuthClientSecret: config.swarmhub.oauth.clientSecret,
        },
        swarmhubConnector,
      });
      await api.register(federationRoutes, { config });
      await api.register(adminRoutes, { config });
      await api.register(memoryBanksRoutes, { config });
      await api.register(resourcesRoutes, { config });
      await api.register(resourceContentRoutes, { config });
      await api.register(webhooksRoutes, { config });
      await api.register(sessionsRoutes, { config });
      await api.register(mapRoutes, { config });
      await api.register(swarmHostingRoutes, { config });
      await api.register(syncRoutes, { config });
      await api.register(bridgesRoutes, { config, bridgeManager });
      await api.register(cascadeRoutes);
      await api.register(eventsRoutes);
      await api.register(coordinationRoutes, { config });
      await api.register(mailRoutes, { config });
      await api.register(learningRoutes, { config });
      await api.register(swarmkitConfigRoutes, { config });
      await api.register(skillManagementRoutes, { config });
      await api.register(specsRoutes, { config });
      await api.register(dispatchesRoutes, { config });
      await api.register(teamsRoutes, { config });
      await api.register(loadoutsRoutes, { config });
      await api.register(reposRoutes, { config });
      await api.register(versionRoutes);
      if (swarmhubConnector) {
        const { swarmhubRoutes, swarmhubWebhookRoutes } =
          await import("../swarmhub/routes.js");
        await api.register(swarmhubRoutes, { connector: swarmhubConnector });
        await api.register(swarmhubWebhookRoutes, {
          connector: swarmhubConnector,
        });
      }
    },
    { prefix: "/api/v1" },
  );
}
