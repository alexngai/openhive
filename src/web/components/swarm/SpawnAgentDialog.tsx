/**
 * SpawnAgentDialog
 *
 * Full-surface agent spawn form. Wraps the widened `useSpawnAgent` hook so
 * callers can set every field `_macro/spawnAgent` accepts (role, cwd, task,
 * permissionMode, agentType, model / sampling, custom prompt, topics, env,
 * MCP servers, task ref). Defaults match what the "Spawn Agent" top-level
 * button does for one-click use, so opening the dialog without touching
 * anything lands on the same behavior.
 *
 * Used from SwarmDetail's Registered Agents section next to the primary
 * Spawn Agent button.
 */

import { useState } from 'react';
import { Zap, Loader2, X, Settings2 } from 'lucide-react';
import { Dialog } from '../common/Dialog';
import { SectionLabel } from './StatusBadges';
import { toast } from '../../stores/toast';
import {
  useSpawnAgent,
  type SpawnAgentPermissionMode,
  type SpawnAgentRequest,
} from '../../hooks/useApi';

const ROLES = ['coordinator', 'worker', 'integrator', 'monitor', 'generic'] as const;

const PERMISSION_MODES: Array<{ value: SpawnAgentPermissionMode; label: string; desc: string }> = [
  { value: 'auto-approve', label: 'auto-approve', desc: 'Tool calls run without prompts (fast, trusted)' },
  { value: 'auto-deny', label: 'auto-deny', desc: 'All tool calls rejected (dry-run / observer)' },
  { value: 'callback', label: 'callback', desc: 'Approval requests routed to the connected ACP client' },
  { value: 'interactive', label: 'interactive', desc: 'Prompts the user synchronously (TUI mode)' },
];

const AGENT_TYPES = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'opencode', label: 'OpenCode' },
] as const;

export interface SpawnAgentDialogProps {
  swarmId: string;
  /** Default cwd for the project-path field. */
  defaultCwd?: string;
  onClose: () => void;
  /** Called after a successful spawn with the new agent IDs. */
  onSpawned?: (result: { agent_id: string; peer_map_id: string; name?: string }) => void;
}

