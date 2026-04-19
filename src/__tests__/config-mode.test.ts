import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { ConfigSchema } from '../config.js';
import { renderDocument } from '../api/skill-fragments/index.js';

describe("config.mode", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.OPENHIVE_MODE;
    delete process.env.OPENHIVE_MODE;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OPENHIVE_MODE;
    else process.env.OPENHIVE_MODE = originalEnv;
  });

  it("defaults to 'full'", () => {
    const config = ConfigSchema.parse({});
    expect(config.mode).toBe('full');
  });

  it("accepts 'server' explicitly", () => {
    const config = ConfigSchema.parse({ mode: 'server' });
    expect(config.mode).toBe('server');
  });

  it("rejects unknown values", () => {
    expect(() => ConfigSchema.parse({ mode: 'other' })).toThrow();
  });

  it("skill.md in server mode omits social fragments", () => {
    const config = ConfigSchema.parse({ mode: 'server' });
    const md = renderDocument(config, { audiences: ['shared', 'agent'] });
    expect(md).not.toContain('## Quick Start');
    expect(md).not.toContain('### Posts');
    expect(md).toContain('## MAP Protocol (Agents)');
    expect(md).toContain('## Task Coordination');
  });

  it("skill.md in full mode includes everything", () => {
    const config = ConfigSchema.parse({ mode: 'full' });
    const md = renderDocument(config);
    expect(md).toContain('## Quick Start');
    expect(md).toContain('### Posts');
    expect(md).toContain('## MAP Protocol (Agents)');
  });
});

describe("admin.trustLocalMode", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.OPENHIVE_ADMIN_TRUST_LOCAL_MODE;
    delete process.env.OPENHIVE_ADMIN_TRUST_LOCAL_MODE;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OPENHIVE_ADMIN_TRUST_LOCAL_MODE;
    else process.env.OPENHIVE_ADMIN_TRUST_LOCAL_MODE = originalEnv;
  });

  it("defaults to false", () => {
    const config = ConfigSchema.parse({});
    expect(config.admin.trustLocalMode).toBe(false);
  });

  it("accepts true when set in config", () => {
    const config = ConfigSchema.parse({ admin: { trustLocalMode: true } });
    expect(config.admin.trustLocalMode).toBe(true);
  });

  it("rejects non-boolean values at schema time", () => {
    // @ts-expect-error - intentionally wrong type
    expect(() => ConfigSchema.parse({ admin: { trustLocalMode: 'yes' } })).toThrow();
  });
});
