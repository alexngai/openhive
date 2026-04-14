import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Cleanup DOM after each test
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Mock matchMedia (used by theme system)
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock IntersectionObserver (used by PostList infinite scroll)
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// jsdom doesn't define WebGL globals. Sigma.js (transitively imported by
// SessionDetail / TaskGraph) references them at module-load time on some
// platforms, throwing ReferenceError before any test runs. Stubbing as a
// noop class is enough to satisfy `instanceof` checks and constructor refs.
class FakeWebGLContext {}
if (typeof (globalThis as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext === 'undefined') {
  (globalThis as { WebGL2RenderingContext: unknown }).WebGL2RenderingContext = FakeWebGLContext;
}
if (typeof (globalThis as { WebGLRenderingContext?: unknown }).WebGLRenderingContext === 'undefined') {
  (globalThis as { WebGLRenderingContext: unknown }).WebGLRenderingContext = FakeWebGLContext;
}
