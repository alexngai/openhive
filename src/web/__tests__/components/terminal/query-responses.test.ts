import { describe, it, expect } from 'vitest';
import { generateQueryResponses, DECRQM_SET_MODES } from '../../../components/terminal/query-responses';

describe('generateQueryResponses', () => {
  const cols = 80;
  const rows = 24;

  // =========================================================================
  // DECRQM (Request Mode)
  // =========================================================================

  describe('DECRQM', () => {
    it('responds "set" for supported modes', () => {
      // Mode 2004 (bracketed paste) — in DECRQM_SET_MODES
      const result = generateQueryResponses('\x1b[?2004$p', cols, rows);
      expect(result).toBe('\x1b[?2004;1$y');
    });

    it('responds "unknown" for unsupported modes', () => {
      // Mode 47 — not in DECRQM_SET_MODES
      const result = generateQueryResponses('\x1b[?47$p', cols, rows);
      expect(result).toBe('\x1b[?47;0$y');
    });

    it('handles multiple DECRQM queries in one chunk', () => {
      const data = '\x1b[?1000$p\x1b[?1006$p\x1b[?9999$p';
      const result = generateQueryResponses(data, cols, rows);
      expect(result).toBe(
        '\x1b[?1000;1$y' +  // supported
        '\x1b[?1006;1$y' +  // supported
        '\x1b[?9999;0$y',   // unsupported
      );
    });

    it('reports all expected modes as set', () => {
      for (const mode of DECRQM_SET_MODES) {
        const result = generateQueryResponses(`\x1b[?${mode}$p`, cols, rows);
        expect(result).toBe(`\x1b[?${mode};1$y`);
      }
    });
  });

  // =========================================================================
  // XTVERSION
  // =========================================================================

  describe('XTVERSION', () => {
    it('responds with ghostty-web version', () => {
      const result = generateQueryResponses('\x1b[>0q', cols, rows);
      expect(result).toBe('\x1bP>|ghostty-web 0.4.0\x1b\\');
    });
  });

  // =========================================================================
  // DA1 (Device Attributes)
  // =========================================================================

  describe('DA1', () => {
    it('responds with VT220 attributes', () => {
      const result = generateQueryResponses('\x1b[c', cols, rows);
      expect(result).toBe('\x1b[?62;22c');
    });
  });

  // =========================================================================
  // Pixel Size
  // =========================================================================

  describe('Pixel size', () => {
    it('responds with estimated pixel dimensions', () => {
      const result = generateQueryResponses('\x1b[14t', 80, 24);
      // 80*8=640 wide, 24*17=408 tall
      expect(result).toBe('\x1b[4;408;640t');
    });

    it('scales with terminal dimensions', () => {
      const result = generateQueryResponses('\x1b[14t', 120, 40);
      // 120*8=960 wide, 40*17=680 tall
      expect(result).toBe('\x1b[4;680;960t');
    });
  });

  // =========================================================================
  // Kitty Keyboard
  // =========================================================================

  describe('Kitty keyboard', () => {
    it('responds with flags=0 (not supported)', () => {
      const result = generateQueryResponses('\x1b[?u', cols, rows);
      expect(result).toBe('\x1b[?0u');
    });
  });

  // =========================================================================
  // Kitty Graphics
  // =========================================================================

  describe('Kitty graphics', () => {
    it('responds not supported', () => {
      const result = generateQueryResponses('\x1b_Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\', cols, rows);
      expect(result).toBe('\x1b_Gi=31337;ENOTSUPPORTED\x1b\\');
    });
  });

  // =========================================================================
  // Mixed / Edge Cases
  // =========================================================================

  describe('mixed queries', () => {
    it('handles multiple different query types in one chunk', () => {
      const data = '\x1b[?2004$p\x1b[>0q\x1b[c';
      const result = generateQueryResponses(data, cols, rows);
      expect(result).toContain('\x1b[?2004;1$y');     // DECRQM
      expect(result).toContain('\x1bP>|ghostty-web');  // XTVERSION
      expect(result).toContain('\x1b[?62;22c');        // DA1
    });

    it('returns empty string for data with no queries', () => {
      const result = generateQueryResponses('Hello world\r\n', cols, rows);
      expect(result).toBe('');
    });

    it('returns empty string for empty data', () => {
      const result = generateQueryResponses('', cols, rows);
      expect(result).toBe('');
    });

    it('handles queries embedded in other escape sequences', () => {
      const data = '\x1b[H\x1b[2J\x1b[?1000$p\x1b[mSome text';
      const result = generateQueryResponses(data, cols, rows);
      expect(result).toBe('\x1b[?1000;1$y');
    });
  });

  describe('consecutive calls reset regex state', () => {
    it('works correctly across multiple calls', () => {
      // Regex lastIndex must be reset between calls
      const r1 = generateQueryResponses('\x1b[?2004$p', cols, rows);
      const r2 = generateQueryResponses('\x1b[?2004$p', cols, rows);
      expect(r1).toBe(r2);
    });
  });
});
