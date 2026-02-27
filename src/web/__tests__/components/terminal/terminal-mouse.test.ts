// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  domButtonToSgr,
  modifierFlags,
  encodeSgrMouse,
  pixelToCell,
  motionButtonCode,
  setupMouseBridge,
} from '../../../components/terminal/terminal-mouse';

// =============================================================================
// Pure Function Tests
// =============================================================================

describe('domButtonToSgr', () => {
  it('maps left button (0) to SGR 0', () => {
    expect(domButtonToSgr(0)).toBe(0);
  });

  it('maps middle button (1) to SGR 1', () => {
    expect(domButtonToSgr(1)).toBe(1);
  });

  it('maps right button (2) to SGR 2', () => {
    expect(domButtonToSgr(2)).toBe(2);
  });

  it('defaults unknown buttons to 0', () => {
    expect(domButtonToSgr(3)).toBe(0);
    expect(domButtonToSgr(99)).toBe(0);
  });
});

describe('modifierFlags', () => {
  it('returns 0 with no modifiers', () => {
    expect(modifierFlags(false, false, false)).toBe(0);
  });

  it('returns 4 for shift', () => {
    expect(modifierFlags(true, false, false)).toBe(4);
  });

  it('returns 8 for alt', () => {
    expect(modifierFlags(false, true, false)).toBe(8);
  });

  it('returns 16 for ctrl', () => {
    expect(modifierFlags(false, false, true)).toBe(16);
  });

  it('combines multiple modifiers', () => {
    // shift + ctrl = 4 + 16 = 20
    expect(modifierFlags(true, false, true)).toBe(20);
    // all three = 4 + 8 + 16 = 28
    expect(modifierFlags(true, true, true)).toBe(28);
  });
});

describe('encodeSgrMouse', () => {
  it('encodes left press at (1,1)', () => {
    expect(encodeSgrMouse(0, 1, 1, false)).toBe('\x1b[<0;1;1M');
  });

  it('encodes left release at (1,1)', () => {
    expect(encodeSgrMouse(0, 1, 1, true)).toBe('\x1b[<0;1;1m');
  });

  it('encodes right press at (80,24)', () => {
    expect(encodeSgrMouse(2, 80, 24, false)).toBe('\x1b[<2;80;24M');
  });

  it('encodes middle release at (40,12)', () => {
    expect(encodeSgrMouse(1, 40, 12, true)).toBe('\x1b[<1;40;12m');
  });

  it('encodes press with shift modifier', () => {
    // left button (0) + shift (4) = 4
    expect(encodeSgrMouse(4, 10, 5, false)).toBe('\x1b[<4;10;5M');
  });

  it('encodes press with ctrl modifier', () => {
    // left button (0) + ctrl (16) = 16
    expect(encodeSgrMouse(16, 10, 5, false)).toBe('\x1b[<16;10;5M');
  });

  it('encodes motion event', () => {
    // motion (32) + left button (0) = 32
    expect(encodeSgrMouse(32, 50, 10, false)).toBe('\x1b[<32;50;10M');
  });

  it('encodes scroll up', () => {
    // scroll up = 64
    expect(encodeSgrMouse(64, 5, 5, false)).toBe('\x1b[<64;5;5M');
  });

  it('encodes scroll down', () => {
    // scroll down = 65
    expect(encodeSgrMouse(65, 5, 5, false)).toBe('\x1b[<65;5;5M');
  });

  it('handles large coordinates (SGR advantage over X10)', () => {
    expect(encodeSgrMouse(0, 300, 200, false)).toBe('\x1b[<0;300;200M');
  });
});

