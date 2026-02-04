// ============================================================================
// Raw Session Adapter
// Handles unknown/unsupported session formats with minimal processing
// Stores content as-is and provides basic stats
// ============================================================================

import type { SessionAdapter } from './types.js';
import type {
  SessionEvent,
  SessionIndex,
  SessionResourceMetadata,
} from '../types.js';

export class RawSessionAdapter implements SessionAdapter {
  readonly formatId = 'raw';
  readonly formatName = 'Raw/Unknown Format';

  detect(_content: string): boolean {
    // Raw adapter is the fallback - always returns false in detection
    // It's only used when no other adapter matches
    return false;
  }

  extractIndex(content: string): SessionIndex {
    const lines = content.split('\n');

    // Try to parse as JSONL and count potential messages
    let messageCount = 0;
    let toolCallCount = 0;

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const obj = JSON.parse(line);

        // Heuristic: count objects that look like messages
        if (
          obj.type === 'message' ||
          obj.role === 'user' ||
          obj.role === 'assistant' ||
          obj.type === 'user' ||
          obj.type === 'assistant'
        ) {
          messageCount++;
        }

        // Heuristic: count objects that look like tool calls
        if (
          obj.type === 'tool_call' ||
          obj.type === 'tool_use' ||
          obj.type === 'function_call' ||
          obj.tool_name ||
          obj.function?.name
        ) {
          toolCallCount++;
        }
      } catch {
        // Not JSON - count as potential message
        if (line.trim().length > 0) {
          messageCount++;
        }
      }
    }

    return {
      messageCount,
      toolCallCount,
    };
  }

  extractConfig(_content: string): SessionResourceMetadata['config'] {
    // No config extraction for raw format
    return undefined;
  }

  toAcpEvents(content: string): SessionEvent[] {
    const lines = content.split('\n');
    const events: SessionEvent[] = [];
    let sequence = 0;

    for (const line of lines) {
      if (!line.trim()) continue;

      const baseEvent = {
        id: `evt_${sequence}`,
        timestamp: new Date().toISOString(),
        sequence: sequence++,
      };

      try {
        const obj = JSON.parse(line);

        // Store as custom event with original data preserved
        events.push({
          ...baseEvent,
          type: 'custom',
          eventType: 'raw_line',
          data: obj,
          _original: obj,
        });
      } catch {
        // Not JSON - store as text content
        events.push({
          ...baseEvent,
          type: 'custom',
          eventType: 'raw_text',
          data: { text: line },
          _original: line,
        });
      }
    }

    return events;
  }

  fromAcpEvents(events: SessionEvent[]): string {
    // Convert back to original format if possible
    const lines: string[] = [];

    for (const event of events) {
      if (event.type === 'custom' && event._original) {
        if (typeof event._original === 'string') {
          lines.push(event._original);
        } else {
          lines.push(JSON.stringify(event._original));
        }
      } else {
        // Serialize event as JSON
        lines.push(JSON.stringify(event));
      }
    }

    return lines.join('\n');
  }

  getFormatMetadata() {
    return {
      fileExtension: '.jsonl',
      mimeType: 'application/octet-stream',
      supportsStreaming: true,
    };
  }
}
