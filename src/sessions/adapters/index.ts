// ============================================================================
// Session Adapter Registry
// Central registry for format detection and adapter management
// ============================================================================

import type { SessionAdapter, AdapterDetectionResult, RawSessionContent } from './types.js';
import { ClaudeSessionAdapter } from './claude.js';
import { CodexSessionAdapter } from './codex.js';
import { RawSessionAdapter } from './raw.js';

export * from './types.js';
export { ClaudeSessionAdapter } from './claude.js';
export { CodexSessionAdapter } from './codex.js';
export { RawSessionAdapter } from './raw.js';

// ============================================================================
// Builtin Adapters
// ============================================================================

const builtinAdapters = new Map<string, SessionAdapter>();
builtinAdapters.set('claude_jsonl_v1', new ClaudeSessionAdapter());
builtinAdapters.set('codex_jsonl_v1', new CodexSessionAdapter());
builtinAdapters.set('raw', new RawSessionAdapter());

// Custom adapters registered at runtime
const customAdapters: Map<string, SessionAdapter> = new Map();

// ============================================================================
// Adapter Registry API
// ============================================================================

/**
 * Get all registered adapters (builtin + custom)
 */
export function getAllAdapters(): Map<string, SessionAdapter> {
  return new Map([...builtinAdapters, ...customAdapters]);
}

/**
 * Get a specific adapter by format ID
 */
export function getAdapter(formatId: string): SessionAdapter | null {
  return customAdapters.get(formatId) || builtinAdapters.get(formatId) || null;
}

/**
 * Register a custom adapter
 */
export function registerAdapter(adapter: SessionAdapter): void {
  if (builtinAdapters.has(adapter.formatId)) {
    throw new Error(
      `Cannot override builtin adapter: ${adapter.formatId}`
    );
  }
  customAdapters.set(adapter.formatId, adapter);
}

/**
 * Unregister a custom adapter
 */
export function unregisterAdapter(formatId: string): boolean {
  if (builtinAdapters.has(formatId)) {
    throw new Error(`Cannot unregister builtin adapter: ${formatId}`);
  }
  return customAdapters.delete(formatId);
}

// ============================================================================
// Format Detection
// ============================================================================

/**
 * Detect the format of session content
 * Returns the best matching adapter with confidence level
 */
export function detectFormat(content: string): AdapterDetectionResult | null {
  // Try each adapter in priority order
  const adapters = getAllAdapters();

  for (const [formatId, adapter] of adapters) {
    // Skip raw adapter - it's the fallback
    if (formatId === 'raw') continue;

    try {
      if (adapter.detect(content)) {
        return {
          formatId,
          formatName: adapter.formatName,
          confidence: 'high',
          adapter,
        };
      }
    } catch {
      // Detection failed - continue to next adapter
    }
  }

  // No match found - return null (caller can use raw adapter as fallback)
  return null;
}

/**
 * Detect format with extended information
 */
export function detectFormatExtended(
  raw: RawSessionContent
): AdapterDetectionResult {
  // First try content-based detection
  const contentResult = detectFormat(raw.content);
  if (contentResult) {
    return contentResult;
  }

  // Try filename-based detection
  if (raw.filename) {
    const ext = raw.filename.split('.').pop()?.toLowerCase();

    // Check for known filename patterns
    if (raw.filename.includes('session') && ext === 'jsonl') {
      // Likely a session file - try Claude first
      const claudeAdapter = getAdapter('claude_jsonl_v1');
      if (claudeAdapter?.detect(raw.content)) {
        return {
          formatId: 'claude_jsonl_v1',
          formatName: 'Claude Code Session',
          confidence: 'medium',
          adapter: claudeAdapter,
        };
      }

      // Try Codex
      const codexAdapter = getAdapter('codex_jsonl_v1');
      if (codexAdapter?.detect(raw.content)) {
        return {
          formatId: 'codex_jsonl_v1',
          formatName: 'Codex CLI Session',
          confidence: 'medium',
          adapter: codexAdapter,
        };
      }
    }
  }

  // Fallback to raw adapter
  const rawAdapter = getAdapter('raw')!;
  return {
    formatId: 'raw',
    formatName: 'Raw/Unknown Format',
    confidence: 'low',
    adapter: rawAdapter,
  };
}

/**
 * Get the appropriate adapter for a format ID
 * Falls back to raw adapter if not found
 */
export function getAdapterOrFallback(formatId: string): SessionAdapter {
  return getAdapter(formatId) || getAdapter('raw')!;
}

// ============================================================================
// Format Info
// ============================================================================

/**
 * Get information about all supported formats
 */
export function getSupportedFormats(): Array<{
  id: string;
  name: string;
  vendor?: string;
  builtin: boolean;
}> {
  const formats: Array<{
    id: string;
    name: string;
    vendor?: string;
    builtin: boolean;
  }> = [];

  for (const [id, adapter] of builtinAdapters) {
    formats.push({
      id,
      name: adapter.formatName,
      vendor: adapter.vendor,
      builtin: true,
    });
  }

  for (const [id, adapter] of customAdapters) {
    formats.push({
      id,
      name: adapter.formatName,
      vendor: adapter.vendor,
      builtin: false,
    });
  }

  return formats;
}

/**
 * Check if a format is supported
 */
export function isFormatSupported(formatId: string): boolean {
  return builtinAdapters.has(formatId) || customAdapters.has(formatId);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Quick stats extraction without full parsing
 * Uses the appropriate adapter to extract index
 */
export function quickExtractStats(
  content: string,
  formatId?: string
): { formatId: string; index: ReturnType<SessionAdapter['extractIndex']> } {
  let adapter: SessionAdapter;
  let detectedFormatId: string;

  if (formatId && isFormatSupported(formatId)) {
    adapter = getAdapterOrFallback(formatId);
    detectedFormatId = formatId;
  } else {
    const detection = detectFormatExtended({ content, sizeBytes: content.length });
    adapter = detection.adapter;
    detectedFormatId = detection.formatId;
  }

  return {
    formatId: detectedFormatId,
    index: adapter.extractIndex(content),
  };
}

/**
 * Convert session content to ACP events
 */
export function toAcpEvents(
  content: string,
  formatId?: string
): { formatId: string; events: ReturnType<SessionAdapter['toAcpEvents']> } {
  let adapter: SessionAdapter;
  let detectedFormatId: string;

  if (formatId && isFormatSupported(formatId)) {
    adapter = getAdapterOrFallback(formatId);
    detectedFormatId = formatId;
  } else {
    const detection = detectFormatExtended({ content, sizeBytes: content.length });
    adapter = detection.adapter;
    detectedFormatId = detection.formatId;
  }

  return {
    formatId: detectedFormatId,
    events: adapter.toAcpEvents(content),
  };
}
