import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Zap,
  Link2,
  Activity,
  Brain,
  Wrench,
  ListTodo,
  BarChart3,
  X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useMapSwarms, useSessionsList } from "../hooks/useApi";
import { useInstanceFeatures } from "../hooks/useInstanceFeatures";
import { useOpenTasksAggregated } from "../hooks/useOpenTasksAggregated";
import { SwarmCraftApp } from "swarmcraft/ui/embed";
import "swarmcraft/ui/embed.css";
import { useChatFabStore } from "../components/chat-fab/ChatFabStore";
import { StatsOverview } from "../components/dashboard/StatsOverview";
import { SwarmStatusSummary } from "../components/dashboard/SwarmStatusSummary";
import { SyncResourcesStatus } from "../components/dashboard/SyncResourcesStatus";
import { RecentActivity } from "../components/dashboard/RecentActivity";
import { SpawnFormDialog, ConnectFormDialog } from "./Swarms";

/** Derive API/WS URLs relative to current host */
function useSwarmCraftConfig() {
  return useMemo(
    () => ({
      apiUrl: "/api/swarmcraft",
      wsUrl: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/swarmcraft`,
    }),
    [],
  );
}

/** Bridge OpenTasks into SwarmCraft's task system */
function useTasksOverride() {
  const openTasks = useOpenTasksAggregated();
  return useMemo(
    () => ({
      tasks: openTasks.tasks,
      createTask: openTasks.createTask,
      assignTask: openTasks.assignTask,
    }),
    [openTasks.tasks, openTasks.createTask, openTasks.assignTask],
  );
}

function BridgeLinks() {
  const { data: mapSwarms } = useMapSwarms();
  const { data: sessions } = useSessionsList();

  const onlineSwarms =
    mapSwarms?.filter((s) => s.status === "online").length ?? 0;
  const totalSwarms = mapSwarms?.length ?? 0;
  const sessionCount = sessions?.total ?? 0;

  return (
    <div
      className="flex items-center gap-3 text-2xs"
      style={{ color: "var(--color-text-muted)" }}
    >
      <Link
        to="/swarms"
        className="flex items-center gap-1 hover:text-honey-500 transition-colors"
      >
        <Zap className="w-3 h-3" />
        <span>
          {onlineSwarms}/{totalSwarms} swarms
        </span>
      </Link>
      <Link
        to="/sessions"
        className="flex items-center gap-1 hover:text-honey-500 transition-colors"
      >
        <Activity className="w-3 h-3" />
        <span>{sessionCount} sessions</span>
      </Link>
    </div>
  );
}

function BridgeStatusBar() {
  const { data: mapSwarms } = useMapSwarms();
  const { data: sessions } = useSessionsList();
  const { data: memoryRes } = useQuery({
    queryKey: ["resources-memory-count"],
    queryFn: () => api.get("/resources?type=memory_bank&limit=1"),
    select: (d: { total?: number }) => d.total ?? 0,
    staleTime: 30_000,
  });
  const { data: skillRes } = useQuery({
    queryKey: ["resources-skill-count"],
    queryFn: () => api.get("/resources?type=skill&limit=1"),
    select: (d: { total?: number }) => d.total ?? 0,
    staleTime: 30_000,
  });
  const { data: taskRes } = useQuery({
    queryKey: ["resources-task-count"],
    queryFn: () => api.get("/resources?type=task&limit=1"),
    select: (d: { total?: number }) => d.total ?? 0,
    staleTime: 30_000,
  });

  const onlineSwarms =
    mapSwarms?.filter((s) => s.status === "online").length ?? 0;
  const totalSwarms = mapSwarms?.length ?? 0;
  const sessionCount = sessions?.total ?? 0;

  return (
    <div
      className="flex items-center gap-4 px-4 py-2 text-2xs border-b shrink-0"
      style={{
        borderColor: "var(--color-border-subtle)",
        backgroundColor: "var(--color-surface)",
        color: "var(--color-text-muted)",
      }}
    >
      <span
        className="font-medium"
        style={{ color: "var(--color-text-secondary)" }}
      >
        Data Sources
      </span>
      <Link
        to="/swarms"
        className="flex items-center gap-1 hover:text-honey-500 transition-colors"
      >
        <Zap className="w-3 h-3" />
        <span>
          {onlineSwarms}/{totalSwarms} swarms
        </span>
      </Link>
      <Link
        to="/sessions"
        className="flex items-center gap-1 hover:text-honey-500 transition-colors"
      >
        <Activity className="w-3 h-3" />
        <span>{sessionCount} sessions</span>
      </Link>
      {(memoryRes ?? 0) > 0 && (
        <Link
          to="/memory"
          className="flex items-center gap-1 hover:text-honey-500 transition-colors"
        >
          <Brain className="w-3 h-3" />
          <span>{memoryRes} memories</span>
        </Link>
      )}
      {(skillRes ?? 0) > 0 && (
        <Link
          to="/skills"
          className="flex items-center gap-1 hover:text-honey-500 transition-colors"
        >
          <Wrench className="w-3 h-3" />
          <span>{skillRes} skills</span>
        </Link>
      )}
      {(taskRes ?? 0) > 0 && (
        <Link
          to="/tasks"
          className="flex items-center gap-1 hover:text-honey-500 transition-colors"
        >
          <ListTodo className="w-3 h-3" />
          <span>{taskRes} tasks</span>
        </Link>
      )}
    </div>
  );
}

function StatsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center px-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* Panel */}
      <div
        className="relative z-10 w-full max-w-4xl rounded-lg border shadow-2xl overflow-y-auto max-h-[calc(100%-2rem)]"
        style={{
          backgroundColor: "var(--color-bg)",
          borderColor: "var(--color-border-subtle)",
        }}
      >
        <div
          className="flex items-center justify-between px-4 py-3 border-b sticky top-0"
          style={{
            borderColor: "var(--color-border-subtle)",
            backgroundColor: "var(--color-bg)",
          }}
        >
          <h2
            className="text-sm font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            Instance Overview
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-workspace-hover transition-colors"
            style={{ color: "var(--color-text-muted)" }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <StatsOverview />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <SwarmStatusSummary />
            <SyncResourcesStatus />
          </div>
          <RecentActivity />
        </div>
      </div>
    </div>
  );
}

function SwarmCraftView() {
  const config = useSwarmCraftConfig();
  const tasksOverride = useTasksOverride();
  const connectAndOpen = useChatFabStore((s) => s.connectAndOpen);
  const [showStats, setShowStats] = useState(false);
  const [formMode, setFormMode] = useState<"none" | "spawn" | "connect">(
    "none",
  );

  const headerLeft = <BridgeLinks />;
  const headerRight = (
    <div className="flex items-center gap-1.5 ml-2">
      <button
        onClick={() => setShowStats(true)}
        className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors hover:bg-workspace-hover"
        style={{ color: "var(--color-text-secondary)" }}
      >
        <BarChart3 className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={() => setFormMode("spawn")}
        className="btn btn-primary flex items-center gap-1 text-xs py-1.5 px-2.5"
      >
        <Zap className="w-3 h-3" />
        Spawn
      </button>
      <button
        onClick={() => setFormMode("connect")}
        className="btn btn-secondary flex items-center gap-1 text-xs py-1.5 px-2.5"
      >
        <Link2 className="w-3 h-3" />
        Connect
      </button>
    </div>
  );

  return (
    <div className="flex-1 min-h-0 relative">
      <SwarmCraftApp
        config={config}
        autoConnect
        initialViewMode="exploring"
        defaultPanelOpen={false}
        tasksOverride={tasksOverride}
        embedded
        headerLeftContent={headerLeft}
        headerRightContent={headerRight}
        onStartChat={(agentId, swarmId) => {
          if (!swarmId) return;
          // SwarmCraft hands us OpenHive's projection id
          // (`oh-node-{swarmId}-{mapAgentId}`); strip the namespace so we can
          // pass the raw MAP agent id as `peer_map_id` to /sessions/acp-connect,
          // which routes ACP through the swarm's own MAP server. Without this,
          // the hub registry lookup 404s on the projected id.
          const prefix = `oh-node-${swarmId}-`;
          const peerMapId = agentId.startsWith(prefix)
            ? agentId.slice(prefix.length)
            : undefined;
          connectAndOpen(swarmId, agentId, undefined, peerMapId);
        }}
      />
      {showStats && <StatsOverlay onClose={() => setShowStats(false)} />}
      {formMode === "spawn" && (
        <SpawnFormDialog onClose={() => setFormMode("none")} />
      )}
      {formMode === "connect" && (
        <ConnectFormDialog onClose={() => setFormMode("none")} />
      )}
    </div>
  );
}

function StatsDashboard() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-4">
      <StatsOverview />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
        <SwarmStatusSummary />
        <SyncResourcesStatus />
      </div>
      <div className="mt-2">
        <RecentActivity />
      </div>
    </div>
  );
}

export function Dashboard() {
  const { features, isLoading, isError } = useInstanceFeatures();
  const [formMode, setFormMode] = useState<"none" | "spawn" | "connect">(
    "none",
  );

  // Still loading or server not ready — show a loading indicator instead of a blank screen
  if (!features) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 text-zinc-400">
        <Activity className="w-6 h-6 animate-pulse" />
        {isError ? (
          <p className="text-sm">Waiting for server&hellip;</p>
        ) : (
          <p className="text-sm">Loading dashboard&hellip;</p>
        )}
      </div>
    );
  }

  if (features.swarmcraft) {
    return (
      <div className="flex flex-col h-full">
        <SwarmCraftView />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header (only for non-SwarmCraft fallback) */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b shrink-0"
        style={{ borderColor: "var(--color-border-subtle)" }}
      >
        <h1
          className="text-lg font-semibold"
          style={{ color: "var(--color-text)" }}
        >
          Dashboard
        </h1>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setFormMode("spawn")}
            className="btn btn-primary flex items-center gap-1.5 text-xs"
          >
            <Zap className="w-3 h-3" />
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
      <StatsDashboard />
      {formMode === "spawn" && (
        <SpawnFormDialog onClose={() => setFormMode("none")} />
      )}
      {formMode === "connect" && (
        <ConnectFormDialog onClose={() => setFormMode("none")} />
      )}
    </div>
  );
}