export function SpawnAgentDialog({ swarmId, defaultCwd, onClose, onSpawned }: SpawnAgentDialogProps) {
  const spawnAgent = useSpawnAgent();

  // Core
  const [role, setRole] = useState<string>('coordinator');
  // Start empty so the user sees a clean field. When left blank, the
  // backend falls back to the swarm's cwd (typically the project path
  // the sidecar published, or the swarm data dir for hosted swarms).
  // `defaultCwd` is surfaced as the placeholder hint, not a pre-fill.
  const [cwd, setCwd] = useState('');
  const [task, setTask] = useState('Head manager');

  // Advanced — start empty so defaults at the backend/macro-agent apply.
  const [permissionMode, setPermissionMode] = useState<SpawnAgentPermissionMode | ''>('');
  const [agentType, setAgentType] = useState<string>('');
  const [model, setModel] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [temperature, setTemperature] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [topicsRaw, setTopicsRaw] = useState('');
  const [envRaw, setEnvRaw] = useState('');
  const [mcpServersRaw, setMcpServersRaw] = useState('');

  const [showAdvanced, setShowAdvanced] = useState(false);

  function buildRequest(): SpawnAgentRequest | { error: string } {
    const topics = topicsRaw.trim()
      ? topicsRaw.split(',').map((t) => t.trim()).filter(Boolean)
      : undefined;

    let env: Record<string, string> | undefined;
    if (envRaw.trim()) {
      try {
        const parsed = JSON.parse(envRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          env = parsed as Record<string, string>;
        } else {
          return { error: 'Env must be a JSON object' };
        }
      } catch {
        return { error: 'Env: invalid JSON' };
      }
    }

    let mcpServers: SpawnAgentRequest['config'] extends infer C
      ? C extends { mcpServers?: infer M } ? M : never
      : never | undefined;
    if (mcpServersRaw.trim()) {
      try {
        const parsed = JSON.parse(mcpServersRaw);
        if (!Array.isArray(parsed)) {
          return { error: 'MCP servers must be a JSON array' };
        }
        mcpServers = parsed;
      } catch {
        return { error: 'MCP servers: invalid JSON' };
      }
    }

    const maxTokensNum = maxTokens.trim() ? Number(maxTokens) : undefined;
    const tempNum = temperature.trim() ? Number(temperature) : undefined;
    if (maxTokensNum !== undefined && !Number.isFinite(maxTokensNum)) {
      return { error: 'Max tokens must be a number' };
    }
    if (tempNum !== undefined && !Number.isFinite(tempNum)) {
      return { error: 'Temperature must be a number' };
    }

    const configEntries: Record<string, unknown> = {};
    if (model.trim()) configEntries.model = model.trim();
    if (maxTokensNum !== undefined) configEntries.maxTokens = maxTokensNum;
    if (tempNum !== undefined) configEntries.temperature = tempNum;
    if (env) configEntries.env = env;
    if (mcpServers) configEntries.mcpServers = mcpServers;
    const config = Object.keys(configEntries).length > 0
      ? (configEntries as SpawnAgentRequest['config'])
      : undefined;

    return {
      swarmId,
      role: role || undefined,
      cwd: cwd.trim() || undefined,
      task: task.trim() || undefined,
      permissionMode: permissionMode || undefined,
      agentType: agentType || undefined,
      customPrompt: customPrompt.trim() || undefined,
      topics,
      config,
    };
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const built = buildRequest();
    if ('error' in built) {
      toast.error('Invalid input', built.error);
      return;
    }
    try {
      const result = await spawnAgent.mutateAsync(built);
      toast.success(
        'Agent spawned',
        `${result.name ?? result.agent_id} is ready on this swarm.`,
      );
      onSpawned?.(result);
      onClose();
    } catch (err) {
      toast.error('Spawn failed', (err as Error).message);
    }
  };

  const isPending = spawnAgent.isPending;

  return (
    <Dialog open onClose={onClose} maxWidth="max-w-xl">
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-honey-500" />
            Spawn Agent — advanced
          </h2>
          <button onClick={onClose} className="btn btn-ghost p-1">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Core fields */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <SectionLabel htmlFor="spawn-role">Role</SectionLabel>
              <select
                id="spawn-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="input w-full text-xs"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <div>
              <SectionLabel htmlFor="spawn-agent-type">Agent type</SectionLabel>
              <select
                id="spawn-agent-type"
                value={agentType}
                onChange={(e) => setAgentType(e.target.value)}
                className="input w-full text-xs"
              >
                <option value="">Default (claude-code)</option>
                {AGENT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <SectionLabel htmlFor="spawn-cwd">Project directory (cwd)</SectionLabel>
            <input
              id="spawn-cwd"
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              className="input w-full font-mono text-2xs"
              placeholder={defaultCwd || 'Leave empty to use the swarm cwd'}
              spellCheck={false}
            />
            {!cwd && defaultCwd && (
              <p className="text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                Empty → falls back to{' '}
                <code className="px-1 rounded" style={{ backgroundColor: 'var(--color-elevated)' }}>
                  {defaultCwd}
                </code>
              </p>
            )}
          </div>

          <div>
            <SectionLabel htmlFor="spawn-task">Task</SectionLabel>
            <input
              id="spawn-task"
              type="text"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              className="input w-full text-xs"
              placeholder="Short task description"
            />
          </div>

          <div>
            <SectionLabel htmlFor="spawn-permission-mode">Permission mode</SectionLabel>
            <select
              id="spawn-permission-mode"
              value={permissionMode}
              onChange={(e) => setPermissionMode(e.target.value as SpawnAgentPermissionMode | '')}
              className="input w-full text-xs"
            >
              <option value="">Default (auto-approve)</option>
              {PERMISSION_MODES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            {permissionMode && (
              <p className="text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                {PERMISSION_MODES.find((m) => m.value === permissionMode)?.desc}
              </p>
            )}
          </div>

          {/* Advanced toggle */}
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="btn btn-ghost flex items-center gap-1 text-2xs font-medium"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Settings2 className="w-3 h-3" />
            {showAdvanced ? 'Hide advanced' : 'Advanced config'}
          </button>

          {showAdvanced && (
            <div
              className="space-y-3 pl-3 border-l-2"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              {/* Model + sampling */}
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-3">
                  <SectionLabel htmlFor="spawn-model">Model</SectionLabel>
                  <input
                    id="spawn-model"
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="input w-full font-mono text-2xs"
                    placeholder="claude-opus-4-7 (leave empty for CLI default)"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <SectionLabel htmlFor="spawn-max-tokens">Max tokens</SectionLabel>
                  <input
                    id="spawn-max-tokens"
                    type="number"
                    value={maxTokens}
                    onChange={(e) => setMaxTokens(e.target.value)}
                    className="input w-full text-2xs"
                    placeholder="8192"
                    min={1}
                  />
                </div>
                <div>
                  <SectionLabel htmlFor="spawn-temperature">Temperature</SectionLabel>
                  <input
                    id="spawn-temperature"
                    type="number"
                    value={temperature}
                    onChange={(e) => setTemperature(e.target.value)}
                    className="input w-full text-2xs"
                    placeholder="0.2"
                    step="0.1"
                    min={0}
                    max={2}
                  />
                </div>
              </div>

              {/* Topics */}
              <div>
                <SectionLabel htmlFor="spawn-topics">Extra inbox topics</SectionLabel>
                <input
                  id="spawn-topics"
                  type="text"
                  value={topicsRaw}
                  onChange={(e) => setTopicsRaw(e.target.value)}
                  className="input w-full text-2xs"
                  placeholder="security-review, api-changes (comma-separated)"
                />
              </div>

              {/* Custom prompt */}
              <div>
                <SectionLabel htmlFor="spawn-custom-prompt">Custom prompt</SectionLabel>
                <textarea
                  id="spawn-custom-prompt"
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  className="input w-full text-2xs min-h-[60px] resize-y"
                  placeholder="Override or extend the role's system prompt"
                />
              </div>

              {/* Env */}
              <div>
                <SectionLabel htmlFor="spawn-env">Env vars (JSON)</SectionLabel>
                <textarea
                  id="spawn-env"
                  value={envRaw}
                  onChange={(e) => setEnvRaw(e.target.value)}
                  className="input w-full font-mono text-2xs min-h-[50px] resize-y"
                  placeholder='{"MY_FLAG": "1"}'
                  spellCheck={false}
                />
              </div>

              {/* MCP servers */}
              <div>
                <SectionLabel htmlFor="spawn-mcp-servers">MCP servers (JSON array)</SectionLabel>
                <textarea
                  id="spawn-mcp-servers"
                  value={mcpServersRaw}
                  onChange={(e) => setMcpServersRaw(e.target.value)}
                  className="input w-full font-mono text-2xs min-h-[60px] resize-y"
                  placeholder='[{"name": "github", "command": "github-mcp", "args": ["--token", "ghp_..."]}]'
                  spellCheck={false}
                />
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="submit"
              disabled={isPending}
              className="btn btn-primary inline-flex items-center gap-1.5 text-xs disabled:opacity-70 disabled:cursor-not-allowed disabled:hover:bg-honey-500"
            >
              {isPending ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Zap className="w-3 h-3" />
              )}
              {isPending ? 'Spawning…' : 'Spawn Agent'}
            </button>
            <button type="button" onClick={onClose} className="btn btn-ghost text-xs">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
