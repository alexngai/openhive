import { useState, useEffect, useMemo, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  Zap,
  Square,
  RotateCw,
  ChevronDown,
  ChevronUp,
  Plus,
  X,
  Cpu,
  Link2,
  Loader2,
  Globe,
  Wifi,
  WifiOff,
  Settings2,
  Trash2,
  Shield,
  GitBranch,
  Monitor,
  User,
  UserRoundPlus,
} from "lucide-react";
import {
  uniqueNamesGenerator,
  adjectives,
  colors,
  animals,
} from "unique-names-generator";
import { toast } from "../stores/toast";
import {
  useHostedSwarms,
  useSpawnSwarm,
  useStopSwarm,
  useRestartSwarm,
  useRemoveSwarm,
  useMapSwarms,
  useConnectSwarm,
  useHives,
  useSpawnAgent,
  useConnectAcp,
  useKnownProjectPaths,
} from "../hooks/useApi";
import { useSwarmRealtime } from "../hooks/useRealtimeInvalidation";
import {
  PageLoader,
  LoadingSpinner,
} from "../components/common/LoadingSpinner";
import { Dialog } from "../components/common/Dialog";
import { TimeAgo } from "../components/common/TimeAgo";
import {
  HostedStateBadge,
  MapStatusBadge,
  SandboxBadge,
  SectionLabel,
} from "../components/swarm/StatusBadges";
import type { HostedSwarm, MapSwarm, MapRegisteredAgent } from "../lib/api";
import { getPeerMapId } from "../lib/map";

const PROVIDERS = [
  { value: "local", label: "Local", desc: "Sidecar process on this machine" },
  {
    value: "local-sandboxed",
    label: "Local (Sandbox)",
    desc: "Sandboxed process with OS-level isolation",
  },
  { value: "docker", label: "Docker", desc: "Docker container" },
  { value: "fly", label: "Fly.io", desc: "Fly.io machine" },
  { value: "ssh", label: "SSH", desc: "Remote host via SSH" },
  { value: "k8s", label: "K8s", desc: "Kubernetes pod" },
] as const;

const TRANSPORTS = [
  { value: "websocket", label: "WebSocket" },
  { value: "http-sse", label: "HTTP SSE" },
  { value: "ndjson", label: "NDJSON" },
] as const;

const AUTH_METHODS = [
  { value: "none", label: "None" },
  { value: "bearer", label: "Bearer Token" },
  { value: "api-key", label: "API Key" },
  { value: "mtls", label: "mTLS" },
] as const;

// =============================================================================
// Sandbox Policy Info (shown in Advanced section for sandboxed provider)
// =============================================================================

function SandboxPolicyFields() {
  return (
    <div className="space-y-2">
      <div
        className="flex items-center gap-1.5 text-xs font-medium"
        style={{ color: "var(--color-text-secondary)" }}
      >
        <Shield className="w-3 h-3 text-blue-400" />
        Sandbox Policy
      </div>
      <div className="space-y-1.5">
        <PolicyRow
          label="Filesystem"
          desc="Writes restricted to swarm data directory; sensitive paths (~/.ssh, ~/.gnupg, ~/.aws) denied"
        />
        <PolicyRow
          label="Network"
          desc="Domain allowlist enforced via proxy — only configured domains are reachable"
        />
        <PolicyRow
          label="Hive overrides"
          desc="Hive-specific policies (e.g. allowed domains) are applied when auto-joining a hive"
        />
      </div>
      <p className="text-2xs" style={{ color: "var(--color-text-muted)" }}>
        Sandbox policies are configured server-side in openhive.config.js under
        swarmHosting.sandbox. Per-hive overrides apply automatically based on
        the selected hive.
      </p>
    </div>
  );
}

function PolicyRow({ label, desc }: { label: string; desc: string }) {
  return (
    <div className="flex items-baseline gap-2 text-2xs">
      <span
        className="shrink-0 px-1.5 py-0.5 rounded font-medium"
        style={{
          backgroundColor: "var(--color-elevated)",
          color: "var(--color-text-secondary)",
        }}
      >
        {label}
      </span>
      <span style={{ color: "var(--color-text-muted)" }}>{desc}</span>
    </div>
  );
}

// =============================================================================
// Spawn Form
// =============================================================================

interface WorkspaceRepoEntry {
  url: string;
  branch: string;
  path: string;
  depth: string;
}

const emptyRepo = (): WorkspaceRepoEntry => ({
  url: "",
  branch: "",
  path: "",
  depth: "",
});

