import { describe, it, expect } from 'vitest';
import {
  ClaudeSessionAdapter,
  CodexSessionAdapter,
  RawSessionAdapter,
  detectFormat,
  detectFormatExtended,
  getAdapter,
  getSupportedFormats,
  quickExtractStats,
  toAcpEvents,
} from '../../sessions/adapters/index.js';

// ============================================================================
// Test Data
// ============================================================================

const CLAUDE_SESSION_CONTENT = `{"type":"user","sessionId":"ses_abc123","timestamp":"2024-01-15T10:00:00Z","uuid":"msg_001","cwd":"/home/user/project","model":"claude-3-opus","message":{"role":"user","content":"Hello, can you help me with a bug?"}}
{"type":"assistant","sessionId":"ses_abc123","timestamp":"2024-01-15T10:00:05Z","uuid":"msg_002","message":{"role":"assistant","content":[{"type":"text","text":"I'd be happy to help! Can you describe the bug?"}],"stop_reason":"end_turn"}}
{"type":"user","sessionId":"ses_abc123","timestamp":"2024-01-15T10:00:30Z","uuid":"msg_003","message":{"role":"user","content":"The function returns null instead of an array"}}
{"type":"assistant","sessionId":"ses_abc123","timestamp":"2024-01-15T10:00:35Z","uuid":"msg_004","message":{"role":"assistant","content":[{"type":"text","text":"Let me check the code."},{"type":"tool_use","id":"tool_001","name":"Read","input":{"file_path":"/src/utils.js"}}],"stop_reason":"tool_use"}}
{"type":"result","sessionId":"ses_abc123","timestamp":"2024-01-15T10:00:36Z","uuid":"msg_005","tool_use_id":"tool_001","result":"function getData() { return null; }","is_error":false}
{"type":"summary","sessionId":"ses_abc123","timestamp":"2024-01-15T10:01:00Z","input_tokens":500,"output_tokens":150,"cost_usd":0.02}`;

const CODEX_SESSION_CONTENT = `{"id":"sess_xyz789","model":"gpt-4","rollout_id":"roll_001","ts":"2024-01-15T10:00:00Z"}
{"event":"turn.started","ts":"2024-01-15T10:00:01Z"}
{"event":"item.user_message","ts":"2024-01-15T10:00:02Z","data":{"id":"msg_001","text":"Fix the authentication bug"}}
{"event":"item.assistant_message","ts":"2024-01-15T10:00:05Z","data":{"id":"msg_002","text":"I'll look at the auth module"}}
{"event":"item.command_execution","ts":"2024-01-15T10:00:10Z","data":{"id":"cmd_001","command":"cat","args":{"path":"auth.js"},"output":"const auth = require('passport');"}}
{"event":"turn.completed","ts":"2024-01-15T10:00:15Z"}`;

const RAW_SESSION_CONTENT = `{"custom_type":"conversation","data":"some data"}
{"custom_type":"response","data":"response data"}
not json line
{"another":"object"}`;

const CLAUDE_WITH_THINKING = `{"type":"user","sessionId":"ses_think","timestamp":"2024-01-15T10:00:00Z","uuid":"msg_001","message":{"role":"user","content":"Explain quantum computing"}}
{"type":"assistant","sessionId":"ses_think","timestamp":"2024-01-15T10:00:05Z","uuid":"msg_002","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Let me think about how to explain this clearly..."},{"type":"text","text":"Quantum computing uses qubits which can be in superposition."}],"stop_reason":"end_turn"}}`;

// ============================================================================
// Claude Adapter Tests
// ============================================================================

