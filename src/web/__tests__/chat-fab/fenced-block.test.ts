import { describe, it, expect } from 'vitest';
import {
  fencedBlock,
  escapeAttr,
} from '../../components/chat-fab/fenced-block';

describe('fencedBlock', () => {
  it('round-trips tag + attrs + body cleanly', () => {
    const out = fencedBlock(
      'context',
      { kind: 'openhive:spec', id: 'abc' },
      '# Title',
    );
    expect(out).toBe(
      '<context kind="openhive:spec" id="abc">\n# Title\n</context>',
    );
  });

  it('HTML-escapes double quotes in attr values', () => {
    expect(escapeAttr('"bad"')).toBe('&quot;bad&quot;');
  });

  it('escapes ampersand, lt, gt in attr values', () => {
    expect(escapeAttr('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('escapes control characters as \\xNN', () => {
    expect(escapeAttr('\x01')).toBe('\\x01');
    expect(escapeAttr('\x1f')).toBe('\\x1f');
    expect(escapeAttr('\x00')).toBe('\\x00');
  });

  it('emits all attrs with quoted values', () => {
    const out = fencedBlock(
      'context',
      { kind: 'openhive:tasks', count: '3' },
      '- task',
    );
    expect(out.startsWith('<context kind="openhive:tasks" count="3">')).toBe(
      true,
    );
    expect(out.endsWith('</context>')).toBe(true);
  });
});