export function SpawnFormDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState(() =>
    uniqueNamesGenerator({
      dictionaries: [adjectives, colors, animals],
      separator: "-",
      length: 3,
    }),
  );
  const [description, setDescription] = useState("");
  const [adapter, setAdapter] = useState("");
  const [hive, setHive] = useState("");
  const [provider, setProvider] = useState("local");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [adapterConfigRaw, setAdapterConfigRaw] = useState("");
  const [metadataRaw, setMetadataRaw] = useState("");
  const [workspaceRepos, setWorkspaceRepos] = useState<WorkspaceRepoEntry[]>(
    [],
  );
  // Boot-time agent provisioning (opt-in). When `bootstrapCoordinator` is
  // true, openhive sets MACRO_BOOTSTRAP_COORDINATOR + MACRO_BOOTSTRAP_CWD on
  // the spawned openswarm process so macro-agent's bootV2 fires a default
  // coordinator at `projectDirectory` — no separate _macro/spawnAgent call.
  const [projectDirectory, setProjectDirectory] = useState("");
  const [bootstrapCoordinator, setBootstrapCoordinator] = useState(false);

  const isSandboxed = provider === "local-sandboxed";

  // Auto-expand Advanced when switching to sandboxed provider
  useEffect(() => {
    if (isSandboxed && !showAdvanced) {
      setShowAdvanced(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSandboxed]);

  const spawnMutation = useSpawnSwarm();
  const { data: hives } = useHives({ sort: "popular", limit: 50 });
  const { data: knownProjectPaths } = useKnownProjectPaths();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    let adapter_config: Record<string, unknown> | undefined;
    let metadata: Record<string, unknown> | undefined;

    if (adapterConfigRaw.trim()) {
      try {
        adapter_config = JSON.parse(adapterConfigRaw);
      } catch {
        toast.error("Invalid JSON", "Adapter config must be valid JSON.");
        return;
      }
    }
    if (metadataRaw.trim()) {
      try {
        metadata = JSON.parse(metadataRaw);
      } catch {
        toast.error("Invalid JSON", "Metadata must be valid JSON.");
        return;
      }
    }

    // Build workspace config from repo entries
    const validRepos = workspaceRepos
      .filter((r) => r.url.trim())
      .map((r) => {
        const repo: {
          url: string;
          branch?: string;
          path?: string;
          depth?: number;
        } = {
          url: r.url.trim(),
        };
        if (r.branch.trim()) repo.branch = r.branch.trim();
        if (r.path.trim()) repo.path = r.path.trim();
        if (r.depth.trim()) {
          const d = parseInt(r.depth, 10);
          if (d > 0) repo.depth = d;
        }
        return repo;
      });

    const trimmedProjectDir = projectDirectory.trim();
    const bootstrap = bootstrapCoordinator
      ? {
          coordinator: true as const,
          ...(trimmedProjectDir ? { cwd: trimmedProjectDir } : {}),
        }
      : undefined;

    try {
      await spawnMutation.mutateAsync({
        name,
        description: description || undefined,
        adapter: adapter || undefined,
        hive: hive || undefined,
        provider: provider !== "local" ? provider : undefined,
        adapter_config,
        metadata,
        workspace: validRepos.length > 0 ? { repos: validRepos } : undefined,
        bootstrap,
      });
      toast.success("Swarm spawned", `"${name}" is starting up.`);
      onClose();
    } catch (err) {
      toast.error("Spawn failed", (err as Error).message);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="max-w-xl">
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-honey-500" />
            Spawn Swarm
          </h2>
          <button onClick={onClose} className="btn btn-ghost p-1">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Row 1: Name + Provider */}
          <div className="flex gap-3">
            <div className="flex-1">
              <SectionLabel>
                Name <span className="text-red-400">*</span>
              </SectionLabel>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input w-full"
                placeholder="my-research-swarm"
                required
                maxLength={100}
              />
            </div>
            <div className="w-48">
              <SectionLabel>Provider</SectionLabel>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="input w-full"
              >
                {PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <p
                className="text-2xs mt-0.5"
                style={{ color: "var(--color-text-muted)" }}
              >
                {PROVIDERS.find((p) => p.value === provider)?.desc}
              </p>
            </div>
          </div>

          {/* Sandbox info callout */}
          {isSandboxed && (
            <div
              className="flex items-start gap-2 px-3 py-2 rounded-md text-xs"
              style={{
                backgroundColor: "rgba(59, 130, 246, 0.08)",
                border: "1px solid rgba(59, 130, 246, 0.15)",
              }}
            >
              <Shield className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-medium text-blue-400">
                  Sandbox enabled
                </span>
                <span style={{ color: "var(--color-text-secondary)" }}>
                  {" "}
                  &mdash; process will run with OS-level filesystem and network
                  restrictions (bubblewrap on Linux, seatbelt on macOS).
                  Configure allowed domains and paths in Advanced.
                </span>
              </div>
            </div>
          )}

          {/* Row 2: Description */}
          <div>
            <SectionLabel>Description</SectionLabel>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="input w-full"
              placeholder="What this swarm does..."
              maxLength={500}
            />
          </div>

          {/* Row 3: Adapter + Hive */}
          <div className="flex gap-3">
            <div className="flex-1">
              <SectionLabel>Adapter</SectionLabel>
              <input
                type="text"
                value={adapter}
                onChange={(e) => setAdapter(e.target.value)}
                className="input w-full"
                placeholder="macro-agent"
                maxLength={100}
              />
              <p
                className="text-2xs mt-0.5"
                style={{ color: "var(--color-text-muted)" }}
              >
                Defaults to macro-agent
              </p>
            </div>
            <div className="flex-1">
              <SectionLabel>Auto-join Hive</SectionLabel>
              <select
                value={hive}
                onChange={(e) => setHive(e.target.value)}
                className="input w-full"
              >
                <option value="">None</option>
                {hives?.map((h) => (
                  <option key={h.id} value={h.name}>
                    {h.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Project directory + auto-spawn coordinator */}
          <div className="space-y-2">
            <div>
              <SectionLabel>Project directory</SectionLabel>
              <input
                type="text"
                value={projectDirectory}
                onChange={(e) => setProjectDirectory(e.target.value)}
                className="input w-full font-mono text-2xs"
                placeholder="/path/to/your/project (optional)"
                list="known-project-paths"
                autoComplete="off"
                spellCheck={false}
              />
              {/* Suggest paths previously used by other swarms / hosted bootstraps. */}
              {knownProjectPaths && knownProjectPaths.length > 0 && (
                <datalist id="known-project-paths">
                  {knownProjectPaths.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              )}
              <p
                className="text-2xs mt-0.5"
                style={{ color: "var(--color-text-muted)" }}
              >
                Optional. If set, the auto-spawned coordinator runs from this
                cwd; otherwise it falls back to the swarm's data directory.
                {knownProjectPaths && knownProjectPaths.length > 0 && (
                  <>
                    {" "}
                    <span style={{ opacity: 0.7 }}>
                      ({knownProjectPaths.length} known{" "}
                      {knownProjectPaths.length === 1 ? "path" : "paths"} —
                      start typing to autocomplete)
                    </span>
                  </>
                )}
              </p>
            </div>
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={bootstrapCoordinator}
                onChange={(e) => setBootstrapCoordinator(e.target.checked)}
                className="mt-0.5 cursor-pointer"
              />
              <div className="text-2xs">
                <span style={{ color: "var(--color-text)" }}>
                  Auto-spawn a coordinator on startup
                </span>
                <p style={{ color: "var(--color-text-muted)" }}>
                  Spawns a default head-manager coordinator on boot so the swarm
                  is chat-ready without an explicit Spawn Agent click. Uses the
                  project directory above if set, else the swarm's data
                  directory. Runs with{" "}
                  <code
                    className="px-1 rounded"
                    style={{ backgroundColor: "var(--color-elevated)" }}
                  >
                    auto-approve
                  </code>{" "}
                  permission mode (tools execute without prompts).
                </p>
              </div>
            </label>
          </div>

          {/* Workspace (Git Repos) */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <SectionLabel>
                <span className="flex items-center gap-1">
                  <GitBranch className="w-3 h-3" />
                  Workspace Repos
                </span>
              </SectionLabel>
              {workspaceRepos.length === 0 && (
                <button
                  type="button"
                  onClick={() => setWorkspaceRepos([emptyRepo()])}
                  className="text-2xs text-honey-500 hover:text-honey-400 transition-colors"
                >
                  + Add repo
                </button>
              )}
            </div>

            {workspaceRepos.length === 0 ? (
              <p
                className="text-2xs"
                style={{ color: "var(--color-text-muted)" }}
              >
                Optionally clone git repos into the swarm's working directory
                before it starts.
              </p>
            ) : (
              <div className="space-y-2">
                {workspaceRepos.map((repo, i) => (
                  <div
                    key={i}
                    className="space-y-1.5 p-2 rounded-md"
                    style={{ backgroundColor: "var(--color-elevated)" }}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={repo.url}
                        onChange={(e) => {
                          const updated = [...workspaceRepos];
                          updated[i] = { ...updated[i], url: e.target.value };
                          setWorkspaceRepos(updated);
                        }}
                        className="input flex-1 font-mono text-xs"
                        placeholder="https://github.com/org/repo.git"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setWorkspaceRepos(
                            workspaceRepos.filter((_, j) => j !== i),
                          )
                        }
                        className="btn btn-ghost p-1 text-red-400 hover:bg-red-500/10"
                        title="Remove repo"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={repo.branch}
                        onChange={(e) => {
                          const updated = [...workspaceRepos];
                          updated[i] = {
                            ...updated[i],
                            branch: e.target.value,
                          };
                          setWorkspaceRepos(updated);
                        }}
                        className="input flex-1 text-2xs"
                        placeholder="Branch (default)"
                      />
                      <input
                        type="text"
                        value={repo.path}
                        onChange={(e) => {
                          const updated = [...workspaceRepos];
                          updated[i] = { ...updated[i], path: e.target.value };
                          setWorkspaceRepos(updated);
                        }}
                        className="input flex-1 text-2xs"
                        placeholder="Path (root)"
                      />
                      <input
                        type="text"
                        value={repo.depth}
                        onChange={(e) => {
                          const updated = [...workspaceRepos];
                          updated[i] = {
                            ...updated[i],
                            depth: e.target.value.replace(/\D/g, ""),
                          };
                          setWorkspaceRepos(updated);
                        }}
                        className="input w-16 text-2xs"
                        placeholder="Depth"
                      />
                    </div>
                  </div>
                ))}
                {workspaceRepos.length < 10 && (
                  <button
                    type="button"
                    onClick={() =>
                      setWorkspaceRepos([...workspaceRepos, emptyRepo()])
                    }
                    className="text-2xs text-honey-500 hover:text-honey-400 transition-colors flex items-center gap-1"
                  >
                    <Plus className="w-2.5 h-2.5" />
                    Add another repo
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Advanced toggle */}
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-2xs font-medium transition-colors"
            style={{ color: "var(--color-text-muted)" }}
          >
            <Settings2 className="w-3 h-3" />
            Advanced
            {showAdvanced ? (
              <ChevronUp className="w-3 h-3" />
            ) : (
              <ChevronDown className="w-3 h-3" />
            )}
          </button>

          {showAdvanced && (
            <div
              className="space-y-3 pl-3 border-l-2"
              style={{ borderColor: "var(--color-border-subtle)" }}
            >
              {/* Sandbox policy (only shown for sandboxed provider) */}
              {isSandboxed && <SandboxPolicyFields />}

              <div>
                <SectionLabel>Adapter Config (JSON)</SectionLabel>
                <textarea
                  value={adapterConfigRaw}
                  onChange={(e) => setAdapterConfigRaw(e.target.value)}
                  className="input w-full font-mono text-2xs min-h-[60px] resize-y"
                  placeholder='{"model": "claude-sonnet-4-5-20250929", "temperature": 0.7}'
                />
              </div>
              <div>
                <SectionLabel>Metadata (JSON)</SectionLabel>
                <textarea
                  value={metadataRaw}
                  onChange={(e) => setMetadataRaw(e.target.value)}
                  className="input w-full font-mono text-2xs min-h-[60px] resize-y"
                  placeholder='{"team": "research", "project": "docs"}'
                />
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="submit"
              disabled={spawnMutation.isPending || !name.trim()}
              className="btn btn-primary flex items-center gap-1.5 text-xs"
            >
              {spawnMutation.isPending ? (
                <LoadingSpinner size="sm" />
              ) : (
                <Zap className="w-3 h-3" />
              )}
              Spawn
            </button>
            <button
              type="button"
              onClick={onClose}
              className="btn btn-ghost text-xs"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}

// =============================================================================
// Connect Form
// =============================================================================

export function ConnectFormDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [transport, setTransport] = useState<
    "websocket" | "http-sse" | "ndjson"
  >("websocket");
  const [authMethod, setAuthMethod] = useState<
    "bearer" | "api-key" | "mtls" | "none"
  >("none");
  const [authToken, setAuthToken] = useState("");
  const [capabilities, setCapabilities] = useState({
    observation: true,
    messaging: true,
    lifecycle: true,
  });

  const connectMutation = useConnectSwarm();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      await connectMutation.mutateAsync({
        name,
        description: description || undefined,
        map_endpoint: endpoint,
        map_transport: transport,
        capabilities,
        auth_method: authMethod,
        auth_token: authMethod !== "none" ? authToken || undefined : undefined,
      });
      toast.success("Swarm connected", `"${name}" registered in MAP hub.`);
      onClose();
    } catch (err) {
      toast.error("Connect failed", (err as Error).message);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="max-w-lg">
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <Link2 className="w-3.5 h-3.5 text-honey-500" />
            Connect External Swarm
          </h2>
          <button onClick={onClose} className="btn btn-ghost p-1">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Name + Transport */}
          <div className="flex gap-3">
            <div className="flex-1">
              <SectionLabel>
                Name <span className="text-red-400">*</span>
              </SectionLabel>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input w-full"
                placeholder="external-swarm"
                required
                maxLength={100}
              />
            </div>
            <div className="w-36">
              <SectionLabel>Transport</SectionLabel>
              <select
                value={transport}
                onChange={(e) =>
                  setTransport(e.target.value as typeof transport)
                }
                className="input w-full"
              >
                {TRANSPORTS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Endpoint */}
          <div>
            <SectionLabel>
              MAP Endpoint <span className="text-red-400">*</span>
            </SectionLabel>
            <input
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              className="input w-full font-mono text-xs"
              placeholder="ws://192.168.1.50:3000"
              required
            />
            <p
              className="text-2xs mt-0.5"
              style={{ color: "var(--color-text-muted)" }}
            >
              The MAP server endpoint of the swarm to connect
            </p>
          </div>

          {/* Description */}
          <div>
            <SectionLabel>Description</SectionLabel>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="input w-full"
              placeholder="What this swarm does..."
              maxLength={500}
            />
          </div>

          {/* Auth */}
          <div className="flex gap-3">
            <div className="w-36">
              <SectionLabel>Auth Method</SectionLabel>
              <select
                value={authMethod}
                onChange={(e) =>
                  setAuthMethod(e.target.value as typeof authMethod)
                }
                className="input w-full"
              >
                {AUTH_METHODS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
            {authMethod !== "none" && (
              <div className="flex-1">
                <SectionLabel>Auth Token</SectionLabel>
                <input
                  type="password"
                  value={authToken}
                  onChange={(e) => setAuthToken(e.target.value)}
                  className="input w-full font-mono text-xs"
                  placeholder="Token or API key..."
                />
              </div>
            )}
          </div>

          {/* Capabilities */}
          <div>
            <SectionLabel>Capabilities</SectionLabel>
            <div className="flex items-center gap-4 mt-1">
              {(["observation", "messaging", "lifecycle"] as const).map(
                (cap) => (
                  <label
                    key={cap}
                    className="flex items-center gap-1.5 text-xs cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={capabilities[cap]}
                      onChange={(e) =>
                        setCapabilities({
                          ...capabilities,
                          [cap]: e.target.checked,
                        })
                      }
                      className="rounded"
                    />
                    <span className="capitalize">{cap}</span>
                  </label>
                ),
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="submit"
              disabled={
                connectMutation.isPending || !name.trim() || !endpoint.trim()
              }
              className="btn btn-primary flex items-center gap-1.5 text-xs"
            >
              {connectMutation.isPending ? (
                <LoadingSpinner size="sm" />
              ) : (
                <Link2 className="w-3 h-3" />
              )}
              Connect
            </button>
            <button
              type="button"
              onClick={onClose}
              className="btn btn-ghost text-xs"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}

// =============================================================================
// Swarm Cards
// =============================================================================

/**
 * One registered agent rendered inline under a swarm card. Shows name, role,
 * and compact Chat/Stop actions — no swarm-detail round-trip needed.
 * Sidecars are filtered out by the caller.
 */
function InlineAgentRow({
  swarmId,
  agent,
  projectPath,
}: {
  swarmId: string;
  agent: MapRegisteredAgent;
  projectPath?: string;
}) {
  const navigate = useNavigate();
  const connectAcp = useConnectAcp();

  const protocols = Array.isArray(agent.capabilities?.protocols)
    ? (agent.capabilities!.protocols as string[])
    : [];
  const supportsAcp = protocols.includes("acp");

  // Prefer the peer-side map id (the targetable ID on the swarm's own MAP
  // server); fall back to the hub-assigned id.
  const targetAgentId = getPeerMapId(agent.metadata) ?? agent.id;

  const handleChat = async (e: React.MouseEvent) => {
    // Prevent the parent swarm card from navigating to the detail page.
    e.stopPropagation();
    if (!supportsAcp || connectAcp.isPending) return;
    try {
      const result = await connectAcp.mutateAsync({
        swarmId,
        agentId: targetAgentId,
        cwd: projectPath,
      });
      const params = new URLSearchParams({
        streamId: result.acp_stream_id,
        sessionId: result.acp_session_id,
      });
      navigate(`/threads/${result.session_resource_id}?${params}`);
    } catch (err) {
      toast.error("Chat failed", (err as Error).message);
    }
  };

  // The whole row becomes the CTA when the agent supports ACP. We make the
  // hover effect deliberately strong (bg + border + text color) so it reads
  // as an obviously interactive affordance — not a passive row.
  const isClickable = supportsAcp;

  const content = (
    <>
      {connectAcp.isPending ? (
        <LoadingSpinner size="sm" />
      ) : (
        <User
          className="w-3 h-3 shrink-0"
          style={{ color: "var(--color-text-muted)" }}
        />
      )}
      <span
        className={`font-medium truncate max-w-[160px] ${isClickable ? "group-hover:text-honey-500 transition-colors" : ""}`}
      >
        {agent.name || agent.id}
      </span>
      <span
        className="px-1 py-0.5 rounded capitalize"
        style={{ color: "var(--color-text-muted)" }}
      >
        {agent.role}
      </span>
      {protocols.map((p) => (
        <span
          key={p}
          className="px-1 py-0.5 rounded font-medium"
          style={{
            backgroundColor: "var(--color-accent-bg)",
            color: "var(--color-accent)",
          }}
        >
          {p}
        </span>
      ))}
    </>
  );

  if (isClickable) {
    return (
      <div
        // Default bg/border moved to arbitrary Tailwind values so the
        // `hover:bg-*` / `hover:border-*` utilities actually win — inline
        // `style={{ backgroundColor }}` would otherwise beat them on
        // specificity and the hover state would be invisible.
        // Ring on hover adds an outer glow for an extra bump of affordance.
        className="inline-flex items-center gap-2 px-2 py-1 rounded text-2xs transition-all cursor-pointer group border bg-[var(--color-elevated)] border-[var(--color-border)] ring-1 ring-transparent hover:bg-honey-500/10 hover:border-honey-500/50 hover:ring-honey-500/20"
        role="button"
        tabIndex={0}
        onClick={handleChat}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ")
            handleChat(e as unknown as React.MouseEvent);
        }}
        title="Start ACP chat session with this agent"
        aria-label={`Start ACP chat session with ${agent.name || agent.id}`}
      >
        {content}
      </div>
    );
  }

  return (
    <div
      className="inline-flex items-center gap-2 px-2 py-1 rounded text-2xs border border-transparent bg-[var(--color-elevated)]"
      onClick={(e) => e.stopPropagation()}
    >
      {content}
    </div>
  );
}

function HostedSwarmCard({
  swarm,
  linkedMapSwarm,
}: {
  swarm: HostedSwarm;
  linkedMapSwarm?: MapSwarm;
}) {
  const navigate = useNavigate();
  const stopMutation = useStopSwarm();
  const restartMutation = useRestartSwarm();
  const removeMutation = useRemoveSwarm();
  const spawnAgent = useSpawnAgent();
  const connectAcp = useConnectAcp();

  // If there's a linked MAP swarm record (the same macro-agent process seen by
  // SwarmCraft via outbound MAP, or the sidecar's inbound registration), use
  // its ID for navigation so the SwarmDetail page shows live agent data. Also
  // surface agent count + capabilities so the merged card carries the info
  // that used to live under "Registered".
  const targetSwarmId = swarm.swarm_id ?? linkedMapSwarm?.id ?? swarm.id;
  const agentCount = linkedMapSwarm?.agent_count ?? 0;
  const mapStatus = linkedMapSwarm?.status;
  const caps = (linkedMapSwarm?.capabilities || {}) as Record<string, unknown>;
  const protocols = Array.isArray(caps.protocols)
    ? (caps.protocols as string[])
    : [];

  const canStop =
    swarm.state === "running" ||
    swarm.state === "unhealthy" ||
    swarm.state === "starting";
  const canRestart = swarm.state === "stopped" || swarm.state === "failed";
  const canRemove = swarm.state === "stopped" || swarm.state === "failed";
  const isTransitioning =
    stopMutation.isPending ||
    restartMutation.isPending ||
    removeMutation.isPending;

  // "Spawn Agent" is surfaced on the card when the hosted swarm is
  // running AND the linked MAP swarm advertises ACP OR has a sidecar that
  // declares `canHostAcp` (i.e. macro-agent can spawn a coordinator on
  // demand). Same visibility predicate as SwarmDetail's SwarmActions, just
  // reconstructed from the list-view data.
  const registeredAgents = ((linkedMapSwarm as any)?.registered_agents ??
    []) as Array<{ metadata?: Record<string, unknown> }>;
  const canHostAcp = registeredAgents.some(
    (a) => a.metadata?.canHostAcp === true,
  );
  const supportsAcp = protocols.includes("acp");
  const isLinkedOnline = mapStatus === "online" || mapStatus === "unreachable";
  const canStartAgentSession =
    swarm.state === "running" && isLinkedOnline && (supportsAcp || canHostAcp);

  const projectPath =
    ((linkedMapSwarm?.capabilities as any)?.projectPath as
      | string
      | undefined) ??
    ((linkedMapSwarm?.metadata as any)?.projectPath as string | undefined) ??
    ((linkedMapSwarm?.metadata as any)?.cwd as string | undefined);

  // Synchronous gate against fast double-clicks. React Query's isPending
  // flips after the state commit, so a tight click-twice can fire two
  // requests before the disabled attribute lands.
  const inFlightRef = useRef(false);

  // Spawn-only — does not auto-open an ACP session or navigate. The new
  // coordinator card appears on the swarm detail page; user clicks Chat
  // there to start a conversation.
  const handleNewAgentSession = async () => {
    if (!targetSwarmId) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const spawned = await spawnAgent.mutateAsync({
        swarmId: targetSwarmId,
        role: "coordinator",
        cwd: projectPath,
        task: "Head manager",
      });
      toast.success(
        "Coordinator spawned",
        `${spawned.name ?? spawned.agent_id} is ready on ${swarm.name}.`,
      );
    } catch (err) {
      toast.error("Spawn failed", (err as Error).message);
    } finally {
      inFlightRef.current = false;
    }
  };
  const isStarting = spawnAgent.isPending;

  const handleStop = async () => {
    try {
      await stopMutation.mutateAsync(swarm.id);
      toast.success("Swarm stopped", `"${swarm.name}" has been stopped.`);
    } catch (err) {
      toast.error("Stop failed", (err as Error).message);
    }
  };

  const handleRestart = async () => {
    try {
      await restartMutation.mutateAsync(swarm.id);
      toast.success("Swarm restarted", `"${swarm.name}" is restarting.`);
    } catch (err) {
      toast.error("Restart failed", (err as Error).message);
    }
  };

  const handleRemove = async () => {
    try {
      await removeMutation.mutateAsync(swarm.id);
      toast.success("Swarm removed", `"${swarm.name}" has been removed.`);
    } catch (err) {
      toast.error("Remove failed", (err as Error).message);
    }
  };

  return (
    <div
      className="card card-hover px-3 py-2.5 cursor-pointer group"
      onClick={() => navigate(`/swarms/${targetSwarmId}`)}
    >
      <div className="flex items-center gap-3">
        <div
          className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
          style={{ backgroundColor: "var(--color-accent-bg)" }}
        >
          <Cpu className="w-4 h-4 text-honey-500" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium font-mono truncate group-hover:text-honey-500 transition-colors">
              {swarm.id}
            </span>
            <HostedStateBadge state={swarm.state} />
            {mapStatus && <MapStatusBadge status={mapStatus} />}
            <span
              className="text-2xs px-1.5 py-0.5 rounded"
              style={{
                backgroundColor: "var(--color-elevated)",
                color: "var(--color-text-muted)",
              }}
            >
              {swarm.provider === "local-sandboxed" ? "local" : swarm.provider}
            </span>
            {swarm.provider === "local-sandboxed" && <SandboxBadge />}
            {swarm.endpoint === "local-hub" && (
              <span className="text-2xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">
                local
              </span>
            )}
            {protocols.map((p) => (
              <span
                key={p}
                className="text-2xs px-1.5 py-0.5 rounded font-medium"
                style={{
                  backgroundColor: "var(--color-accent-bg)",
                  color: "var(--color-accent)",
                }}
              >
                {p}
              </span>
            ))}
          </div>
          <div
            className="flex items-center gap-2 mt-0.5 text-2xs"
            style={{ color: "var(--color-text-muted)" }}
          >
            <span className="truncate">{swarm.name}</span>
            {swarm.assigned_port && (
              <>
                <span className="opacity-30">&middot;</span>
                <span>:{swarm.assigned_port}</span>
              </>
            )}
            {agentCount > 0 && (
              <>
                <span className="opacity-30">&middot;</span>
                <span>
                  {agentCount} agent{agentCount === 1 ? "" : "s"}
                </span>
              </>
            )}
            <span className="opacity-30">&middot;</span>
            <TimeAgo
              date={
                swarm.updated_at > swarm.created_at
                  ? swarm.updated_at
                  : swarm.created_at
              }
            />
          </div>
        </div>

        <div
          className="flex items-center gap-1 shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          {canStartAgentSession && (
            <button
              onClick={handleNewAgentSession}
              disabled={isStarting || isTransitioning}
              className="btn btn-ghost p-1.5 hover:bg-honey-500/10 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              style={{ color: "var(--color-accent)" }}
              title="Spawn a coordinator on this swarm"
              aria-label="Spawn a coordinator on this swarm"
            >
              {isStarting ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <UserRoundPlus className="w-3 h-3" />
              )}
            </button>
          )}
          {canStop && (
            <button
              onClick={handleStop}
              disabled={isTransitioning}
              className="btn btn-ghost p-1.5 text-red-400 hover:bg-red-500/10"
              title="Stop"
            >
              {stopMutation.isPending ? (
                <LoadingSpinner size="sm" />
              ) : (
                <Square className="w-3 h-3" />
              )}
            </button>
          )}
          {canRestart && (
            <button
              onClick={handleRestart}
              disabled={isTransitioning}
              className="btn btn-ghost p-1.5 hover:bg-emerald-500/10"
              style={{ color: "var(--color-text-secondary)" }}
              title="Restart"
            >
              {restartMutation.isPending ? (
                <LoadingSpinner size="sm" />
              ) : (
                <RotateCw className="w-3 h-3" />
              )}
            </button>
          )}
          {canRemove && (
            <button
              onClick={handleRemove}
              disabled={isTransitioning}
              className="btn btn-ghost p-1.5 text-red-400 hover:bg-red-500/10"
              title="Remove"
            >
              {removeMutation.isPending ? (
                <LoadingSpinner size="sm" />
              ) : (
                <Trash2 className="w-3 h-3" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Inline registered agents (excluding sidecars). Lets users chat with
          or stop a specific coordinator without clicking through to detail.
          Only show when the hosted swarm is actively running — for stopped
          swarms the MAP record may still list stale agents. */}
      {swarm.state === "running" &&
        isLinkedOnline &&
        (() => {
          const liveAgents = registeredAgents.filter(
            (a) => (a as MapRegisteredAgent).role !== "sidecar",
          ) as MapRegisteredAgent[];
          if (liveAgents.length === 0) return null;
          return (
            <div className="mt-2 pl-11 flex flex-col items-start gap-1">
              {liveAgents.map((a) => (
                <InlineAgentRow
                  key={a.id}
                  swarmId={targetSwarmId}
                  agent={a}
                  projectPath={projectPath}
                />
              ))}
            </div>
          );
        })()}

      {swarm.error && (
        <div className="mt-2 px-2 py-1.5 bg-red-500/10 border border-red-500/20 rounded text-2xs text-red-400">
          {swarm.error}
        </div>
      )}
    </div>
  );
}

function MapSwarmCard({ swarm }: { swarm: MapSwarm }) {
  const navigate = useNavigate();
  const meta = swarm.metadata as Record<string, unknown> | null;
  const project = meta?.project as string | undefined;
  const branch = meta?.branch as string | undefined;
  const template = meta?.template as string | undefined;
  const metaType = meta?.type as string | undefined;

  // Build a meaningful display name from the best available data
  const isGenericName =
    swarm.name === "local-hub" || swarm.name.endsWith("-hub");
  let displayName: string;
  if (project) {
    displayName = branch ? `${project} (${branch})` : project;
  } else if (!isGenericName) {
    displayName = swarm.name;
  } else {
    // No project, generic name — show truncated swarm ID
    displayName = `Session ${swarm.id.replace(/^swarm_/, "").slice(0, 8)}`;
  }

  const isSidecar =
    metaType === "default-sidecar" || metaType === "claude-code-swarm-sidecar";
  const isInbound = swarm.map_endpoint === "hub-inbound";
  const isLocal = swarm.map_endpoint === "local-hub";

  return (
    <div
      className="card card-hover px-3 py-2.5 cursor-pointer group"
      onClick={() => navigate(`/swarms/${swarm.id}`)}
    >
      <div className="flex items-center gap-3">
        <div
          className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
          style={{ backgroundColor: "var(--color-accent-bg)" }}
        >
          <Globe className="w-4 h-4 text-honey-500" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate group-hover:text-honey-500 transition-colors">
              {displayName}
            </span>
            <MapStatusBadge status={swarm.status} />
            {isInbound && (
              <span className="text-2xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400">
                inbound
              </span>
            )}
            {isLocal && (
              <span className="text-2xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">
                local
              </span>
            )}
            {template && (
              <span className="text-2xs px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400">
                {template}
              </span>
            )}
          </div>
          <div
            className="flex items-center gap-2 mt-0.5 text-2xs"
            style={{ color: "var(--color-text-muted)" }}
          >
            <span className="font-mono truncate max-w-[180px]">{swarm.id}</span>
            {!isInbound && !isLocal && (
              <>
                <span className="opacity-30">&middot;</span>
                <span className="truncate max-w-[200px] font-mono">
                  {swarm.map_endpoint}
                </span>
              </>
            )}
            {swarm.agent_count > 0 && (
              <>
                <span className="opacity-30">&middot;</span>
                <span>
                  {swarm.agent_count} agent{swarm.agent_count !== 1 ? "s" : ""}
                </span>
              </>
            )}
            {swarm.hives.length > 0 && (
              <>
                <span className="opacity-30">&middot;</span>
                <span>{swarm.hives.join(", ")}</span>
              </>
            )}
            {isSidecar && (
              <>
                <span className="opacity-30">&middot;</span>
                <span>sidecar</span>
              </>
            )}
            <span className="opacity-30">&middot;</span>
            <TimeAgo
              date={
                swarm.last_seen_at && swarm.last_seen_at > swarm.created_at
                  ? swarm.last_seen_at
                  : swarm.created_at
              }
            />
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate("/swarmcraft");
            }}
            className="p-1 rounded hover:bg-white/5 transition-colors opacity-0 group-hover:opacity-100"
            title="View in Overview"
          >
            <Monitor
              className="w-3.5 h-3.5"
              style={{ color: "var(--color-text-muted)" }}
            />
          </button>
          {swarm.status === "online" ? (
            <Wifi className="w-3.5 h-3.5 text-emerald-400" />
          ) : swarm.status === "unreachable" ? (
            <WifiOff className="w-3.5 h-3.5 text-red-400" />
          ) : (
            <WifiOff
              className="w-3.5 h-3.5"
              style={{ color: "var(--color-text-muted)" }}
            />
          )}
        </div>
      </div>

      {swarm.description && (
        <p
          className="mt-1.5 text-xs pl-11"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {swarm.description}
        </p>
      )}

      {/* Capabilities */}
      {swarm.capabilities && Object.keys(swarm.capabilities).length > 0 && (
        <div className="mt-1.5 pl-11 flex items-center gap-1.5">
          {Object.entries(swarm.capabilities)
            .filter(([, v]) => v === true)
            .map(([key]) => (
              <span
                key={key}
                className="text-2xs px-1.5 py-0.5 rounded capitalize"
                style={{
                  backgroundColor: "var(--color-elevated)",
                  color: "var(--color-text-muted)",
                }}
              >
                {key}
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Main Page
// =============================================================================

type FormMode = "none" | "spawn" | "connect";

/**
 * Bulk actions for the Hosted section header. Shown contextually — each
 * button renders only when it has targets to act on.
 *
 *   • Restart stopped → any hosted swarm in `stopped | failed` (same
 *                       set the per-card "Restart" button accepts;
 *                       `running` and `unhealthy` are left alone so a
 *                       bulk click never interrupts live work).
 *   • Clear stopped   → any hosted swarm in `stopped | failed` (the set
 *                       the per-card "Remove" button accepts).
 *
 * The hooks are wired per-id, so we fan out the mutations here with
 * bounded concurrency (sequential) to avoid N openswarm processes
 * racing for ports on bulk restart. React Query's invalidation on
 * each mutation success keeps the list fresh.
 */
function HostedSectionActions({ swarms }: { swarms: HostedSwarm[] }) {
  const restartMutation = useRestartSwarm();
  const removeMutation = useRemoveSwarm();
  const [bulkKind, setBulkKind] = useState<"restart" | "clear" | null>(null);
  const inFlightRef = useRef(false);

  const restartable = useMemo(
    () => swarms.filter((s) => s.state === "stopped" || s.state === "failed"),
    [swarms],
  );
  const clearable = useMemo(
    () => swarms.filter((s) => s.state === "stopped" || s.state === "failed"),
    [swarms],
  );

  const runBulk = async (
    kind: "restart" | "clear",
    targets: HostedSwarm[],
  ): Promise<void> => {
    if (inFlightRef.current) return;
    if (targets.length === 0) return;

    inFlightRef.current = true;
    setBulkKind(kind);

    let ok = 0;
    let failed = 0;
    for (const s of targets) {
      try {
        if (kind === "restart") {
          await restartMutation.mutateAsync(s.id);
        } else {
          await removeMutation.mutateAsync(s.id);
        }
        ok++;
      } catch (err) {
        failed++;
        console.error(`[swarms] Bulk ${kind} failed for ${s.id}:`, err);
      }
    }

    const verbPast = kind === "restart" ? "Restarted" : "Removed";
    if (failed === 0) {
      toast.success(`${verbPast} ${ok} swarm${ok === 1 ? "" : "s"}`);
    } else if (ok > 0) {
      toast.info(
        `${kind === "restart" ? "Restart" : "Remove"} finished`,
        `${ok} ok, ${failed} failed`,
      );
    } else {
      toast.error(
        `${kind === "restart" ? "Restart" : "Remove"} failed`,
        `${failed} swarm${failed === 1 ? "" : "s"} could not be processed`,
      );
    }

    inFlightRef.current = false;
    setBulkKind(null);
  };

  const isBusy = bulkKind !== null;
  if (restartable.length === 0 && clearable.length === 0) return null;

  return (
    <>
      {restartable.length > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            void runBulk("restart", restartable);
          }}
          disabled={isBusy}
          title={`Restart ${restartable.length} stopped/failed swarm${restartable.length === 1 ? "" : "s"}`}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-2xs font-medium transition-colors cursor-pointer hover:bg-workspace-hover hover:text-[var(--color-text-primary)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {bulkKind === "restart" ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RotateCw className="w-3 h-3" />
          )}
          Restart stopped ({restartable.length})
        </button>
      )}
      {clearable.length > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            void runBulk("clear", clearable);
          }}
          disabled={isBusy}
          title={`Remove ${clearable.length} stopped/failed swarm${clearable.length === 1 ? "" : "s"}`}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-2xs font-medium transition-colors cursor-pointer hover:bg-workspace-hover hover:text-[var(--color-text-primary)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {bulkKind === "clear" ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Trash2 className="w-3 h-3" />
          )}
          Clear stopped ({clearable.length})
        </button>
      )}
    </>
  );
}

function SectionHeader({
  icon: Icon,
  label,
  count,
  expanded,
  onToggle,
  actions,
}: {
  icon: React.ElementType;
  label: string;
  count?: number;
  expanded: boolean;
  onToggle: () => void;
  /**
   * Optional trailing actions (e.g. "Restart all"). Rendered to the right
   * of the section toggle, outside the toggle button so action clicks
   * don't also collapse the section.
   */
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center -mx-2">
      <button
        onClick={onToggle}
        className="flex-1 flex items-center gap-1.5 text-left py-1.5 px-2 rounded-md text-xs font-medium transition-colors cursor-pointer hover:text-[var(--color-text-primary)]"
        style={{ color: "var(--color-text-secondary)" }}
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronUp className="w-3 h-3 -rotate-90" />
        )}
        <Icon className="w-3.5 h-3.5" />
        {label}
        {count !== undefined && (
          <span
            className="text-2xs ml-0.5 px-1 py-0 rounded-full"
            style={{
              backgroundColor: "var(--color-elevated)",
              color: "var(--color-text-muted)",
            }}
          >
            {count}
          </span>
        )}
      </button>
      {actions && <div className="flex items-center gap-1 px-2">{actions}</div>}
    </div>
  );
}

export function Swarms() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: hostedSwarms, isLoading: hostedLoading } = useHostedSwarms();
  const { data: mapSwarms, isLoading: mapLoading } = useMapSwarms();
  useSwarmRealtime();
  const [showHosted, setShowHosted] = useState<boolean | null>(null);
  const [showRegistered, setShowRegistered] = useState<boolean | null>(null);
  const [showOffline, setShowOffline] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>("none");

  // Dedup: a hosted swarm and its registered entry (the MAP server SwarmCraft
  // discovers outbound, or the sidecar's inbound record) represent the SAME
  // macro-agent process. Hide the registered entry and display only the hosted
  // card (which inherits the live agent data via its linked MAP swarm).
  //
  // Match by: hosted.swarm_id → registered.id (inbound sidecar link), OR
  //           hosted.endpoint === registered.map_endpoint (outbound match).
  const hostedLinkedSwarmIds = useMemo(() => {
    const ids = new Set<string>();
    const endpoints = new Set<string>();
    for (const h of hostedSwarms ?? []) {
      if (h.swarm_id) ids.add(h.swarm_id);
      if (h.endpoint) endpoints.add(h.endpoint);
    }
    if (mapSwarms) {
      for (const s of mapSwarms) {
        if (endpoints.has(s.map_endpoint)) ids.add(s.id);
      }
    }
    return ids;
  }, [hostedSwarms, mapSwarms]);

  // Filter registered swarms ('unreachable' = recently disconnected, show with online)
  const onlineSwarms = mapSwarms?.filter(
    (s) =>
      (s.status === "online" || s.status === "unreachable") &&
      !hostedLinkedSwarmIds.has(s.id),
  );
  const offlineSwarms = mapSwarms?.filter(
    (s) => s.status === "offline" && !hostedLinkedSwarmIds.has(s.id),
  );
  const visibleMapSwarms = showOffline
    ? mapSwarms?.filter((s) => !hostedLinkedSwarmIds.has(s.id))
    : onlineSwarms;

  // Auto-collapse empty sections (only before user has toggled)
  const hostedExpanded =
    showHosted ??
    (hostedLoading || (hostedSwarms != null && hostedSwarms.length > 0));
  const registeredExpanded =
    showRegistered ??
    (mapLoading || (visibleMapSwarms != null && visibleMapSwarms.length > 0));

  // Handle ?action=spawn or ?action=connect from dashboard quick actions
  useEffect(() => {
    const action = searchParams.get("action");
    if (action === "spawn" || action === "connect") {
      setFormMode(action);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-lg font-semibold">Swarms</h1>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setFormMode("spawn")}
            className="btn btn-primary flex items-center gap-1.5 text-xs"
          >
            <Plus className="w-3 h-3" />
            Spawn
          </button>
          <button
            onClick={() => setFormMode("connect")}
            className="btn btn-secondary flex items-center gap-1.5 text-xs"
          >
            <Link2 className="w-3 h-3" />
            Connect
          </button>
        </div>
      </div>

      {/* Forms */}
      {formMode === "spawn" && (
        <SpawnFormDialog onClose={() => setFormMode("none")} />
      )}
      {formMode === "connect" && (
        <ConnectFormDialog onClose={() => setFormMode("none")} />
      )}

      {/* Hosted section */}
      <SectionHeader
        icon={Cpu}
        label="Hosted"
        count={hostedSwarms?.length}
        expanded={hostedExpanded}
        onToggle={() => setShowHosted(!hostedExpanded)}
        actions={
          hostedSwarms && hostedSwarms.length > 0 ? (
            <HostedSectionActions swarms={hostedSwarms} />
          ) : undefined
        }
      />
      {hostedExpanded &&
        (hostedLoading ? (
          <PageLoader />
        ) : hostedSwarms && hostedSwarms.length > 0 ? (
          <div className="space-y-1 mb-4">
            {hostedSwarms.map((swarm) => {
              // Find the linked registered MAP swarm record so the card can
              // surface live status, agent count, and capabilities inline.
              const linked = mapSwarms?.find(
                (s) =>
                  (swarm.swarm_id && s.id === swarm.swarm_id) ||
                  s.map_endpoint === swarm.endpoint,
              );
              return (
                <HostedSwarmCard
                  key={swarm.id}
                  swarm={swarm}
                  linkedMapSwarm={linked}
                />
              );
            })}
          </div>
        ) : (
          <div className="mb-4">
            <EmptyState
              icon={Cpu}
              message="No hosted swarms"
              action={
                formMode === "none" ? () => setFormMode("spawn") : undefined
              }
              actionLabel="Spawn your first swarm"
            />
          </div>
        ))}

      {/* Registered section */}
      <SectionHeader
        icon={Globe}
        label="Registered"
        count={onlineSwarms?.length}
        expanded={registeredExpanded}
        onToggle={() => setShowRegistered(!registeredExpanded)}
      />
      {registeredExpanded &&
        (mapLoading ? (
          <PageLoader />
        ) : visibleMapSwarms && visibleMapSwarms.length > 0 ? (
          <div className="space-y-1">
            {visibleMapSwarms.map((swarm) => (
              <MapSwarmCard key={swarm.id} swarm={swarm} />
            ))}
          </div>
        ) : (
          <div className="py-8 text-center">
            <Globe
              className="w-8 h-8 mx-auto mb-2 opacity-20"
              style={{ color: "var(--color-text-muted)" }}
            />
            <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
              No online swarms
            </p>
            {(offlineSwarms?.length ?? 0) > 0 && (
              <button
                onClick={() => setShowOffline(!showOffline)}
                className="mt-2 inline-flex items-center gap-1 text-xs text-honey-500 hover:text-honey-400 transition-colors"
              >
                <WifiOff className="w-3 h-3" />
                {showOffline ? "Hide" : "Show"} {offlineSwarms!.length} offline
              </button>
            )}
            {formMode === "none" && !offlineSwarms?.length && (
              <button
                onClick={() => setFormMode("connect")}
                className="mt-2 text-xs text-honey-500 hover:text-honey-400 transition-colors"
              >
                Connect an external swarm
              </button>
            )}
          </div>
        ))}
      {registeredExpanded &&
        (visibleMapSwarms?.length ?? 0) > 0 &&
        (offlineSwarms?.length ?? 0) > 0 &&
        !showOffline && (
          <button
            onClick={() => setShowOffline(true)}
            className="flex items-center gap-1 mt-2 text-2xs transition-colors"
            style={{ color: "var(--color-text-muted)" }}
          >
            <WifiOff className="w-3 h-3" />
            Show {offlineSwarms!.length} offline
          </button>
        )}
      {registeredExpanded &&
        showOffline &&
        (offlineSwarms?.length ?? 0) > 0 && (
          <button
            onClick={() => setShowOffline(false)}
            className="flex items-center gap-1 mt-2 text-2xs transition-colors"
            style={{ color: "var(--color-text-muted)" }}
          >
            <WifiOff className="w-3 h-3" />
            Hide {offlineSwarms!.length} offline
          </button>
        )}
    </div>
  );
}

function EmptyState({
  icon: Icon,
  message,
  action,
  actionLabel,
}: {
  icon: React.ElementType;
  message: string;
  action?: () => void;
  actionLabel?: string;
}) {
  return (
    <div className="py-8 text-center">
      <Icon
        className="w-8 h-8 mx-auto mb-2 opacity-20"
        style={{ color: "var(--color-text-muted)" }}
      />
      <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
        {message}
      </p>
      {action && actionLabel && (
        <button
          onClick={action}
          className="mt-2 text-xs text-honey-500 hover:text-honey-400 transition-colors"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
