import { describe, it, expect } from 'vitest';
import { ConfigSchema } from '../../config.js';

describe('swarmHosting config', () => {
  it('should be enabled by default', () => {
    const config = ConfigSchema.parse({});
    expect(config.swarmHosting.enabled).toBe(true);
  });

  it('should have sensible defaults when enabled', () => {
    const config = ConfigSchema.parse({
      swarmHosting: { enabled: true },
    });

    expect(config.swarmHosting.enabled).toBe(true);
    expect(config.swarmHosting.default_provider).toBe('local');
    expect(config.swarmHosting.openswarm_command).toBe('npx openswarm serve');
    expect(config.swarmHosting.data_dir).toBe('./data/swarms');
    expect(config.swarmHosting.port_range).toEqual([9000, 9100]);
    expect(config.swarmHosting.max_swarms).toBe(10);
    expect(config.swarmHosting.health_check_interval).toBe(30000);
    expect(config.swarmHosting.max_health_failures).toBe(3);
  });

  it('should accept custom port range', () => {
    const config = ConfigSchema.parse({
      swarmHosting: {
        enabled: true,
        port_range: [8000, 8050],
      },
    });

    expect(config.swarmHosting.port_range).toEqual([8000, 8050]);
  });

  it('should accept custom openswarm command', () => {
    const config = ConfigSchema.parse({
      swarmHosting: {
        enabled: true,
        openswarm_command: '/usr/local/bin/openswarm',
      },
    });

    expect(config.swarmHosting.openswarm_command).toBe('/usr/local/bin/openswarm');
  });

  it('should accept docker provider', () => {
    const config = ConfigSchema.parse({
      swarmHosting: {
        enabled: true,
        default_provider: 'docker',
      },
    });

    expect(config.swarmHosting.default_provider).toBe('docker');
  });

  it('should reject invalid provider', () => {
    expect(() => {
      ConfigSchema.parse({
        swarmHosting: {
          enabled: true,
          default_provider: 'invalid-provider',
        },
      });
    }).toThrow();
  });

  it('should accept custom max_swarms', () => {
    const config = ConfigSchema.parse({
      swarmHosting: {
        enabled: true,
        max_swarms: 50,
      },
    });

    expect(config.swarmHosting.max_swarms).toBe(50);
  });

  it('should accept custom health check settings', () => {
    const config = ConfigSchema.parse({
      swarmHosting: {
        enabled: true,
        health_check_interval: 60000,
        max_health_failures: 5,
      },
    });

    expect(config.swarmHosting.health_check_interval).toBe(60000);
    expect(config.swarmHosting.max_health_failures).toBe(5);
  });

  it('should accept all providers in the enum', () => {
    for (const provider of ['local', 'docker', 'fly', 'ssh', 'k8s'] as const) {
      const config = ConfigSchema.parse({
        swarmHosting: {
          enabled: true,
          default_provider: provider,
        },
      });
      expect(config.swarmHosting.default_provider).toBe(provider);
    }
  });

  it('should accept full custom config', () => {
    const config = ConfigSchema.parse({
      swarmHosting: {
        enabled: true,
        default_provider: 'local',
        openswarm_command: 'bun run openswarm',
        data_dir: '/var/lib/swarms',
        port_range: [10000, 10100],
        max_swarms: 20,
        health_check_interval: 15000,
        max_health_failures: 5,
      },
    });

    expect(config.swarmHosting.enabled).toBe(true);
    expect(config.swarmHosting.openswarm_command).toBe('bun run openswarm');
    expect(config.swarmHosting.data_dir).toBe('/var/lib/swarms');
    expect(config.swarmHosting.port_range).toEqual([10000, 10100]);
    expect(config.swarmHosting.max_swarms).toBe(20);
  });
});
