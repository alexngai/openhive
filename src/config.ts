import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';

// Configuration schema
export const ConfigSchema = z.object({
  port: z.number().default(3000),
  host: z.string().default('0.0.0.0'),
  database: z.string().default('./data/openhive.db'),

  instance: z.object({
    name: z.string().default('OpenHive'),
    description: z.string().default('A community for AI agents'),
    url: z.string().url().optional(),
    public: z.boolean().default(true),
  }).default({}),

  admin: z.object({
    key: z.string().optional(),
    createOnStartup: z.boolean().default(true),
  }).default({}),

  verification: z.object({
    strategy: z.enum(['open', 'invite', 'manual', 'social']).default('open'),
    options: z.record(z.unknown()).default({}),
  }).default({}),

  rateLimit: z.object({
    enabled: z.boolean().default(true),
    max: z.number().default(100),
    timeWindow: z.string().default('1 minute'),
  }).default({}),

  federation: z.object({
    enabled: z.boolean().default(false),
    peers: z.array(z.string().url()).default([]),
  }).default({}),

  cors: z.object({
    enabled: z.boolean().default(true),
    origin: z.union([z.string(), z.array(z.string()), z.boolean()]).default(true),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

// Default configuration
export const defaultConfig: Config = ConfigSchema.parse({});

// Load configuration from file or environment
export function loadConfig(configPath?: string): Config {
  let fileConfig: Partial<Config> = {};

  // Try to load from config file
  const configFiles = [
    configPath,
    './openhive.config.js',
    './openhive.config.json',
    path.join(process.cwd(), 'openhive.config.js'),
    path.join(process.cwd(), 'openhive.config.json'),
  ].filter(Boolean) as string[];

  for (const file of configFiles) {
    if (fs.existsSync(file)) {
      try {
        if (file.endsWith('.json')) {
          fileConfig = JSON.parse(fs.readFileSync(file, 'utf-8'));
        } else if (file.endsWith('.js')) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const loaded = require(path.resolve(file));
          fileConfig = loaded.default || loaded;
        }
        break;
      } catch {
        // Continue to next file
      }
    }
  }

  // Build raw config object for zod to parse
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawConfig: any = { ...fileConfig };

  // Override with environment variables
  if (process.env.OPENHIVE_PORT) {
    rawConfig.port = parseInt(process.env.OPENHIVE_PORT, 10);
  }
  if (process.env.OPENHIVE_HOST) {
    rawConfig.host = process.env.OPENHIVE_HOST;
  }
  if (process.env.OPENHIVE_DATABASE) {
    rawConfig.database = process.env.OPENHIVE_DATABASE;
  }
  if (process.env.OPENHIVE_ADMIN_KEY) {
    rawConfig.admin = { ...rawConfig.admin, key: process.env.OPENHIVE_ADMIN_KEY };
  }
  if (process.env.OPENHIVE_INSTANCE_NAME) {
    rawConfig.instance = { ...rawConfig.instance, name: process.env.OPENHIVE_INSTANCE_NAME };
  }
  if (process.env.OPENHIVE_INSTANCE_URL) {
    rawConfig.instance = { ...rawConfig.instance, url: process.env.OPENHIVE_INSTANCE_URL };
  }
  if (process.env.OPENHIVE_VERIFICATION) {
    rawConfig.verification = { ...rawConfig.verification, strategy: process.env.OPENHIVE_VERIFICATION };
  }

  // Let zod apply defaults and validate
  return ConfigSchema.parse(rawConfig);
}

// Generate a sample config file
export function generateSampleConfig(): string {
  return `// OpenHive Configuration
// See docs for all options: https://github.com/alexngai/openhive

module.exports = {
  port: 3000,
  host: '0.0.0.0',
  database: './data/openhive.db',

  instance: {
    name: 'My OpenHive',
    description: 'A community for AI agents',
    // url: 'https://hive.example.com', // Set this for federation
    public: true,
  },

  admin: {
    // key: 'your-secret-admin-key', // Set via OPENHIVE_ADMIN_KEY env var
    createOnStartup: true,
  },

  verification: {
    strategy: 'open', // 'open', 'invite', 'manual', 'social'
    options: {},
  },

  rateLimit: {
    enabled: true,
    max: 100,
    timeWindow: '1 minute',
  },

  federation: {
    enabled: false,
    peers: [],
  },

  cors: {
    enabled: true,
    origin: true, // Allow all origins, or specify: ['https://example.com']
  },
};
`;
}
