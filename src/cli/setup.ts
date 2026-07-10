/**
 * `openhive setup [section]` and `openhive doctor` — CLI consumers of the
 * setup engine (src/setup/). The same sections back GET/POST /admin/setup
 * and the web onboarding page.
 */

import type { Command } from 'commander';
import { resolveDataDir } from '../data-dir.js';
import { closeDatabase } from '../db/index.js';
import {
  SECTIONS,
  getSection,
  buildSetupContext,
  refreshContext,
  runDoctor,
} from '../setup/registry.js';
import type {
  DoctorCheck,
  SetupContext,
  SetupField,
  SetupSection,
} from '../setup/types.js';

// Matches createPrompt() in src/cli.ts — injected to avoid a circular import.
export interface Prompt {
  ask(question: string, defaultValue?: string): Promise<string>;
  choose(question: string, options: string[], defaultIndex?: number): Promise<number>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
  close(): void;
}

function fieldSeed(field: SetupField): unknown {
  return field.current ?? field.default;
}

/** Resolve answers for a section: prompts, or seeds + --set overrides. */
export async function collectAnswers(
  section: SetupSection,
  ctx: SetupContext,
  opts: { prompt: Prompt | null; sets: Record<string, string> },
): Promise<Record<string, unknown>> {
  const answers: Record<string, unknown> = {};
  for (const field of section.fields(ctx)) {
    const override = opts.sets[`${section.id}.${field.key}`] ?? opts.sets[field.key];
    if (override !== undefined) {
      answers[field.key] = override;
      continue;
    }
    const seed = fieldSeed(field);
    if (!opts.prompt) {
      if (seed !== undefined) answers[field.key] = seed;
      continue;
    }
    switch (field.type) {
      case 'boolean': {
        answers[field.key] = await opts.prompt.confirm(
          `  ${field.label}${field.description ? ` (${field.description})` : ''}`,
          seed === true || seed === 'true',
        );
        break;
      }
      case 'choice': {
        const choices = field.choices ?? [];
        const defaultIndex = Math.max(
          0,
          choices.findIndex((c) => c.value === seed),
        );
        const index = await opts.prompt.choose(
          `  ${field.label}:`,
          choices.map((c) => c.label),
          defaultIndex,
        );
        answers[field.key] = choices[index]?.value ?? seed;
        break;
      }
      default: {
        const raw = await opts.prompt.ask(
          `  ${field.label}${field.description ? ` (${field.description})` : ''}`,
          seed !== undefined && seed !== null ? String(seed) : undefined,
        );
        if (raw !== '' || !field.optional) answers[field.key] = raw;
      }
    }
  }
  return answers;
}

export function printOutputs(outputs: Record<string, unknown> | undefined): void {
  if (!outputs) return;
  if (typeof outputs.adminKey === 'string') {
    console.log(`\n  Admin key: ${outputs.adminKey}`);
    console.log("  Save it somewhere safe — you'll need it for the admin panel.");
  }
  if (typeof outputs.token === 'string') {
    console.log(`\n  Onboard token (agent ${outputs.agent_id}, expires ${outputs.expires_at}):`);
    console.log(`    ${outputs.token}`);
  }
  if (Array.isArray(outputs.snippets)) {
    console.log('\n  Connect an agent with:');
    for (const snippet of outputs.snippets as string[]) {
      console.log(`\n    ${String(snippet).split('\n').join('\n    ')}`);
    }
  }
}

const STATUS_ICON: Record<string, string> = {
  complete: '✓',
  incomplete: '○',
  optional: '·',
};

export interface SetupCommandOptions {
  dataDir?: string;
  yes?: boolean;
  json?: boolean;
  set?: string[];
  makePrompt: () => Prompt;
}