describe('pixelToCell', () => {
  const charWidth = 9;
  const charHeight = 15;
  const cols = 80;
  const rows = 24;

  it('converts origin pixel (0,0) to cell (1,1)', () => {
    expect(pixelToCell(0, 0, charWidth, charHeight, cols, rows)).toEqual({ col: 1, row: 1 });
  });

  it('converts pixel in first cell center to (1,1)', () => {
    expect(pixelToCell(4, 7, charWidth, charHeight, cols, rows)).toEqual({ col: 1, row: 1 });
  });

  it('converts pixel at second cell to (2,1)', () => {
    expect(pixelToCell(9, 0, charWidth, charHeight, cols, rows)).toEqual({ col: 2, row: 1 });
  });

  it('converts pixel at second row to (1,2)', () => {
    expect(pixelToCell(0, 15, charWidth, charHeight, cols, rows)).toEqual({ col: 1, row: 2 });
  });

  it('converts mid-terminal pixel correctly', () => {
    // pixel (180, 150) → col = floor(180/9)+1 = 21, row = floor(150/15)+1 = 11
    expect(pixelToCell(180, 150, charWidth, charHeight, cols, rows)).toEqual({ col: 21, row: 11 });
  });

  it('clamps column to max cols', () => {
    // pixel way beyond terminal width
    expect(pixelToCell(9999, 0, charWidth, charHeight, cols, rows)).toEqual({ col: 80, row: 1 });
  });

  it('clamps row to max rows', () => {
    expect(pixelToCell(0, 9999, charWidth, charHeight, cols, rows)).toEqual({ col: 1, row: 24 });
  });

  it('clamps negative coordinates to 1', () => {
    expect(pixelToCell(-10, -10, charWidth, charHeight, cols, rows)).toEqual({ col: 1, row: 1 });
  });

  it('handles bottom-right corner pixel', () => {
    // Last cell: pixel (79*9, 23*15) = (711, 345)
    expect(pixelToCell(711, 345, charWidth, charHeight, cols, rows)).toEqual({ col: 80, row: 24 });
  });
});

describe('motionButtonCode', () => {
  it('returns 32 for left button motion', () => {
    expect(motionButtonCode(1)).toBe(32); // 32 + 0
  });

  it('returns 33 for middle button motion', () => {
    expect(motionButtonCode(2)).toBe(33); // 32 + 1
  });

  it('returns 34 for right button motion', () => {
    expect(motionButtonCode(4)).toBe(34); // 32 + 2
  });

  it('returns 35 for no-button motion (mode 1003)', () => {
    expect(motionButtonCode(0)).toBe(35); // 32 + 3
  });

  it('prioritizes left when multiple buttons down', () => {
    expect(motionButtonCode(3)).toBe(32); // left+middle → left wins
    expect(motionButtonCode(5)).toBe(32); // left+right → left wins
  });

  it('prioritizes middle over right', () => {
    expect(motionButtonCode(6)).toBe(33); // middle+right → middle wins
  });
});

// =============================================================================
// setupMouseBridge Integration Tests
// =============================================================================

