import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveCredentialSet, resolveCredentialOverlay } from '../../swarm/credentials.js';
import type { CredentialSetConfig, SwarmCredentialConfig } from '../../swarm/types.js';

describe('resolveCredentialSet', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and set test env vars
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    savedEnv.CUSTOM_KEY = process.env.CUSTOM_KEY;
    savedEnv.FALLBACK_VAR = process.env.FALLBACK_VAR;

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-123';
    process.env.OPENAI_API_KEY = 'sk-openai-test-456';
    process.env.CUSTOM_KEY = 'custom-value';
    process.env.FALLBACK_VAR = 'fallback-value';
  });

  afterEach(() => {
    // Restore env
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it('resolves static source with literal values', () => {
    const set: CredentialSetConfig = {
      source: 'static',
      vars: {
        API_KEY: 'my-literal-key',
        SECRET: 'my-secret',
      },
    };

    const result = resolveCredentialSet(set);
    expect(result).toEqual({
      API_KEY: 'my-literal-key',
      SECRET: 'my-secret',
    });
  });

  it('defaults to static source when source is omitted', () => {
    const set: CredentialSetConfig = {
      vars: { KEY: 'value' },
    };

    const result = resolveCredentialSet(set);
    expect(result).toEqual({ KEY: 'value' });
  });

  it('skips empty values for static source', () => {
    const set: CredentialSetConfig = {
      source: 'static',
      vars: { PRESENT: 'yes', EMPTY: '' },
    };

    const result = resolveCredentialSet(set);
    expect(result).toEqual({ PRESENT: 'yes' });
  });

  it('resolves env source by reading process.env', () => {
    const set: CredentialSetConfig = {
      source: 'env',
      vars: {
        ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
        OPENAI_API_KEY: 'OPENAI_API_KEY',
      },
    };

    const result = resolveCredentialSet(set);
    expect(result).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-test-123',
      OPENAI_API_KEY: 'sk-openai-test-456',
    });
  });

  it('supports env var remapping', () => {
    const set: CredentialSetConfig = {
      source: 'env',
      vars: {
        MY_ANTHROPIC_KEY: 'ANTHROPIC_API_KEY',
      },
    };

    const result = resolveCredentialSet(set);
    expect(result).toEqual({ MY_ANTHROPIC_KEY: 'sk-ant-test-123' });
  });

  it('skips missing env vars silently', () => {
    const set: CredentialSetConfig = {
      source: 'env',
      vars: {
        ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
        MISSING_KEY: 'DOES_NOT_EXIST_IN_ENV',
      },
    };

    const result = resolveCredentialSet(set);
    expect(result).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-test-123' });
    expect(result).not.toHaveProperty('MISSING_KEY');
  });

  it('resolves env-fallback with static value taking priority', () => {
    const set: CredentialSetConfig = {
      source: 'env-fallback',
      vars: {
        ANTHROPIC_API_KEY: 'my-override-value',
      },
    };

    const result = resolveCredentialSet(set);
    expect(result).toEqual({ ANTHROPIC_API_KEY: 'my-override-value' });
  });

  it('resolves env-fallback falling back to process.env when value is empty', () => {
    const set: CredentialSetConfig = {
      source: 'env-fallback',
      vars: {
        FALLBACK_VAR: '',
      },
    };

    const result = resolveCredentialSet(set);
    expect(result).toEqual({ FALLBACK_VAR: 'fallback-value' });
  });
});

describe('resolveCredentialOverlay', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    savedEnv.COGOPS_KEY = process.env.COGOPS_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-default';
    process.env.OPENAI_API_KEY = 'sk-openai-default';
    process.env.COGOPS_KEY = 'sk-cogops';
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  const baseConfig: SwarmCredentialConfig = {
    sets: {
      'llm-default': {
        source: 'env',
        vars: {
          ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
          OPENAI_API_KEY: 'OPENAI_API_KEY',
        },
      },
      'cogops': {
        source: 'env',
        vars: {
          ANTHROPIC_API_KEY: 'COGOPS_KEY',
        },
      },
    },
    default_set: 'llm-default',
    hive_overrides: {
      'cogops-hive': {
        credential_set: 'cogops',
      },
      'repo-hive': {
        extra_vars: {
          GITHUB_TOKEN: 'gh-token-for-repo',
        },
      },
    },
  };

  it('returns empty object when no config is provided', () => {
    const result = resolveCredentialOverlay(undefined);
    expect(result).toEqual({});
  });

  it('returns empty object when config has no sets or overrides', () => {
    const result = resolveCredentialOverlay({});
    expect(result).toEqual({});
  });

  it('resolves default_set credentials', () => {
    const result = resolveCredentialOverlay(baseConfig);
    expect(result).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-default',
      OPENAI_API_KEY: 'sk-openai-default',
    });
  });

  it('applies hive credential_set override', () => {
    const result = resolveCredentialOverlay(baseConfig, 'cogops-hive');
    // cogops set maps ANTHROPIC_API_KEY to COGOPS_KEY env var
    expect(result.ANTHROPIC_API_KEY).toBe('sk-cogops');
    // default_set provided OPENAI_API_KEY, cogops set overwrites ANTHROPIC_API_KEY
    expect(result.OPENAI_API_KEY).toBe('sk-openai-default');
  });

  it('applies hive extra_vars overlay', () => {
    const result = resolveCredentialOverlay(baseConfig, 'repo-hive');
    expect(result).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-default',
      OPENAI_API_KEY: 'sk-openai-default',
      GITHUB_TOKEN: 'gh-token-for-repo',
    });
  });

  it('applies spawn-time overrides with highest priority', () => {
    const result = resolveCredentialOverlay(baseConfig, undefined, {
      ANTHROPIC_API_KEY: 'sk-spawn-override',
      EXTRA_VAR: 'extra',
    });
    expect(result.ANTHROPIC_API_KEY).toBe('sk-spawn-override');
    expect(result.OPENAI_API_KEY).toBe('sk-openai-default');
    expect(result.EXTRA_VAR).toBe('extra');
  });

  it('spawn overrides win over hive overrides', () => {
    const result = resolveCredentialOverlay(baseConfig, 'cogops-hive', {
      ANTHROPIC_API_KEY: 'sk-final-override',
    });
    expect(result.ANTHROPIC_API_KEY).toBe('sk-final-override');
  });

  it('ignores unknown hive names gracefully', () => {
    const result = resolveCredentialOverlay(baseConfig, 'nonexistent-hive');
    // Should just return default_set
    expect(result).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-default',
      OPENAI_API_KEY: 'sk-openai-default',
    });
  });

  it('handles missing default_set gracefully', () => {
    const config: SwarmCredentialConfig = {
      sets: { 'some-set': { source: 'static', vars: { KEY: 'val' } } },
      default_set: 'nonexistent',
    };
    const result = resolveCredentialOverlay(config);
    expect(result).toEqual({});
  });
});
