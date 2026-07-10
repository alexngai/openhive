/**
 * Setup engine contracts.
 *
 * A SetupSection is pure over (config file, disk, environment): `status`
 * derives from what actually exists — never from a stored "wizard
 * completed" flag — which is what makes sections idempotent and
 * re-runnable from the CLI, the admin API, and the web onboarding page.
 *
 * DoctorCheck extends the swarmkit doctor contract (see
 * src/swarmkit/types.ts DoctorCheckResult) with a `section` tag so one
 * flat result list can group by origin.
 */

import type { Config } from '../config.js';
import type { SwarmManager } from '../swarm/manager.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  section: string;
  name: string;
  status: CheckStatus;
  message: string;
  /** Actionable remediation, shown when status is warn/fail */
  fix?: string;
}

export type SectionState = 'complete' | 'incomplete' | 'optional';

export interface SectionStatus {
  state: SectionState;
  /** One-line summary of the current configuration */
  summary: string;
  /** Outstanding problems keeping the section from `complete` */
  issues: string[];
}

export interface SetupFieldChoice {
  value: string;
  label: string;
}

export interface SetupField {
  /** Answer key, also used as the `--set key=value` CLI flag key */
  key: string;
  label: string;
  description?: string;
  type: 'string' | 'boolean' | 'choice' | 'number' | 'secret';
  choices?: SetupFieldChoice[];
  /** Suggested value when nothing is configured yet */
  default?: unknown;
  /** Currently-configured value (redacted for secrets) */
  current?: unknown;
  optional?: boolean;
}

export interface ApplyResult {
  ok: boolean;
  message: string;
  /** True when the change only takes effect after a hub restart */
  restartRequired?: boolean;
  /** Section-specific artifacts (e.g. minted token, generated admin key) */
  outputs?: Record<string, unknown>;
}

export interface SetupContext {
  dataDir: string;
  /** Path of the JSON config file (may not exist yet) */
  configPath: string;
  /** Raw config file contents ({} when absent) */
  rawConfig: Record<string, unknown>;
  /** Parsed config with defaults applied (falls back to defaults on parse failure) */
  config: Config;
  /** Whether the raw config file failed schema validation */
  configParseError: string | null;
  /** Whether a hub is currently serving on the configured port */
  hubRunning: boolean;
  /**
   * Optional live dependencies, present when running inside the server
   * (e.g. GET /admin/doctor). Deep checks that need them degrade to a
   * warn when absent.
   */
  deps?: {
    swarmManager?: SwarmManager;
  };
}

export interface SetupSection {
  id: string;
  title: string;
  description: string;
  status(ctx: SetupContext): Promise<SectionStatus>;
  fields(ctx: SetupContext): SetupField[];
  apply(ctx: SetupContext, answers: Record<string, unknown>): Promise<ApplyResult>;
  checks(ctx: SetupContext, deep: boolean): Promise<DoctorCheck[]>;
}