describe('setupMouseBridge', () => {
  function createMockTerminal(options: {
    hasMouseTracking?: boolean;
    modes?: Record<number, boolean>;
    charWidth?: number;
    charHeight?: number;
    cols?: number;
    rows?: number;
  } = {}) {
    const {
      hasMouseTracking = true,
      modes = { 1000: true, 1002: true, 1003: true, 1006: true },
      charWidth = 9,
      charHeight = 15,
      cols = 80,
      rows = 24,
    } = options;

    const el = document.createElement('div');
    // Give the element a bounding rect
    el.getBoundingClientRect = () => ({
      left: 0, top: 0, right: cols * charWidth, bottom: rows * charHeight,
      width: cols * charWidth, height: rows * charHeight,
      x: 0, y: 0, toJSON: () => {},
    });

    return {
      element: el,
      cols,
      rows,
      renderer: { charWidth, charHeight },
      hasMouseTracking: vi.fn(() => hasMouseTracking),
      getMode: vi.fn((mode: number) => modes[mode] ?? false),
      attachCustomWheelEventHandler: vi.fn(),
    } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  it('returns a cleanup function', () => {
    const term = createMockTerminal();
    const sendToPty = vi.fn();
    const cleanup = setupMouseBridge(term, sendToPty);
    expect(typeof cleanup).toBe('function');
    cleanup();
  });

  it('returns noop cleanup when element is null', () => {
    const term = createMockTerminal();
    term.element = null;
    const sendToPty = vi.fn();
    const cleanup = setupMouseBridge(term, sendToPty);
    expect(typeof cleanup).toBe('function');
    cleanup(); // should not throw
  });

  it('sends SGR press on mousedown when tracking is enabled', () => {
    const term = createMockTerminal();
    const sendToPty = vi.fn();
    const cleanup = setupMouseBridge(term, sendToPty);

    // Simulate mousedown at pixel (45, 30) → col=floor(45/9)+1=6, row=floor(30/15)+1=3
    term.element.dispatchEvent(new MouseEvent('mousedown', {
      clientX: 45, clientY: 30, button: 0, bubbles: true,
    }));

    expect(sendToPty).toHaveBeenCalledWith('\x1b[<0;6;3M');
    cleanup();
  });

  it('sends SGR release on mouseup', () => {
    const term = createMockTerminal();
    const sendToPty = vi.fn();
    const cleanup = setupMouseBridge(term, sendToPty);

    term.element.dispatchEvent(new MouseEvent('mousedown', {
      clientX: 45, clientY: 30, button: 0, bubbles: true,
    }));
    term.element.dispatchEvent(new MouseEvent('mouseup', {
      clientX: 45, clientY: 30, button: 0, bubbles: true,
    }));

    expect(sendToPty).toHaveBeenCalledWith('\x1b[<0;6;3m'); // release uses 'm'
    cleanup();
  });

  it('sends right-click with button code 2', () => {
    const term = createMockTerminal();
    const sendToPty = vi.fn();
    const cleanup = setupMouseBridge(term, sendToPty);

    term.element.dispatchEvent(new MouseEvent('mousedown', {
      clientX: 9, clientY: 15, button: 2, bubbles: true, cancelable: true,
    }));

    expect(sendToPty).toHaveBeenCalledWith('\x1b[<2;2;2M');
    cleanup();
  });

  it('includes modifier flags', () => {
    const term = createMockTerminal();
    const sendToPty = vi.fn();
    const cleanup = setupMouseBridge(term, sendToPty);

    // Left click with ctrl held: button 0 + ctrl 16 = 16
    term.element.dispatchEvent(new MouseEvent('mousedown', {
      clientX: 0, clientY: 0, button: 0, ctrlKey: true, bubbles: true,
    }));

    expect(sendToPty).toHaveBeenCalledWith('\x1b[<16;1;1M');
    cleanup();
  });

  it('does not send events when mouse tracking is disabled', () => {
    const term = createMockTerminal({ hasMouseTracking: false });
    const sendToPty = vi.fn();
    const cleanup = setupMouseBridge(term, sendToPty);

    term.element.dispatchEvent(new MouseEvent('mousedown', {
      clientX: 45, clientY: 30, button: 0, bubbles: true,
    }));

    expect(sendToPty).not.toHaveBeenCalled();
    cleanup();
  });

  it('does not send events when SGR mode is disabled', () => {
    const term = createMockTerminal({ modes: { 1000: true, 1003: true, 1006: false } });
    const sendToPty = vi.fn();
    const cleanup = setupMouseBridge(term, sendToPty);

    term.element.dispatchEvent(new MouseEvent('mousedown', {
      clientX: 45, clientY: 30, button: 0, bubbles: true,
    }));

    expect(sendToPty).not.toHaveBeenCalled();
    cleanup();
  });

  describe('motion events', () => {
    it('sends motion in mode 1003 (any-event) without button', () => {
      const term = createMockTerminal();
      const sendToPty = vi.fn();
      const cleanup = setupMouseBridge(term, sendToPty);

      term.element.dispatchEvent(new MouseEvent('mousemove', {
        clientX: 90, clientY: 60, bubbles: true,
      }));

      // No button down → button code = 32 + 3 = 35
      expect(sendToPty).toHaveBeenCalledWith('\x1b[<35;11;5M');
      cleanup();
    });

    it('sends motion with button in mode 1002', () => {
      const term = createMockTerminal({ modes: { 1000: true, 1002: true, 1003: false, 1006: true } });
      const sendToPty = vi.fn();
      const cleanup = setupMouseBridge(term, sendToPty);

      // First press a button
      term.element.dispatchEvent(new MouseEvent('mousedown', {
        clientX: 45, clientY: 30, button: 0, bubbles: true,
      }));
      sendToPty.mockClear();

      // Now move
      term.element.dispatchEvent(new MouseEvent('mousemove', {
        clientX: 90, clientY: 60, bubbles: true,
      }));

      // Left button down → button code = 32 + 0 = 32
      expect(sendToPty).toHaveBeenCalledWith('\x1b[<32;11;5M');
      cleanup();
    });

    it('ignores motion in mode 1002 when no button pressed', () => {
      const term = createMockTerminal({ modes: { 1000: true, 1002: true, 1003: false, 1006: true } });
      const sendToPty = vi.fn();
      const cleanup = setupMouseBridge(term, sendToPty);

      term.element.dispatchEvent(new MouseEvent('mousemove', {
        clientX: 90, clientY: 60, bubbles: true,
      }));

      expect(sendToPty).not.toHaveBeenCalled();
      cleanup();
    });

    it('ignores motion in mode 1000 (press/release only)', () => {
      const term = createMockTerminal({ modes: { 1000: true, 1002: false, 1003: false, 1006: true } });
      const sendToPty = vi.fn();
      const cleanup = setupMouseBridge(term, sendToPty);

      // Press then move
      term.element.dispatchEvent(new MouseEvent('mousedown', {
        clientX: 0, clientY: 0, button: 0, bubbles: true,
      }));
      sendToPty.mockClear();

      term.element.dispatchEvent(new MouseEvent('mousemove', {
        clientX: 90, clientY: 60, bubbles: true,
      }));

      expect(sendToPty).not.toHaveBeenCalled();
      cleanup();
    });
  });

  describe('wheel events', () => {
    it('registers custom wheel handler on terminal', () => {
      const term = createMockTerminal();
      const sendToPty = vi.fn();
      const cleanup = setupMouseBridge(term, sendToPty);

      expect(term.attachCustomWheelEventHandler).toHaveBeenCalledWith(expect.any(Function));
      cleanup();
    });

    it('clears wheel handler on cleanup', () => {
      const term = createMockTerminal();
      const sendToPty = vi.fn();
      const cleanup = setupMouseBridge(term, sendToPty);

      term.attachCustomWheelEventHandler.mockClear();
      cleanup();

      expect(term.attachCustomWheelEventHandler).toHaveBeenCalledWith(undefined);
    });

    it('sends scroll-up SGR for negative deltaY', () => {
      const term = createMockTerminal();
      const sendToPty = vi.fn();
      setupMouseBridge(term, sendToPty);

      // Get the wheel handler that was registered
      const wheelHandler = term.attachCustomWheelEventHandler.mock.calls[0][0];

      const event = new WheelEvent('wheel', {
        clientX: 45, clientY: 30, deltaY: -33,
      });
      const consumed = wheelHandler(event);

      expect(consumed).toBe(true);
      expect(sendToPty).toHaveBeenCalledWith('\x1b[<64;6;3M'); // 64 = scroll up
    });

    it('sends scroll-down SGR for positive deltaY', () => {
      const term = createMockTerminal();
      const sendToPty = vi.fn();
      setupMouseBridge(term, sendToPty);

      const wheelHandler = term.attachCustomWheelEventHandler.mock.calls[0][0];

      const event = new WheelEvent('wheel', {
        clientX: 45, clientY: 30, deltaY: 33,
      });
      const consumed = wheelHandler(event);

      expect(consumed).toBe(true);
      expect(sendToPty).toHaveBeenCalledWith('\x1b[<65;6;3M'); // 65 = scroll down
    });

    it('sends multiple steps for large deltaY', () => {
      const term = createMockTerminal();
      const sendToPty = vi.fn();
      setupMouseBridge(term, sendToPty);

      const wheelHandler = term.attachCustomWheelEventHandler.mock.calls[0][0];

      // deltaY of 99 → round(99/33)=3 steps
      const event = new WheelEvent('wheel', {
        clientX: 45, clientY: 30, deltaY: 99,
      });
      wheelHandler(event);

      expect(sendToPty).toHaveBeenCalledTimes(3);
    });

    it('caps steps at 5', () => {
      const term = createMockTerminal();
      const sendToPty = vi.fn();
      setupMouseBridge(term, sendToPty);

      const wheelHandler = term.attachCustomWheelEventHandler.mock.calls[0][0];

      // Very large deltaY → should cap at 5
      const event = new WheelEvent('wheel', {
        clientX: 45, clientY: 30, deltaY: 1000,
      });
      wheelHandler(event);

      expect(sendToPty).toHaveBeenCalledTimes(5);
    });

    it('returns false when tracking disabled (lets ghostty-web handle)', () => {
      const term = createMockTerminal({ hasMouseTracking: false });
      const sendToPty = vi.fn();
      setupMouseBridge(term, sendToPty);

      const wheelHandler = term.attachCustomWheelEventHandler.mock.calls[0][0];

      const event = new WheelEvent('wheel', {
        clientX: 45, clientY: 30, deltaY: -33,
      });
      const consumed = wheelHandler(event);

      expect(consumed).toBe(false);
      expect(sendToPty).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('removes all event listeners', () => {
      const term = createMockTerminal();
      const sendToPty = vi.fn();
      const cleanup = setupMouseBridge(term, sendToPty);

      cleanup();

      // After cleanup, events should not trigger sends
      term.element.dispatchEvent(new MouseEvent('mousedown', {
        clientX: 45, clientY: 30, button: 0, bubbles: true,
      }));

      expect(sendToPty).not.toHaveBeenCalled();
    });
  });
});
