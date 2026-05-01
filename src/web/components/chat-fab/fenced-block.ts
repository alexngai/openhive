/**
 * Fenced-block formatting helper for context injection.
 *
 * Produces `<tag attrs...>\nbody\n</tag>` with HTML-attribute-escaped attr
 * values. See §4.5 / §10.D in docs/CHAT_CONTEXT_INJECTION_DESIGN.md.
 */

const ATTR_ESCAPES: Record<string, string> = {
  '"': '&quot;',
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

export function escapeAttr(value: string): string {
  return value
    .replace(/["&<>]/g, (c) => ATTR_ESCAPES[c]!)
    .replace(/[\x00-\x1f]/g, (c) =>
      `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`,
    );
}

export function fencedBlock(
  tag: string,
  attrs: Record<string, string>,
  body: string,
): string {
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
    .join(' ');
  return `<${tag} ${attrStr}>\n${body}\n</${tag}>`;
}