describe('ClaudeSessionAdapter', () => {
  const adapter = new ClaudeSessionAdapter();

  describe('detect', () => {
    it('should detect Claude session format', () => {
      expect(adapter.detect(CLAUDE_SESSION_CONTENT)).toBe(true);
    });

    it('should not detect Codex format', () => {
      expect(adapter.detect(CODEX_SESSION_CONTENT)).toBe(false);
    });

    it('should not detect raw format', () => {
      expect(adapter.detect(RAW_SESSION_CONTENT)).toBe(false);
    });

    it('should not detect empty content', () => {
      expect(adapter.detect('')).toBe(false);
    });

    it('should not detect malformed JSON', () => {
      expect(adapter.detect('not json at all')).toBe(false);
    });
  });

  describe('extractIndex', () => {
    it('should extract message count', () => {
      const index = adapter.extractIndex(CLAUDE_SESSION_CONTENT);
      expect(index.messageCount).toBe(4); // 2 user + 2 assistant
    });

    it('should extract tool call count', () => {
      const index = adapter.extractIndex(CLAUDE_SESSION_CONTENT);
      expect(index.toolCallCount).toBe(1);
    });

    it('should extract timestamps', () => {
      const index = adapter.extractIndex(CLAUDE_SESSION_CONTENT);
      expect(index.firstEventAt).toBe('2024-01-15T10:00:00Z');
      expect(index.lastEventAt).toBe('2024-01-15T10:01:00Z');
    });

    it('should extract token usage from summary', () => {
      const index = adapter.extractIndex(CLAUDE_SESSION_CONTENT);
      expect(index.inputTokens).toBe(500);
      expect(index.outputTokens).toBe(150);
    });

    it('should create message previews', () => {
      const index = adapter.extractIndex(CLAUDE_SESSION_CONTENT);
      expect(index.messagesPreview).toBeDefined();
      expect(index.messagesPreview!.length).toBeGreaterThan(0);
      expect(index.messagesPreview![0].type).toBe('user_message');
    });

    it('should create tool calls summary', () => {
      const index = adapter.extractIndex(CLAUDE_SESSION_CONTENT);
      expect(index.toolCallsSummary).toBeDefined();
      expect(index.toolCallsSummary!.length).toBe(1);
      expect(index.toolCallsSummary![0].toolName).toBe('Read');
      expect(index.toolCallsSummary![0].count).toBe(1);
    });
  });

  describe('extractConfig', () => {
    it('should extract working directory', () => {
      const config = adapter.extractConfig?.(CLAUDE_SESSION_CONTENT);
      expect(config?.workingDirectory).toBe('/home/user/project');
    });

    it('should extract model', () => {
      const config = adapter.extractConfig?.(CLAUDE_SESSION_CONTENT);
      expect(config?.model).toBe('claude-3-opus');
    });
  });

  describe('toAcpEvents', () => {
    it('should convert user messages', () => {
      const events = adapter.toAcpEvents(CLAUDE_SESSION_CONTENT);
      const userMessages = events.filter((e) => e.type === 'user_message');
      expect(userMessages.length).toBe(2);
      expect(userMessages[0].content[0]).toEqual({
        type: 'text',
        text: 'Hello, can you help me with a bug?',
      });
    });

    it('should convert assistant messages', () => {
      const events = adapter.toAcpEvents(CLAUDE_SESSION_CONTENT);
      const assistantMessages = events.filter((e) => e.type === 'assistant_message');
      expect(assistantMessages.length).toBe(2);
    });

    it('should convert tool results', () => {
      const events = adapter.toAcpEvents(CLAUDE_SESSION_CONTENT);
      const toolResults = events.filter((e) => e.type === 'tool_result');
      expect(toolResults.length).toBe(1);
      expect(toolResults[0].toolCallId).toBe('tool_001');
      expect(toolResults[0].isError).toBe(false);
    });

    it('should convert tool calls in assistant messages', () => {
      const events = adapter.toAcpEvents(CLAUDE_SESSION_CONTENT);
      const assistantMessages = events.filter((e) => e.type === 'assistant_message');
      const messageWithTool = assistantMessages.find((m) =>
        m.content.some((c) => c.type === 'tool_call')
      );
      expect(messageWithTool).toBeDefined();
    });

    it('should extract thinking blocks', () => {
      const events = adapter.toAcpEvents(CLAUDE_WITH_THINKING);
      const thinkingEvents = events.filter((e) => e.type === 'assistant_thinking');
      expect(thinkingEvents.length).toBe(1);
      expect(thinkingEvents[0].thinking).toContain('Let me think');
    });

    it('should convert token usage summary', () => {
      const events = adapter.toAcpEvents(CLAUDE_SESSION_CONTENT);
      const usageEvents = events.filter((e) => e.type === 'token_usage');
      expect(usageEvents.length).toBe(1);
      expect(usageEvents[0].inputTokens).toBe(500);
      expect(usageEvents[0].outputTokens).toBe(150);
    });

    it('should preserve sequence order', () => {
      const events = adapter.toAcpEvents(CLAUDE_SESSION_CONTENT);
      for (let i = 1; i < events.length; i++) {
        expect(events[i].sequence).toBeGreaterThan(events[i - 1].sequence);
      }
    });
  });

  describe('fromAcpEvents', () => {
    it('should round-trip convert events', () => {
      const originalEvents = adapter.toAcpEvents(CLAUDE_SESSION_CONTENT);
      const converted = adapter.fromAcpEvents!(originalEvents);
      expect(converted).toBeDefined();
      expect(converted.split('\n').length).toBeGreaterThan(0);
    });
  });

  describe('getFormatMetadata', () => {
    it('should return correct metadata', () => {
      const meta = adapter.getFormatMetadata();
      expect(meta.fileExtension).toBe('.jsonl');
      expect(meta.mimeType).toBe('application/x-ndjson');
      expect(meta.supportsStreaming).toBe(true);
    });
  });
});

