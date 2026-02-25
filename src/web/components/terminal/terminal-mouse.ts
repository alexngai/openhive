/**
 * Terminal Mouse Event Bridge
 *
 * ghostty-web doesn't convert DOM mouse events to terminal escape sequences.
 * When the TUI enables mouse tracking (modes 1000/1002/1003 + 1006), we
 * intercept mouse events on the terminal element and emit SGR mouse escape
 * sequences (\x1b[<Cb;Cx;CyM/m) to the PTY via the WebSocket.
 */

import type { Terminal } from 'ghostty-web';

// =============================================================================
// SGR Mouse Encoding (Pure Functions)
// =============================================================================

/** Map DOM button number (0=left, 1=middle, 2=right) to SGR button code */
export function domButtonToSgr(button: number): number {
  switch (button) {
    case 0: return 0; // left
    case 1: return 1; // middle
    case 2: return 2; // right
    default: return 0;
  }
}

/** Build modifier flags from shift/alt/ctrl state */
export function modifierFlags(shift: boolean, alt: boolean, ctrl: boolean): number {
  let flags = 0;
  if (shift) flags |= 4;
  if (alt) flags |= 8;
  if (ctrl) flags |= 16;
  return flags;
}

/**
 * Encode an SGR mouse sequence.
 * @param cb   Combined button + modifier flags
 * @param col  1-based column
 * @param row  1-based row
 * @param release  true for button release, false for press/motion
 * @returns SGR escape sequence string
 */
export function encodeSgrMouse(cb: number, col: number, row: number, release: boolean): string {
  return `\x1b[<${cb};${col};${row}${release ? 'm' : 'M'}`;
}

/**
 * Convert pixel coordinates to 1-based terminal cell coordinates.
 * Returns null if charWidth/charHeight are not available.
 */
export function pixelToCell(
  x: number,
  y: number,
  charWidth: number,
  charHeight: number,
  cols: number,
  rows: number,
): { col: number; row: number } {
  const col = Math.floor(x / charWidth) + 1;
  const row = Math.floor(y / charHeight) + 1;
  return {
    col: Math.max(1, Math.min(col, cols)),
    row: Math.max(1, Math.min(row, rows)),
  };
}

/**
 * Build the SGR button code for a motion event.
 * Motion events add 32 to the base button code.
 * @param buttonsDown  Bitmask of currently pressed buttons (1=left, 2=middle, 4=right)
 */
export function motionButtonCode(buttonsDown: number): number {
  let btn = 32; // motion flag
  if (buttonsDown & 1) btn += 0;       // left
  else if (buttonsDown & 2) btn += 1;  // middle
  else if (buttonsDown & 4) btn += 2;  // right
  else btn += 3;                        // no button (mode 1003)
  return btn;
}

// =============================================================================
// Mouse Bridge Setup
// =============================================================================

/**
 * Attach mouse event handlers to a ghostty-web Terminal instance.
 * Returns a cleanup function that removes all listeners.
 */
export function setupMouseBridge(
  term: Terminal,
  sendToPty: (data: string) => void,
): () => void {
  const el = term.element;
  if (!el) return () => {};

  // Track which mouse buttons are currently pressed (for motion reporting)
  let buttonsDown = 0; // bitmask: 1=left, 2=middle, 4=right

  /** Check if the TUI has requested mouse tracking */
  function isMouseTracking(): boolean {
    return term.hasMouseTracking();
  }

  /** Check if SGR encoding (mode 1006) is active */
  function isSgrMode(): boolean {
    return term.getMode(1006);
  }

  /** Check which tracking mode is active */
  function getTrackingMode(): 0 | 1000 | 1002 | 1003 {
    if (term.getMode(1003)) return 1003; // any-event
    if (term.getMode(1002)) return 1002; // button-event
    if (term.getMode(1000)) return 1000; // normal (press+release)
    return 0;
  }

  /** Convert a DOM mouse event to terminal cell coordinates (1-based) */
  function eventToCell(e: MouseEvent): { col: number; row: number } | null {
    const renderer = term.renderer;
    if (!renderer) return null;

    const rect = el!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    return pixelToCell(x, y, renderer.charWidth, renderer.charHeight, term.cols, term.rows);
  }

  /** Build modifier flags from a MouseEvent */
  function eventModifiers(e: MouseEvent): number {
    return modifierFlags(e.shiftKey, e.altKey, e.ctrlKey);
  }

  // --- Event handlers ---

  function onMouseDown(e: MouseEvent): void {
    if (!isMouseTracking()) return;
    const cell = eventToCell(e);
    if (!cell) return;

    const btn = domButtonToSgr(e.button);
    buttonsDown |= (1 << e.button);

    if (isSgrMode()) {
      sendToPty(encodeSgrMouse(btn + eventModifiers(e), cell.col, cell.row, false));
    }

    // Prevent context menu and text selection when mouse tracking is on
    if (e.button === 2) e.preventDefault();
  }

  function onMouseUp(e: MouseEvent): void {
    if (!isMouseTracking()) return;
    const cell = eventToCell(e);
    if (!cell) return;

    const btn = domButtonToSgr(e.button);
    buttonsDown &= ~(1 << e.button);

    if (isSgrMode()) {
      sendToPty(encodeSgrMouse(btn + eventModifiers(e), cell.col, cell.row, true));
    }
  }

  function onMouseMove(e: MouseEvent): void {
    if (!isMouseTracking()) return;

    const mode = getTrackingMode();
    // Mode 1003: report all motion; Mode 1002: only when button pressed
    if (mode < 1002) return;
    if (mode === 1002 && buttonsDown === 0) return;

    const cell = eventToCell(e);
    if (!cell) return;

    const btn = motionButtonCode(buttonsDown);

    if (isSgrMode()) {
      sendToPty(encodeSgrMouse(btn + eventModifiers(e), cell.col, cell.row, false));
    }
  }

  function onContextMenu(e: Event): void {
    // Suppress right-click menu when mouse tracking is on
    if (isMouseTracking()) e.preventDefault();
  }

  // Custom wheel handler: intercept scroll when mouse tracking is active.
  // Return true = we handled it (suppress ghostty-web's arrow-key fallback).
  // Return false = let ghostty-web handle normally.
  function wheelHandler(e: WheelEvent): boolean {
    if (!isMouseTracking() || !isSgrMode()) return false;

    const cell = eventToCell(e);
    if (!cell) return false;

    const btn = e.deltaY < 0 ? 64 : 65; // 64=scroll up, 65=scroll down
    const steps = Math.max(1, Math.min(Math.abs(Math.round(e.deltaY / 33)), 5));

    for (let i = 0; i < steps; i++) {
      sendToPty(encodeSgrMouse(btn + eventModifiers(e), cell.col, cell.row, false));
    }

    return true; // consumed
  }

  // Attach listeners
  el.addEventListener('mousedown', onMouseDown);
  el.addEventListener('mouseup', onMouseUp);
  el.addEventListener('mousemove', onMouseMove);
  el.addEventListener('contextmenu', onContextMenu);
  term.attachCustomWheelEventHandler(wheelHandler);

  // Cleanup
  return () => {
    el.removeEventListener('mousedown', onMouseDown);
    el.removeEventListener('mouseup', onMouseUp);
    el.removeEventListener('mousemove', onMouseMove);
    el.removeEventListener('contextmenu', onContextMenu);
    term.attachCustomWheelEventHandler(undefined);
  };
}
