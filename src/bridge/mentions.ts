/**
 * Bridge Mention Extraction
 *
 * Scans message text for @name patterns and merges with
 * adapter-provided platform-native mentions.
 */

/**
 * Extract @mentions from message text and merge with adapter-provided mentions.
 *
 * - Scans for `@name` patterns (word-boundary delimited, supports hyphens and underscores)
 * - Deduplicates with any adapter-provided mentions
 * - Returns lowercase, deduplicated array of mention names (without the @ prefix)
 * - Does NOT validate against known agent/swarm names
 *
 * @param text - Message text to scan
 * @param adapterMentions - Optional pre-resolved mentions from the platform adapter
 * @returns Deduplicated array of mention names
 */
export function extractMentions(
  text: string,
  adapterMentions?: string[],
): string[] {
  const mentions = new Set<string>();

  // Add adapter-provided mentions (already resolved to display names)
  if (adapterMentions) {
    for (const mention of adapterMentions) {
      mentions.add(mention.toLowerCase());
    }
  }

  // Extract @name patterns from text
  // Matches @word where word can contain letters, numbers, hyphens, underscores
  const pattern = /(?:^|(?<=\s))@([\w-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    mentions.add(match[1].toLowerCase());
  }

  return Array.from(mentions);
}
