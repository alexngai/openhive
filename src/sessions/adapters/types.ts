// ============================================================================
// Session Adapter Interface
// For converting between different session formats
// ============================================================================

import type {
  SessionEvent,
  SessionIndex,
  SessionResourceMetadata,
} from '../types.js';

/**
 * Session Adapter Interface
 * Implementations convert between native session formats and ACP-compatible events
 */
export interface SessionAdapter {
  /** Unique format identifier */
  readonly formatId: string;

  /** Human-readable format name */
  readonly formatName: string;

  /** Vendor/provider name */
  readonly vendor?: string;

  /**
   * Detect if the content matches this format
   * Should be fast - check first line(s) only
   */
  detect(content: string): boolean;

  /**
   * Extract index/stats without full conversion (fast path)
   * Used for creating searchable metadata without parsing everything
   */
  extractIndex(content: string): SessionIndex;

  /**
   * Extract configuration from session content
   */
  extractConfig?(content: string): SessionResourceMetadata['config'];

  /**
   * Parse to ACP-compatible events (full conversion)
   * This is the expensive operation - converts everything
   */
  toAcpEvents(content: string): SessionEvent[];

  /**
   * Serialize from ACP events back to native format
   * Not all adapters support this (one-way conversion is OK)
   */
  fromAcpEvents?(events: SessionEvent[]): string;

  /**
   * Get format-specific metadata
   */
  getFormatMetadata?(): {
    fileExtension: string;
    mimeType: string;
    supportsStreaming: boolean;
  };
}

/**
 * Adapter detection result
 */
export interface AdapterDetectionResult {
  formatId: string;
  formatName: string;
  confidence: 'high' | 'medium' | 'low';
  adapter: SessionAdapter;
}

/**
 * Raw session content with optional metadata
 */
export interface RawSessionContent {
  content: string;
  filename?: string;
  mimeType?: string;
  sizeBytes: number;
}