export async function runSetupCommand(
  sectionId: string | undefined,
  opts: SetupCommandOptions,
): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  const sets: Record<string, string> = {};
  for (const kv of opts.set ?? []) {
    const eq = kv.indexOf('=');
    if (eq > 0) sets[kv.slice(0, eq)] = kv.slice(eq + 1);
  }

  const sections = sectionId ? [getSection(sectionId)] : SECTIONS;
  if (sections.some((s) => !s)) {
    console.error(
      `Unknown section "${sectionId}". Available: ${SECTIONS.map((s) => s.id).join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  const ctx = await buildSetupContext(dataDir);
  const prompt = opts.yes ? null : opts.makePrompt();
  const results: Array<{ id: string; message: string; restartRequired?: boolean }> = [];

  try {
    for (const section of sections as SetupSection[]) {
      const status = await section.status(ctx);
      console.log(
        `\n${STATUS_ICON[status.state] ?? '·'} ${section.title} — ${status.summary}`,
      );
      for (const issue of status.issues) console.log(`    ! ${issue}`);

      const fields = section.fields(ctx);
      if (fields.length === 0 && status.state !== 'incomplete') {
        continue;
      }

      if (prompt && sectionId === undefined) {
        const proceed = await prompt.confirm(
          `  Configure ${section.title.toLowerCase()}?`,
          status.state !== 'complete',
        );
        if (!proceed) continue;
      }

      const answers = await collectAnswers(section, ctx, { prompt, sets });
      const result = await section.apply(ctx, answers);
      console.log(`  ${result.ok ? '✓' : '✗'} ${result.message}`);
      printOutputs(result.outputs);
      results.push({ id: section.id, message: result.message, restartRequired: result.restartRequired });
      await refreshContext(ctx);
    }

    if (results.some((r) => r.restartRequired)) {
      console.log('\n  Some changes need a hub restart to take effect.');
    }

    // Post-setup health snapshot (cheap tier)
    const checks = await runDoctor(ctx, { deep: false });
    const fails = checks.filter((c) => c.status === 'fail');
    console.log(
      `\n  Doctor: ${checks.filter((c) => c.status === 'pass').length} pass, ${checks.filter((c) => c.status === 'warn').length} warn, ${fails.length} fail`,
    );
    for (const f of fails) {
      console.log(`    ✗ ${f.section}/${f.name}: ${f.message}`);
      if (f.fix) console.log(`      fix: ${f.fix}`);
    }
    if (fails.length === 0) {
      console.log(`\n  Hub ready. Start it with: openhive serve --data-dir ${dataDir}`);
    }
  } finally {
    prompt?.close();
    try {
      closeDatabase();
    } catch {
      /* not open */
    }
  }
}

export async function runDoctorCommand(opts: {
  dataDir?: string;
  deep?: boolean;
  json?: boolean;
}): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  const ctx = await buildSetupContext(dataDir);
  try {
    const checks = await runDoctor(ctx, { deep: opts.deep ?? false });
    if (opts.json) {
      console.log(JSON.stringify({ results: checks }, null, 2));
    } else {
      const icon: Record<DoctorCheck['status'], string> = {
        pass: '✓',
        warn: '⚠',
        fail: '✗',
      };
      for (const c of checks) {
        console.log(` ${icon[c.status]} [${c.section}] ${c.name}: ${c.message}`);
        if (c.fix && c.status !== 'pass') console.log(`     fix: ${c.fix}`);
      }
      const fails = checks.filter((c) => c.status === 'fail').length;
      const warns = checks.filter((c) => c.status === 'warn').length;
      console.log(
        `\n ${checks.length - fails - warns} pass, ${warns} warn, ${fails} fail${opts.deep ? ' (deep)' : ''}`,
      );
    }
    if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
  } finally {
    try {
      closeDatabase();
    } catch {
      /* not open */
    }
  }
}

/** Register `setup` and `doctor` on the program. */
export function registerSetupCommands(
  program: Command,
  makePrompt: () => Prompt,
): void {
  // NOTE: `--data-dir` is a program-level global option (commander routes
  // it to the parent even when given after the subcommand, so declaring a
  // duplicate child option would shadow it into permanent undefined).
  program
    .command('setup [section]')
    .description(
      `Configure the hub section by section (${SECTIONS.map((s) => s.id).join(', ')}). Re-runnable.`,
    )
    .option('-y, --yes', 'Accept current values/defaults without prompting')
    .option('--set <key=value...>', 'Answer a field non-interactively (repeatable)')
    .action(async (section: string | undefined, options) => {
      await runSetupCommand(section, {
        ...options,
        dataDir: program.opts().dataDir,
        makePrompt,
      });
    });

  program
    .command('doctor')
    .description('Check prerequisites and hub health (add --deep for network/spawn probes)')
    .option('--deep', 'Include network and process-spawn probes')
    .option('--json', 'Machine-readable output')
    .action(async (options) => {
      await runDoctorCommand({ ...options, dataDir: program.opts().dataDir });
    });
}
