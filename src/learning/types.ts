/** Shared logger interface for learning modules */
export type LearningLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export const defaultLogger: LearningLogger = {
  info: (...args: unknown[]) => console.log('[learning]', ...args),
  warn: (...args: unknown[]) => console.warn('[learning]', ...args),
  error: (...args: unknown[]) => console.error('[learning]', ...args),
};
