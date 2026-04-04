/**
 * Shared utility functions for SwarmKit config management.
 */

/**
 * Get a value from a nested object using dot-notation key path.
 * e.g., getNestedValue({ a: { b: 1 } }, 'a.b') → 1
 */
export function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Set a value in a nested object using dot-notation key path.
 * Creates intermediate objects as needed.
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  keyPath: string,
  value: unknown,
): void {
  const parts = keyPath.split('.');
  let target = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof target[parts[i]] !== 'object' || target[parts[i]] === null) {
      target[parts[i]] = {};
    }
    target = target[parts[i]] as Record<string, unknown>;
  }
  target[parts[parts.length - 1]] = value;
}

/**
 * Expand dot-notation keys into nested objects.
 * e.g., { "a.b": 1, "a.c": 2 } → { a: { b: 1, c: 2 } }
 */
export function expandDotNotation(flat: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    if (parts.length === 1) {
      result[key] = value;
      continue;
    }

    let target = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof target[parts[i]] !== 'object' || target[parts[i]] === null) {
        target[parts[i]] = {};
      }
      target = target[parts[i]] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = value;
  }

  return result;
}
