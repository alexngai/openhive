/**
 * Terminal Query Response Injection
 *
 * ghostty-web (WASM) only responds to \x1b[6n (DSR cursor position).
 * Many TUI frameworks (Bubble Tea, libvaxis, etc.) send capability queries
 * (DECRQM, XTVERSION, pixel size, kitty keyboard) and block until they get
 * responses. We intercept PTY output and inject the missing responses.
 */

const DECRQM_RE = /\x1b\[\?(\d+)\$p/g;       // \x1b[?N$p → respond \x1b[?N;{status}$y
const XTVERSION_RE = /\x1b\[>0q/g;            // \x1b[>0q  → respond with version string
const PIXEL_SIZE_RE = /\x1b\[14t/g;           // \x1b[14t  → respond with pixel size
const KITTY_KB_RE = /\x1b\[\?u/g;             // \x1b[?u   → respond with flags=0
const DA1_RE = /\x1b\[c/g;                    // \x1b[c    → DA1 device attributes
const KITTY_GFX_RE = /\x1b_G[^\x1b]*\x1b\\/g; // \x1b_G...ST → Kitty graphics query

/** DECRQM modes we report as "set" (status=1) */
export const DECRQM_SET_MODES = new Set([2004, 1049, 1004, 2027, 2026, 1000, 1002, 1003, 1006]);

/**
 * Scan PTY output for terminal queries that ghostty-web won't answer,
 * and return fake responses to send back to the PTY.
 */
export function generateQueryResponses(data: string, cols: number, rows: number): string {
  let responses = '';

  // DECRQM: \x1b[?N$p → \x1b[?N;{1=set|2=reset|0=unknown}$y
  let m: RegExpExecArray | null;
  DECRQM_RE.lastIndex = 0;
  while ((m = DECRQM_RE.exec(data)) !== null) {
    const mode = parseInt(m[1], 10);
    const status = DECRQM_SET_MODES.has(mode) ? 1 : 0;
    responses += `\x1b[?${mode};${status}$y`;
  }

  // XTVERSION: \x1b[>0q → \x1bP>|ghostty-web 0.4.0\x1b\\
  XTVERSION_RE.lastIndex = 0;
  if (XTVERSION_RE.test(data)) {
    responses += `\x1bP>|ghostty-web 0.4.0\x1b\\`;
  }

  // DA1 (Device Attributes): \x1b[c → \x1b[?62;22c (VT220 with ANSI color)
  DA1_RE.lastIndex = 0;
  if (DA1_RE.test(data)) {
    responses += `\x1b[?62;22c`;
  }

  // Text area pixel size: \x1b[14t → \x1b[4;height;widtht
  // Estimate from cell dimensions (fontSize 14 ≈ 8px wide, 17px tall)
  PIXEL_SIZE_RE.lastIndex = 0;
  if (PIXEL_SIZE_RE.test(data)) {
    const pxW = cols * 8;
    const pxH = rows * 17;
    responses += `\x1b[4;${pxH};${pxW}t`;
  }

  // Kitty keyboard protocol query: \x1b[?u → \x1b[?0u (flags=0, not supported)
  KITTY_KB_RE.lastIndex = 0;
  if (KITTY_KB_RE.test(data)) {
    responses += `\x1b[?0u`;
  }

  // Kitty graphics query: \x1b_G...ST → respond not supported
  KITTY_GFX_RE.lastIndex = 0;
  if (KITTY_GFX_RE.test(data)) {
    responses += `\x1b_Gi=31337;ENOTSUPPORTED\x1b\\`;
  }

  return responses;
}
