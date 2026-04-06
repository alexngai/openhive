import { describe, it, expect } from 'vitest';
import { getNestedValue, setNestedValue, expandDotNotation } from '../../swarmkit/utils.js';

describe('swarmkit/utils', () => {
  describe('getNestedValue', () => {
    it('should get a top-level value', () => {
      expect(getNestedValue({ a: 1 }, 'a')).toBe(1);
    });

    it('should get a nested value', () => {
      expect(getNestedValue({ a: { b: { c: 3 } } }, 'a.b.c')).toBe(3);
    });

    it('should return undefined for missing keys', () => {
      expect(getNestedValue({ a: 1 }, 'b')).toBeUndefined();
    });

    it('should return undefined for missing nested keys', () => {
      expect(getNestedValue({ a: { b: 1 } }, 'a.c')).toBeUndefined();
    });

    it('should return undefined when traversing through a primitive', () => {
      expect(getNestedValue({ a: 'string' }, 'a.b')).toBeUndefined();
    });

    it('should return undefined for null intermediate', () => {
      expect(getNestedValue({ a: null } as Record<string, unknown>, 'a.b')).toBeUndefined();
    });

    it('should handle boolean and number values', () => {
      expect(getNestedValue({ a: { enabled: false } }, 'a.enabled')).toBe(false);
      expect(getNestedValue({ a: { count: 0 } }, 'a.count')).toBe(0);
    });
  });

  describe('setNestedValue', () => {
    it('should set a top-level value', () => {
      const obj: Record<string, unknown> = { a: 1 };
      setNestedValue(obj, 'b', 2);
      expect(obj).toEqual({ a: 1, b: 2 });
    });

    it('should set a nested value', () => {
      const obj: Record<string, unknown> = { a: { b: 1 } };
      setNestedValue(obj, 'a.b', 2);
      expect(obj).toEqual({ a: { b: 2 } });
    });

    it('should create intermediate objects', () => {
      const obj: Record<string, unknown> = {};
      setNestedValue(obj, 'a.b.c', 3);
      expect(obj).toEqual({ a: { b: { c: 3 } } });
    });

    it('should overwrite primitive intermediate with object', () => {
      const obj: Record<string, unknown> = { a: 'string' };
      setNestedValue(obj, 'a.b', 1);
      expect(obj).toEqual({ a: { b: 1 } });
    });
  });

  describe('expandDotNotation', () => {
    it('should pass through flat keys unchanged', () => {
      expect(expandDotNotation({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    });

    it('should expand dotted keys into nested objects', () => {
      expect(expandDotNotation({ 'a.b': 1 })).toEqual({ a: { b: 1 } });
    });

    it('should expand deeply nested keys', () => {
      expect(expandDotNotation({ 'a.b.c': 1 })).toEqual({ a: { b: { c: 1 } } });
    });

    it('should merge sibling dotted keys', () => {
      expect(expandDotNotation({ 'a.b': 1, 'a.c': 2 })).toEqual({
        a: { b: 1, c: 2 },
      });
    });

    it('should handle mix of flat and dotted keys', () => {
      expect(expandDotNotation({ x: 10, 'a.b': 1 })).toEqual({
        x: 10,
        a: { b: 1 },
      });
    });
  });
});