// ============================================================================
// Codex Adapter Tests
// ============================================================================

describe('CodexSessionAdapter', () => {
  const adapter = new CodexSessionAdapter();

  describe('detect', () => {
    it('should detect Codex session format', () => {
      expect(adapter.detect(CODEX_SESSION_CONTENT)).toBe(true);
    });

    it('should not detect Claude format', () => {
      expect(adapter.detect(CLAUDE_SESSION_CONTENT)).toBe(false);
    });

    it('should detect by rollout_id in header', () => {
      const headerOnly = '{"id":"sess_123","model":"gpt-4","rollout_id":"roll_001"}';
      expect(adapter.detect(headerOnly)).toBe(true);
    });

    it('should detect by event prefix', () => {
      const eventOnly = '{"event":"turn.started","ts":"2024-01-15T10:00:00Z"}';
      expect(adapter.detect(eventOnly)).toBe(true);
    });
  });

  describe('extractIndex', () => {
    it('should extract message count', () => {
      const index = adapter.extractIndex(CODEX_SESSION_CONTENT);
      expect(index.messageCount).toBe(2); // 1 user + 1 assistant
    });

    it('should extract tool call count', () => {
      const index = adapter.extractIndex(CODEX_SESSION_CONTENT);
      expect(index.toolCallCount).toBe(1); // 1 command_execution
    });

    it('should create tool calls summary', () => {
      const index = adapter.extractIndex(CODEX_SESSION_CONTENT);
      expect(index.toolCallsSummary).toBeDefined();
      expect(index.toolCallsSummary!.some((t) => t.toolName === 'cat')).toBe(true);
    });
  });

  describe('extractConfig', () => {
    it('should extract model', () => {
      const config = adapter.extractConfig?.(CODEX_SESSION_CONTENT);
      expect(config?.model).toBe('gpt-4');
    });
  });

  describe('toAcpEvents', () => {
    it('should skip metadata header', () => {
      const events = adapter.toAcpEvents(CODEX_SESSION_CONTENT);
      const customEvents = events.filter(
        (e) => e.type === 'custom' && (e as any).eventType?.includes('rollout')
      );
      expect(customEvents.length).toBe(0);
    });

    it('should convert user messages', () => {
      const events = adapter.toAcpEvents(CODEX_SESSION_CONTENT);
      const userMessages = events.filter((e) => e.type === 'user_message');
      expect(userMessages.length).toBe(1);
      expect(userMessages[0].content[0]).toEqual({
        type: 'text',
        text: 'Fix the authentication bug',
      });
    });

    it('should convert command executions to tool calls', () => {
      const events = adapter.toAcpEvents(CODEX_SESSION_CONTENT);
      const toolCalls = events.filter((e) => e.type === 'tool_call');
      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0].toolName).toBe('cat');
    });

    it('should create tool result for command with output', () => {
      const events = adapter.toAcpEvents(CODEX_SESSION_CONTENT);
      const toolResults = events.filter((e) => e.type === 'tool_result');
      expect(toolResults.length).toBe(1);
    });

    it('should preserve turn events as custom', () => {
      const events = adapter.toAcpEvents(CODEX_SESSION_CONTENT);
      const turnEvents = events.filter(
        (e) => e.type === 'custom' && (e as any).eventType?.includes('turn')
      );
      expect(turnEvents.length).toBe(2); // turn.started and turn.completed
    });
  });
});

