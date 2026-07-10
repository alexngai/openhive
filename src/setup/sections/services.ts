/**
 * Optional services overview — status-only. These services have real
 * configuration surfaces in the Settings UI; the setup flow just tells
 * you what's on and where to turn the rest on, instead of interviewing
 * for every knob.
 */

import type {
  ApplyResult,
  DoctorCheck,
  SectionStatus,
  SetupContext,
  SetupField,
  SetupSection,
} from '../types.js';

interface ServiceProbe {
  key: string;
  label: string;
  enabled(ctx: SetupContext): boolean;
  hint: string;
}

const SERVICES: ServiceProbe[] = [
  {
    key: 'learning',
    label: 'Learning engine (Atlas)',
    enabled: (ctx) => ctx.config.learning.enabled,
    hint: 'Settings → Learning Engine',
  },
  {
    key: 'bridge',
    label: 'Channel bridges (Slack/Discord)',
    enabled: (ctx) => ctx.config.bridge.enabled,
    hint: 'Settings → Channel Bridge',
  },
  {
    key: 'federation',
    label: 'Federation',
    enabled: (ctx) => ctx.config.federation.enabled,
    hint: 'Settings → Federation',
  },
  {
    key: 'sync',
    label: 'Hive mesh sync',
    enabled: (ctx) =>
      (ctx.config as unknown as { sync?: { enabled?: boolean } }).sync?.enabled ?? false,
    hint: 'Settings → Hive Sync',
  },
  {
    key: 'swarmhub',
    label: 'SwarmHub connector',
    enabled: (ctx) =>
      (ctx.config as unknown as { swarmhub?: { enabled?: boolean } }).swarmhub?.enabled ??
      false,
    hint: 'Settings → SwarmHub',
  },
];

export const servicesSection: SetupSection = {
  id: 'services',
  title: 'Optional services',
  description: 'Learning, bridges, federation, mesh sync, SwarmHub — configured in the Settings UI',

  async status(ctx: SetupContext): Promise<SectionStatus> {
    const on = SERVICES.filter((s) => s.enabled(ctx));
    return {
      state: 'optional',
      summary:
        on.length > 0
          ? `Enabled: ${on.map((s) => s.label).join(', ')}`
          : 'None enabled — all optional, configure in the Settings UI when needed',
      issues: [],
    };
  },

  fields(): SetupField[] {
    return [];
  },

  async apply(): Promise<ApplyResult> {
    return { ok: true, message: 'Optional services are configured in the Settings UI' };
  },

  async checks(ctx: SetupContext): Promise<DoctorCheck[]> {
    return SERVICES.map((s) => ({
      section: 'services',
      name: s.key,
      status: 'pass' as const,
      message: s.enabled(ctx) ? `${s.label}: enabled` : `${s.label}: off (${s.hint})`,
    }));
  },
};
