import { describe, it, expect } from 'vitest';
import { generateSkillMd } from '../skill.js';
import { ALL_FRAGMENTS, collectFragments, renderFragment } from '../api/skill-fragments/index.js';
import { ConfigSchema } from '../config.js';

function makeConfig() {
  return ConfigSchema.parse({
    port: 3000,
    instance: { name: 'Test Hive', description: 'Test description' },
  });
}

describe('skill.md fragments', () => {
  it('renders a complete document with key sections present', () => {
    const md = generateSkillMd(makeConfig());

    expect(md).toContain('# Test Hive - OpenHive API');
    expect(md).toContain('## Overview');
    expect(md).toContain('## Base URL');
    expect(md).toContain('## Authentication');
    expect(md).toContain('## Quick Start');
    expect(md).toContain('## API Reference');
    expect(md).toContain('### Agents');
    expect(md).toContain('### Hives (Communities)');
    expect(md).toContain('### Posts');
    expect(md).toContain('### Comments');
    expect(md).toContain('### Feed');
    expect(md).toContain('### Voting');
    expect(md).toContain('## WebSocket');
    expect(md).toContain('## Errors');
    expect(md).toContain('## Federation');
    expect(md).toContain('*OpenHive v0.1.0*');
  });

  it('includes MAP/agent sections for connected agents', () => {
    const md = generateSkillMd(makeConfig());
    expect(md).toContain('## MAP Protocol (Agents)');
    expect(md).toContain('map/agents/register');
    expect(md).toContain('## Task Coordination');
    expect(md).toContain('map/tasks/create');
    expect(md).toContain('## Dispatch Orchestrator');
    expect(md).toContain('map/specs/dispatch');
    expect(md).toContain('## Session Trajectories');
    expect(md).toContain('trajectory/checkpoint');
    expect(md).toContain('## Cascade Coordination');
    expect(md).toContain('x-cascade/stream.opened');
    expect(md).toContain('## Resource Sync');
    expect(md).toContain('x-openhive/memory.sync');
    expect(md).toContain('## Mail (Async Conversations)');
    expect(md).toContain('## Session Chat');
    expect(md).toContain('## Coordination (WebSocket Events)');
  });

  it('injects configured instance name and description', () => {
    const md = generateSkillMd(
      ConfigSchema.parse({
        instance: { name: 'My Hub', description: 'Custom desc' },
      }),
    );
    expect(md).toContain('# My Hub - OpenHive API');
    expect(md).toContain('Custom desc');
  });

  it('uses configured base URL in curl examples', () => {
    const md = generateSkillMd(
      ConfigSchema.parse({
        port: 8080,
        instance: { name: 'Test', url: 'https://hive.example.com' },
      }),
    );
    expect(md).toContain('https://hive.example.com/api/v1');
    expect(md).toContain('wss://hive.example.com/ws');
  });

  it('collectFragments filters by audience', () => {
    const config = makeConfig();
    const agentOnly = collectFragments(config, { audiences: ['shared', 'agent'] });
    const ids = agentOnly.map((f) => f.id);
    expect(ids).not.toContain('social');
    expect(ids).not.toContain('quickstart');
    expect(ids).toContain('intro');
    expect(ids).toContain('auth');
  });

  it('renderFragment returns null for unknown ids', () => {
    expect(renderFragment('does-not-exist', makeConfig())).toBeNull();
  });

  it('renderFragment returns content for known id', () => {
    const content = renderFragment('intro', makeConfig());
    expect(content).toBeTruthy();
    expect(content).toContain('OpenHive API');
  });

  it('all fragments have unique ids', () => {
    const ids = ALL_FRAGMENTS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
