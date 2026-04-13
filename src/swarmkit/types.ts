/**
 * SwarmKit configuration management types.
 *
 * OpenHive acts as a read/write proxy for SwarmKit package configs.
 * These types model the config descriptors, scopes, and API responses.
 */

// ─── Core types ─────────────────────────────────────────────────

export type PackageScope = 'global' | 'project';
export type ConfigFormat = 'json' | 'yaml';

export type PackageCategory =
  | 'orchestration'
  | 'protocol'
  | 'tasks'
  | 'interface'
  | 'learning'
  | 'observability';

/**
 * Locates a single config file on disk.
 * A package may produce 0–2 descriptors (global and/or project).
 */
export interface PackageConfigDescriptor {
  packageName: string;
  scope: PackageScope;
  /** Absolute path to the config directory */
  configDir: string;
  /** Filename: config.json, settings.json, config.yaml, config.yml */
  configFile: string;
  format: ConfigFormat;
  /** Whether the file currently exists on disk */
  exists: boolean;
  /** Optional sibling file for machine-specific overrides (e.g. settings.local.json).
   *  Same format as configFile. Read-merged over configFile (local wins). */
  localFile?: string;
}

// ─── SwarmKit global state ──────────────────────────────────────

export interface SwarmKitGlobalConfig {
  installedPackages?: string[];
  embeddingProvider?: 'openai' | 'gemini' | 'local' | null;
  embeddingModel?: string;
  usePrefix?: boolean;
  configVersion?: string;
}

export interface SwarmKitState {
  installed: boolean;
  installedPackages: string[];
  embeddingProvider: string | null;
  usePrefix: boolean;
  projectRoots: string[];
}

// ─── Package metadata ───────────────────────────────────────────

/** Serialized version of SwarmKit's InlineOption (no callbacks) */
export interface SerializedInlineOption {
  key: string;
  label: string;
  type: 'input' | 'select' | 'confirm' | 'password';
  default?: string | boolean | number;
  choices?: Array<{ name: string; value: string }>;
}

export interface PackageFieldMeta {
  label: string;
  description?: string;
  secret?: boolean;
}

export interface PackageMeta {
  name: string;
  description: string;
  category: PackageCategory;
  fields: Record<string, PackageFieldMeta>;
  inlineOptions: SerializedInlineOption[];
  scopes: PackageScope[];
}

// ─── API responses ──────────────────────────────────────────────

export interface PackageConfigResponse {
  packageName: string;
  scope: PackageScope;
  category: PackageCategory;
  description: string;
  config: Record<string, unknown>;
  /** Raw contents of the sibling local file (e.g. settings.local.json) when present.
   *  UI uses this to detect which keys came from the machine-specific file. */
  localConfig?: Record<string, unknown>;
  meta: PackageMeta;
  installed: boolean;
  configPath: string | null;
}

export interface IntegrationResponse {
  id: string;
  packages: [string, string];
  description: string;
  requiresWiring: boolean;
  active: boolean;
  configOptions: Array<{
    key: string;
    label: string;
    type: 'confirm' | 'input' | 'select';
    default?: string | boolean;
    choices?: Array<{ name: string; value: string }>;
    targetPackage: string;
    configPath: string;
    currentValue?: unknown;
  }>;
}

export interface SharedSettingTarget {
  packageName: string;
  configPath: string;
  currentValue?: unknown;
  inSync: boolean;
}

export interface SharedSettingStatus {
  key: string;
  label: string;
  type: 'select' | 'password';
  currentValue?: unknown;
  choices?: Array<{ name: string; value: string }>;
  targets: SharedSettingTarget[];
}

export interface PropagationResult {
  packageName: string;
  success: boolean;
  message?: string;
}

export interface DoctorCheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  fix?: string;
}

// ─── Project registry ───────────────────────────────────────────

export interface ProjectRegistryData {
  projectRoots: string[];
}