// ============================================================================
// Raw Adapter Tests
// ============================================================================

describe('RawSessionAdapter', () => {
  const adapter = new RawSessionAdapter();

  describe('detect', () => {
    it('should always return false (fallback only)', () => {
      expect(adapter.detect(RAW_SESSION_CONTENT)).toBe(false);
      expect(adapter.detect(CLAUDE_SESSION_CONTENT)).toBe(false);
      expect(adapter.detect('anything')).toBe(false);
    });
  });

  describe('extractIndex', () => {
    it('should count lines as potential messages', () => {
      const index = adapter.extractIndex(RAW_SESSION_CONTENT);
      expect(index.messageCount).toBeGreaterThan(0);
    });

    it('should handle mixed JSON and non-JSON content', () => {
      const index = adapter.extractIndex(RAW_SESSION_CONTENT);
      // Should not throw and should return something reasonable
      expect(index).toBeDefined();
    });
  });

  describe('toAcpEvents', () => {
    it('should convert JSON lines to custom events', () => {
      const events = adapter.toAcpEvents(RAW_SESSION_CONTENT);
      const jsonEvents = events.filter(
        (e) => e.type === 'custom' && (e as any).eventType === 'raw_line'
      );
      expect(jsonEvents.length).toBe(3); // 3 valid JSON lines
    });

    it('should convert non-JSON lines to raw_text events', () => {
      const events = adapter.toAcpEvents(RAW_SESSION_CONTENT);
      const textEvents = events.filter(
        (e) => e.type === 'custom' && (e as any).eventType === 'raw_text'
      );
      expect(textEvents.length).toBe(1); // "not json line"
    });

    it('should preserve original data', () => {
      const events = adapter.toAcpEvents(RAW_SESSION_CONTENT);
      const firstEvent = events[0] as any;
      expect(firstEvent._original).toBeDefined();
    });
  });

  describe('fromAcpEvents', () => {
    it('should restore original content from _original', () => {
      const events = adapter.toAcpEvents(RAW_SESSION_CONTENT);
      const restored = adapter.fromAcpEvents!(events);
      expect(restored.split('\n').length).toBe(events.length);
    });
  });
});

// ============================================================================
// Format Detection Tests
// ============================================================================

describe('Format Detection', () => {
  describe('detectFormat', () => {
    it('should detect Claude format', () => {
      const result = detectFormat(CLAUDE_SESSION_CONTENT);
      expect(result).not.toBeNull();
      expect(result!.formatId).toBe('claude_jsonl_v1');
      expect(result!.confidence).toBe('high');
    });

    it('should detect Codex format', () => {
      const result = detectFormat(CODEX_SESSION_CONTENT);
      expect(result).not.toBeNull();
      expect(result!.formatId).toBe('codex_jsonl_v1');
      expect(result!.confidence).toBe('high');
    });

    it('should return null for unknown format', () => {
      const result = detectFormat(RAW_SESSION_CONTENT);
      expect(result).toBeNull();
    });

    it('should return null for empty content', () => {
      const result = detectFormat('');
      expect(result).toBeNull();
    });
  });

  describe('detectFormatExtended', () => {
    it('should fall back to raw for unknown formats', () => {
      const result = detectFormatExtended({
        content: RAW_SESSION_CONTENT,
        sizeBytes: RAW_SESSION_CONTENT.length,
      });
      expect(result.formatId).toBe('raw');
      expect(result.confidence).toBe('low');
    });

    it('should use filename hints', () => {
      const result = detectFormatExtended({
        content: '{}', // Minimal content
        filename: 'session.jsonl',
        sizeBytes: 2,
      });
      // Should still work even with minimal content
      expect(result).toBeDefined();
    });
  });
});

// ============================================================================
// Registry API Tests
// ============================================================================

