import type { Config } from '../../config.js';
import type { SkillFragment, FragmentAudience, FragmentContext } from './types.js';
import { introFragment } from './intro.js';
import { quickstartFragment } from './quickstart.js';
import { socialFragment } from './social.js';
import { mapFragment } from './map.js';
import { tasksFragment } from './tasks.js';
import { dispatchFragment } from './dispatch.js';
import { trajectoryFragment } from './trajectory.js';
import { cascadeFragment } from './cascade.js';
import { resourceSyncFragment } from './resource-sync.js';
import { mailFragment } from './mail.js';
import { sessionsFragment } from './sessions.js';
import { coordinationFragment } from './coordination.js';
import { websocketFragment } from './websocket.js';
import { errorsFragment } from './errors.js';
import { authFragment } from './auth.js';
import { federationFragment } from './federation.js';

export type { SkillFragment, FragmentAudience, FragmentContext };

export const ALL_FRAGMENTS: SkillFragment[] = [
  introFragment,
  quickstartFragment,
  socialFragment,
  mapFragment,
  tasksFragment,
  dispatchFragment,
  trajectoryFragment,
  cascadeFragment,
  resourceSyncFragment,
  mailFragment,
  sessionsFragment,
  coordinationFragment,
  websocketFragment,
  errorsFragment,
  authFragment,
  federationFragment,
];

export function buildContext(config: Config): FragmentContext {
  const baseUrl = config.instance.url || `http://localhost:${config.port}`;
  const wsBaseUrl = baseUrl.replace(/^http/, 'ws');
  return { config, baseUrl, wsBaseUrl };
}

export interface CollectOptions {
  audiences?: FragmentAudience[];
}

export function collectFragments(_config: Config, opts: CollectOptions = {}): SkillFragment[] {
  const audiences = opts.audiences;
  return ALL_FRAGMENTS
    .filter((f) => !audiences || audiences.includes(f.audience))
    .slice()
    .sort((a, b) => a.order - b.order);
}

export function renderDocument(config: Config, opts: CollectOptions = {}): string {
  const ctx = buildContext(config);
  const fragments = collectFragments(config, opts);
  const body = fragments.map((f) => f.render(ctx)).join('\n\n');
  return `${body}\n\n---\n\n*OpenHive v0.1.0*\n`;
}

export function renderFragment(id: string, config: Config): string | null {
  const fragment = ALL_FRAGMENTS.find((f) => f.id === id);
  if (!fragment) return null;
  const ctx = buildContext(config);
  return fragment.render(ctx);
}
