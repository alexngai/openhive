// ============================================================================
// Codex CLI Session Adapter
// Converts Codex CLI session format to ACP-compatible events
// ============================================================================

import type { SessionAdapter } from './types.js';
import type {
  SessionEvent,
  SessionIndex,
  SessionResourceMetadata,
  TextContent,
  MessagePreview,
  ToolCallSummary,
} from '../types.js';

/**
 * Codex session line types
 */
interface CodexSessionLine {
  // Metadata header (first line)
  id?: string;
  model?: string;
  rollout_id?: string;
  ts?: string;

  // Event lines
  event?: string;
  data?: {
    id?: string;
    text?: string;
    command?: string;
    tool_name?: string;
    args?: Record<string, unknown>;
    exit_code?: number;
    output?: string;
    error?: string;
  };
  token_count?: number;
}

export class CodexSessionAdapter implements SessionAdapter {
  readonly formatId = 'codex_jsonl_v1';
  readonly formatName = 'Codex CLI Session';
  readonly vendor = 'openai';

  detect(content: string): boolean {
    const firstLine = content.split('\n')[0]?.trim();
    if (!firstLine) return false;

    try {
      const obj = JSON.parse(firstLine) as CodexSessionLine;
      // Codex sessions have a metadata header with rollout_id/id/model
      // or event lines with turn.* / item.* prefixes
      return (
        (obj.id !== undefined && obj.model !== undefined) ||
        (obj.rollout_id !== undefined) ||
        (typeof obj.event === 'string' &&
          (obj.event.startsWith('turn.') || obj.event.startsWith('item.')))
      );
    } catch {
      return false;
    }
  }

  extractIndex(content: string): SessionIndex {
    const lines = content.trim().split('\n');
    let messageCount = 0;
    let toolCallCount = 0;
    let firstEventAt: string | undefined;
    let lastEventAt: string | undefined;
    const messagesPreview: MessagePreview[] = [];
    const toolCallsMap = new Map<string, { count: number; lastUsedAt?: string }>();

    for (let i = 0; i < lines.length; i++) {
      try {
        const line = JSON.parse(lines[i]) as CodexSessionLine;

        // Track timestamps
        if (line.ts) {
          if (!firstEventAt) firstEventAt = line.ts;
          lastEventAt = line.ts;
        }

        // Skip metadata header
        if (line.rollout_id || (line.id && line.model && !line.event)) {
          continue;
        }

        // Count messages
        if (
          line.event === 'item.user_message' ||
          line.event === 'item.assistant_message'
        ) {
          messageCount++;

          // Build preview
          if (messagesPreview.length < 6 && line.data?.text) {
            messagesPreview.push({
              id: line.data.id || `msg_${i}`,
              type:
                line.event === 'item.user_message'
                  ? 'user_message'
                  : 'assistant_message',
              timestamp: line.ts || new Date().toISOString(),
              contentPreview: line.data.text.substring(0, 100),
            });
          }
        }

        // Count tool calls
        if (
          line.event === 'item.command_execution' ||
          line.event === 'item.mcp_tool_call'
        ) {
          toolCallCount++;
          const toolName = line.data?.command || line.data?.tool_name || 'unknown';
          const existing = toolCallsMap.get(toolName) || { count: 0 };
          toolCallsMap.set(toolName, {
            count: existing.count + 1,
            lastUsedAt: line.ts,
          });
        }
      } catch {
        continue;
      }
    }

    const toolCallsSummary: ToolCallSummary[] = Array.from(
      toolCallsMap.entries()
    ).map(([toolName, data]) => ({
      toolName,
      count: data.count,
      lastUsedAt: data.lastUsedAt,
    }));

    return {
      messageCount,
      toolCallCount,
      firstEventAt,
      lastEventAt,
      messagesPreview,
      toolCallsSummary,
    };
  }

  extractConfig(content: string): SessionResourceMetadata['config'] {
    const firstLine = content.split('\n')[0]?.trim();
    if (!firstLine) return undefined;

    try {
      const obj = JSON.parse(firstLine) as CodexSessionLine;
      return {
        model: obj.model,
      };
    } catch {
      return undefined;
    }
  }

  toAcpEvents(content: string): SessionEvent[] {
    const lines = content.trim().split('\n');
    const events: SessionEvent[] = [];
    let sequence = 0;

    for (const lineStr of lines) {
      try {
        const line = JSON.parse(lineStr) as CodexSessionLine;

        // Skip metadata header
        if (line.rollout_id || (line.id && line.model && !line.event)) {
          continue;
        }

        const baseEvent = {
          id: line.data?.id || `evt_${sequence}`,
          timestamp: line.ts || new Date().toISOString(),
          sequence: sequence++,
        };

        switch (line.event) {
          case 'item.user_message':
            events.push({
              ...baseEvent,
              type: 'user_message',
              content: [{ type: 'text', text: line.data?.text || '' }],
            });
            break;

          case 'item.assistant_message':
            events.push({
              ...baseEvent,
              type: 'assistant_message',
              content: [{ type: 'text', text: line.data?.text || '' }],
            });
            break;

          case 'item.command_execution':
          case 'item.mcp_tool_call':
            events.push({
              ...baseEvent,
              type: 'tool_call',
              toolCallId: baseEvent.id,
              toolName:
                line.data?.command || line.data?.tool_name || 'unknown',
              input: line.data?.args || {},
            });

            // If there's output, also create a result event
            if (line.data?.output || line.data?.error) {
              events.push({
                ...baseEvent,
                id: `${baseEvent.id}_result`,
                type: 'tool_result',
                toolCallId: baseEvent.id,
                content: [
                  {
                    type: 'text',
                    text: line.data.output || line.data.error || '',
                  } as TextContent,
                ],
                isError: line.data.error !== undefined,
              });
            }
            break;

          case 'turn.started':
          case 'turn.completed':
            // Turn boundaries - store as custom events
            events.push({
              ...baseEvent,
              type: 'custom',
              eventType: `codex_${line.event}`,
              data: line,
              _original: line,
            });
            break;

          default:
            if (line.event) {
              // Store other events as custom
              events.push({
                ...baseEvent,
                type: 'custom',
                eventType: `codex_${line.event}`,
                data: line,
                _original: line,
              });
            }
        }
      } catch {
        continue;
      }
    }

    return events;
  }

  getFormatMetadata() {
    return {
      fileExtension: '.jsonl',
      mimeType: 'application/x-ndjson',
      supportsStreaming: true,
    };
  }
}
