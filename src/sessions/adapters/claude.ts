// ============================================================================
// Claude Code Session Adapter
// Converts Claude Code session.jsonl format to ACP-compatible events
// ============================================================================

import type { SessionAdapter } from './types.js';
import type {
  SessionEvent,
  SessionIndex,
  SessionResourceMetadata,
  ContentBlock,
  TextContent,
  ToolCallContent,
  ToolResultContent,
  MessagePreview,
  ToolCallSummary,
} from '../types.js';

/**
 * Claude Code session.jsonl line types
 */
interface ClaudeSessionLine {
  type: 'user' | 'assistant' | 'result' | 'summary';
  sessionId?: string;
  timestamp?: string;
  uuid?: string;
  cwd?: string;
  model?: string;
  gitBranch?: string;
  message?: {
    role: string;
    content: string | ClaudeContentBlock[];
    stop_reason?: string;
  };
  // For result type
  tool_use_id?: string;
  result?: string;
  is_error?: boolean;
  // For summary type
  summary?: string;
  cost_usd?: number;
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
}

interface ClaudeContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ClaudeContentBlock[];
  is_error?: boolean;
}

export class ClaudeSessionAdapter implements SessionAdapter {
  readonly formatId = 'claude_jsonl_v1';
  readonly formatName = 'Claude Code Session';
  readonly vendor = 'anthropic';

  detect(content: string): boolean {
    const firstLine = content.split('\n')[0]?.trim();
    if (!firstLine) return false;

    try {
      const obj = JSON.parse(firstLine) as ClaudeSessionLine;
      // Claude sessions have type, and usually sessionId/cwd on first line
      return (
        typeof obj.type === 'string' &&
        (obj.sessionId !== undefined || obj.cwd !== undefined) &&
        ['user', 'assistant', 'result', 'summary'].includes(obj.type)
      );
    } catch {
      return false;
    }
  }

  extractIndex(content: string): SessionIndex {
    const lines = content.trim().split('\n');
    let messageCount = 0;
    let toolCallCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let firstEventAt: string | undefined;
    let lastEventAt: string | undefined;
    const messagesPreview: MessagePreview[] = [];
    const toolCallsMap = new Map<string, { count: number; lastUsedAt?: string }>();

    for (let i = 0; i < lines.length; i++) {
      try {
        const line = JSON.parse(lines[i]) as ClaudeSessionLine;

        // Track timestamps
        if (line.timestamp) {
          if (!firstEventAt) firstEventAt = line.timestamp;
          lastEventAt = line.timestamp;
        }

        // Count messages
        if (line.type === 'user' || line.type === 'assistant') {
          messageCount++;

          // Build preview for first and last few messages
          if (messagesPreview.length < 3 || i >= lines.length - 3) {
            const contentPreview = this.extractContentPreview(line);
            if (contentPreview && messagesPreview.length < 6) {
              messagesPreview.push({
                id: line.uuid || `msg_${i}`,
                type: line.type === 'user' ? 'user_message' : 'assistant_message',
                timestamp: line.timestamp || new Date().toISOString(),
                contentPreview,
              });
            }
          }
        }

        // Count tool calls
        if (line.type === 'assistant' && line.message?.content) {
          const content = line.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_use' && block.name) {
                toolCallCount++;
                const existing = toolCallsMap.get(block.name) || { count: 0 };
                toolCallsMap.set(block.name, {
                  count: existing.count + 1,
                  lastUsedAt: line.timestamp,
                });
              }
            }
          }
        }

        // Track tokens from summary
        if (line.type === 'summary') {
          if (line.input_tokens) inputTokens += line.input_tokens;
          if (line.output_tokens) outputTokens += line.output_tokens;
        }
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    // Convert tool calls map to summary
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
      inputTokens: inputTokens || undefined,
      outputTokens: outputTokens || undefined,
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
      const obj = JSON.parse(firstLine) as ClaudeSessionLine;
      return {
        workingDirectory: obj.cwd,
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
        const line = JSON.parse(lineStr) as ClaudeSessionLine;
        const baseEvent = {
          id: line.uuid || `evt_${sequence}`,
          timestamp: line.timestamp || new Date().toISOString(),
          sequence: sequence++,
        };

        switch (line.type) {
          case 'user':
            events.push({
              ...baseEvent,
              type: 'user_message',
              content: this.convertClaudeContent(line.message?.content),
            });
            break;

          case 'assistant':
            // Check for thinking blocks
            if (line.message?.content && Array.isArray(line.message.content)) {
              const thinkingBlocks = line.message.content.filter(
                (b) => b.type === 'thinking'
              );
              for (const thinking of thinkingBlocks) {
                if (thinking.thinking) {
                  events.push({
                    ...baseEvent,
                    id: `${baseEvent.id}_thinking`,
                    type: 'assistant_thinking',
                    thinking: thinking.thinking,
                  });
                }
              }
            }

            events.push({
              ...baseEvent,
              type: 'assistant_message',
              content: this.convertClaudeContent(line.message?.content),
              stopReason: this.mapStopReason(line.message?.stop_reason),
            });
            break;

          case 'result':
            events.push({
              ...baseEvent,
              type: 'tool_result',
              toolCallId: line.tool_use_id || 'unknown',
              content: [
                {
                  type: 'text',
                  text: line.result || '',
                } as TextContent,
              ],
              isError: line.is_error,
            });
            break;

          case 'summary':
            // Convert to token usage event
            if (line.input_tokens || line.output_tokens) {
              events.push({
                ...baseEvent,
                type: 'token_usage',
                inputTokens: line.input_tokens || 0,
                outputTokens: line.output_tokens || 0,
              });
            }
            break;

          default:
            // Store unknown types as custom events
            events.push({
              ...baseEvent,
              type: 'custom',
              eventType: `claude_${line.type}`,
              data: line,
              _original: line,
            });
        }
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    return events;
  }

