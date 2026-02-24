import { describe, it, expect } from 'vitest';
import { extractMentions } from '../../bridge/mentions.js';

describe('Bridge Mention Extraction', () => {
  it('extracts @mentions from text', () => {
    const result = extractMentions('@infra-swarm check worker-3');
    expect(result).toEqual(['infra-swarm']);
  });

  it('extracts multiple mentions', () => {
    const result = extractMentions('@infra-swarm @research-bot please investigate');
    expect(result).toContain('infra-swarm');
    expect(result).toContain('research-bot');
    expect(result).toHaveLength(2);
  });

  it('handles mentions mid-sentence', () => {
    const result = extractMentions('hey @infra-swarm can you check this?');
    expect(result).toEqual(['infra-swarm']);
  });

  it('handles underscores in names', () => {
    const result = extractMentions('@my_swarm do something');
    expect(result).toEqual(['my_swarm']);
  });

  it('normalizes to lowercase', () => {
    const result = extractMentions('@InfraSwarm check this');
    expect(result).toEqual(['infraswarm']);
  });

  it('deduplicates text mentions', () => {
    const result = extractMentions('@swarm do this @swarm and that');
    expect(result).toEqual(['swarm']);
  });

  it('merges with adapter-provided mentions', () => {
    const result = extractMentions(
      'check worker-3',
      ['infra-swarm'],
    );
    expect(result).toEqual(['infra-swarm']);
  });

  it('deduplicates text mentions with adapter mentions', () => {
    const result = extractMentions(
      '@infra-swarm check worker-3',
      ['infra-swarm'],
    );
    expect(result).toEqual(['infra-swarm']);
  });

  it('combines text and adapter mentions', () => {
    const result = extractMentions(
      '@research-bot look into this',
      ['infra-swarm'],
    );
    expect(result).toContain('infra-swarm');
    expect(result).toContain('research-bot');
    expect(result).toHaveLength(2);
  });

  it('returns empty array for no mentions', () => {
    const result = extractMentions('just a regular message');
    expect(result).toEqual([]);
  });

  it('does not match email addresses as mentions', () => {
    const result = extractMentions('send to user@example.com');
    // user@example.com should not be extracted — @ is not at a word boundary start
    expect(result).toEqual([]);
  });

  it('handles empty text', () => {
    const result = extractMentions('');
    expect(result).toEqual([]);
  });

  it('handles mention at start of text', () => {
    const result = extractMentions('@swarm-alpha hello');
    expect(result).toEqual(['swarm-alpha']);
  });
});