describe('Adapter Registry', () => {
  describe('getAdapter', () => {
    it('should return Claude adapter', () => {
      const adapter = getAdapter('claude_jsonl_v1');
      expect(adapter).not.toBeNull();
      expect(adapter!.formatId).toBe('claude_jsonl_v1');
    });

    it('should return Codex adapter', () => {
      const adapter = getAdapter('codex_jsonl_v1');
      expect(adapter).not.toBeNull();
      expect(adapter!.formatId).toBe('codex_jsonl_v1');
    });

    it('should return Raw adapter', () => {
      const adapter = getAdapter('raw');
      expect(adapter).not.toBeNull();
      expect(adapter!.formatId).toBe('raw');
    });

    it('should return null for unknown format', () => {
      const adapter = getAdapter('unknown_format');
      expect(adapter).toBeNull();
    });
  });

  describe('getSupportedFormats', () => {
    it('should list all supported formats', () => {
      const formats = getSupportedFormats();
      expect(formats.length).toBeGreaterThanOrEqual(3);
      expect(formats.some((f) => f.id === 'claude_jsonl_v1')).toBe(true);
      expect(formats.some((f) => f.id === 'codex_jsonl_v1')).toBe(true);
      expect(formats.some((f) => f.id === 'raw')).toBe(true);
    });

    it('should mark builtin adapters', () => {
      const formats = getSupportedFormats();
      const claude = formats.find((f) => f.id === 'claude_jsonl_v1');
      expect(claude?.builtin).toBe(true);
    });
  });

  describe('quickExtractStats', () => {
    it('should extract stats with auto-detection', () => {
      const result = quickExtractStats(CLAUDE_SESSION_CONTENT);
      expect(result.formatId).toBe('claude_jsonl_v1');
      expect(result.index.messageCount).toBeGreaterThan(0);
    });

    it('should use specified format', () => {
      const result = quickExtractStats(CLAUDE_SESSION_CONTENT, 'raw');
      expect(result.formatId).toBe('raw');
    });
  });

  describe('toAcpEvents', () => {
    it('should convert with auto-detection', () => {
      const result = toAcpEvents(CLAUDE_SESSION_CONTENT);
      expect(result.formatId).toBe('claude_jsonl_v1');
      expect(result.events.length).toBeGreaterThan(0);
    });

    it('should use specified format', () => {
      const result = toAcpEvents(CLAUDE_SESSION_CONTENT, 'raw');
      expect(result.formatId).toBe('raw');
      // All events should be custom type when using raw
      expect(result.events.every((e) => e.type === 'custom')).toBe(true);
    });
  });
});

// ============================================================================
// Edge Cases and Error Handling
// ============================================================================

describe('Edge Cases', () => {
  const claudeAdapter = new ClaudeSessionAdapter();

  it('should handle empty content gracefully', () => {
    const index = claudeAdapter.extractIndex('');
    expect(index.messageCount).toBe(0);
    expect(index.toolCallCount).toBe(0);
  });

  it('should handle single line content', () => {
    const singleLine = '{"type":"user","sessionId":"ses_1","message":{"role":"user","content":"Hi"}}';
    const index = claudeAdapter.extractIndex(singleLine);
    expect(index.messageCount).toBe(1);
  });

  it('should handle malformed lines gracefully', () => {
    const mixedContent = `{"type":"user","sessionId":"ses_1","message":{"role":"user","content":"Hi"}}
not valid json
{"type":"assistant","sessionId":"ses_1","message":{"role":"assistant","content":"Hello"}}`;

    const index = claudeAdapter.extractIndex(mixedContent);
    expect(index.messageCount).toBe(2); // Should skip the bad line
  });

  it('should handle very long content previews', () => {
    const longMessage = 'x'.repeat(1000);
    const content = `{"type":"user","sessionId":"ses_1","message":{"role":"user","content":"${longMessage}"}}`;
    const index = claudeAdapter.extractIndex(content);

    // Preview should be truncated
    if (index.messagesPreview && index.messagesPreview.length > 0) {
      expect(index.messagesPreview[0].contentPreview.length).toBeLessThanOrEqual(100);
    }
  });

  it('should handle nested content arrays', () => {
    const nestedContent = `{"type":"assistant","sessionId":"ses_1","message":{"role":"assistant","content":[{"type":"text","text":"Part 1"},{"type":"text","text":"Part 2"}]}}`;
    const events = claudeAdapter.toAcpEvents(nestedContent);
    expect(events.length).toBe(1);
    expect(events[0].content.length).toBe(2);
  });
});