  fromAcpEvents(events: SessionEvent[]): string {
    // Convert ACP events back to Claude JSONL format
    const lines: string[] = [];

    for (const event of events) {
      const claudeLine: Partial<ClaudeSessionLine> = {
        timestamp: event.timestamp,
        uuid: event.id,
      };

      switch (event.type) {
        case 'user_message':
          claudeLine.type = 'user';
          claudeLine.message = {
            role: 'user',
            content: this.convertToClaudeContent(event.content),
          };
          break;

        case 'assistant_message':
          claudeLine.type = 'assistant';
          claudeLine.message = {
            role: 'assistant',
            content: this.convertToClaudeContent(event.content),
            stop_reason: event.stopReason,
          };
          break;

        case 'tool_result':
          claudeLine.type = 'result';
          claudeLine.tool_use_id = event.toolCallId;
          claudeLine.result = event.content
            .filter((c): c is TextContent => c.type === 'text')
            .map((c) => c.text)
            .join('\n');
          claudeLine.is_error = event.isError;
          break;

        case 'token_usage':
          claudeLine.type = 'summary';
          claudeLine.input_tokens = event.inputTokens;
          claudeLine.output_tokens = event.outputTokens;
          break;

        default:
          // Skip events that don't map to Claude format
          continue;
      }

      lines.push(JSON.stringify(claudeLine));
    }

    return lines.join('\n');
  }

  getFormatMetadata() {
    return {
      fileExtension: '.jsonl',
      mimeType: 'application/x-ndjson',
      supportsStreaming: true,
    };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private extractContentPreview(line: ClaudeSessionLine): string | undefined {
    const content = line.message?.content;
    if (!content) return undefined;

    if (typeof content === 'string') {
      return content.substring(0, 100);
    }

    if (Array.isArray(content)) {
      const textBlocks = content.filter((b) => b.type === 'text');
      if (textBlocks.length > 0 && textBlocks[0].text) {
        return textBlocks[0].text.substring(0, 100);
      }
    }

    return undefined;
  }

  private convertClaudeContent(
    content: string | ClaudeContentBlock[] | undefined
  ): ContentBlock[] {
    if (!content) return [];

    if (typeof content === 'string') {
      return [{ type: 'text', text: content }];
    }

    return content
      .filter((block) => block.type !== 'thinking') // Thinking handled separately
      .map((block): ContentBlock => {
        switch (block.type) {
          case 'text':
            return { type: 'text', text: block.text || '' };

          case 'tool_use':
            return {
              type: 'tool_call',
              toolCallId: block.id || 'unknown',
              toolName: block.name || 'unknown',
              input: block.input || {},
              status: 'completed',
            } as ToolCallContent;

          case 'tool_result':
            return {
              type: 'tool_result',
              toolCallId: block.tool_use_id || 'unknown',
              content: [
                {
                  type: 'text',
                  text:
                    typeof block.content === 'string'
                      ? block.content
                      : JSON.stringify(block.content),
                },
              ],
              isError: block.is_error,
            } as ToolResultContent;

          default:
            return { type: 'text', text: JSON.stringify(block) };
        }
      });
  }

  private convertToClaudeContent(
    content: ContentBlock[]
  ): string | ClaudeContentBlock[] {
    // If only text, return as string
    if (content.length === 1 && content[0].type === 'text') {
      return (content[0] as TextContent).text;
    }

    return content.map((block): ClaudeContentBlock => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text };

        case 'tool_call':
          return {
            type: 'tool_use',
            id: block.toolCallId,
            name: block.toolName,
            input: block.input,
          };

        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: block.toolCallId,
            content: block.content
              .filter((c): c is TextContent => c.type === 'text')
              .map((c) => c.text)
              .join('\n'),
            is_error: block.isError,
          };

        default:
          return { type: 'text', text: JSON.stringify(block) };
      }
    });
  }

  private mapStopReason(
    reason?: string
  ): 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled' | undefined {
    if (!reason) return undefined;
    switch (reason) {
      case 'end_turn':
        return 'end_turn';
      case 'tool_use':
        return 'tool_use';
      case 'max_tokens':
        return 'max_tokens';
      case 'stop_sequence':
        return 'end_turn';
      default:
        return undefined;
    }
  }
}
