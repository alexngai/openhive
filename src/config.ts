import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';

// Storage configuration schema
const LocalStorageSchema = z.object({
  type: z.literal('local'),
  path: z.string().default('./uploads'),
  publicUrl: z.string().default('/uploads'),
});

const S3StorageSchema = z.object({
  type: z.literal('s3'),
  bucket: z.string(),
  region: z.string(),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  endpoint: z.string().optional(),
  publicUrl: z.string().optional(),
});

const StorageSchema = z.discriminatedUnion('type', [
  LocalStorageSchema,
  S3StorageSchema,
]).optional();

// Database configuration schema
const SQLiteDatabaseSchema = z.object({
  type: z.literal('sqlite'),
  path: z.string().default('./data/openhive.db'),
});

const PostgresDatabaseSchema = z.object({
  type: z.literal('postgres'),
  host: z.string(),
  port: z.number().default(5432),
  database: z.string(),
  user: z.string(),
  password: z.string(),
  ssl: z.boolean().optional(),
  pool: z.object({
    min: z.number().optional(),
    max: z.number().optional(),
  }).optional(),
});

const DatabaseSchema = z.union([
  z.string(), // Simple path for SQLite (backward compatible)
  SQLiteDatabaseSchema,
  PostgresDatabaseSchema,
]).default('./data/openhive.db');

// Email configuration schema
const EmailSchema = z.object({
  enabled: z.boolean().default(false),
  from: z.string().default('noreply@openhive.local'),
  smtp: z.object({
    host: z.string(),
    port: z.number().default(587),
    secure: z.boolean().default(false),
    auth: z.object({
      user: z.string(),
      pass: z.string(),
    }).optional(),
  }).optional(),
}).default({ enabled: false, from: 'noreply@openhive.local' });

// Configuration schema
export const ConfigSchema = z.object({
  port: z.number().default(3000),
  host: z.string().default('0.0.0.0'),
  database: DatabaseSchema,

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

  storage: StorageSchema,

  email: EmailSchema,

  jwt: z.object({
    secret: z.string().optional(),
    expiresIn: z.string().default('7d'),
  }).default({}),

  // GitHub App configuration for automatic webhook handling
  githubApp: z.object({
    enabled: z.boolean().default(false),
    appId: z.string().optional(),
    webhookSecret: z.string().optional(),
    privateKey: z.string().optional(), // PEM format or path to file
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
  }).default({ enabled: false }),
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
  if (process.env.OPENHIVE_JWT_SECRET) {
    rawConfig.jwt = { ...rawConfig.jwt, secret: process.env.OPENHIVE_JWT_SECRET };
  }

  // GitHub App configuration from environment
  if (process.env.GITHUB_APP_ID || process.env.GITHUB_APP_WEBHOOK_SECRET) {
    rawConfig.githubApp = {
      ...rawConfig.githubApp,
      enabled: true,
      appId: process.env.GITHUB_APP_ID,
      webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET,
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
      clientId: process.env.GITHUB_APP_CLIENT_ID,
      clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
    };
  }

  // Generate a default JWT secret if not provided (for development)
  if (!rawConfig.jwt?.secret) {
    // Generate a random secret - in production, this should be set explicitly
    rawConfig.jwt = { ...rawConfig.jwt, secret: require('crypto').randomBytes(32).toString('hex') };
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

  // Storage configuration for media uploads
  // Uncomment to enable file uploads
  // storage: {
  //   type: 'local',
  //   path: './uploads',
  //   publicUrl: '/uploads',
  // },
  // Or use S3-compatible storage:
  // storage: {
  //   type: 's3',
  //   bucket: 'your-bucket',
  //   region: 'us-east-1',
  //   accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  //   secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  //   // endpoint: 'https://s3.amazonaws.com', // Optional: for MinIO or other S3-compatible services
  //   // publicUrl: 'https://cdn.example.com', // Optional: custom CDN URL
  // },

  // Email configuration for password resets and notifications
  // email: {
  //   enabled: true,
  //   from: 'noreply@example.com',
  //   smtp: {
  //     host: 'smtp.example.com',
  //     port: 587,
  //     secure: false,
  //     auth: {
  //       user: 'your-smtp-user',
  //       pass: process.env.SMTP_PASSWORD,
  //     },
  //   },
  // },

  // GitHub App for automatic memory bank webhook handling
  // Create a GitHub App at: https://github.com/settings/apps/new
  // githubApp: {
  //   enabled: true,
  //   appId: process.env.GITHUB_APP_ID,
  //   webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET,
  //   privateKey: process.env.GITHUB_APP_PRIVATE_KEY, // PEM format
  //   clientId: process.env.GITHUB_APP_CLIENT_ID,
  //   clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
  // },
};
`;
}
