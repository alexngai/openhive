/**
 * Spec context type — registers a single-spec context item.
 *
 * The agent receives a `<context kind="openhive:spec" id="…" resource_id="…">`
 * block carrying the spec title + body. See §10.C of the design doc.
 */

import type { ChatFabContextItem } from '../chat-fab-item';
import { registerContextType } from '../context-registry';
import { fencedBlock } from '../fenced-block';

export interface SpecData {
  id: string;
  resource_id: string;
  title: string;
  content: string;
}

/**
 * React Query shape returned by `useSpec` (`['spec', resourceId, specId]`).
 * We only rely on the nested `spec` object — narrowed locally so the live
 * loader doesn't create a public surface coupling against the hook's
 * export.
 */
interface CachedSpecDetail {
  spec?: {
    id?: string;
    resource_id?: string;
    title?: string;
    content?: string | null;
  };
}

const identity = (d: SpecData): Record<string, string> => ({
  id: d.id,
  resource_id: d.resource_id,
});

function buildAttrs(d: SpecData, stale: boolean): Record<string, string> {
  const attrs: Record<string, string> = {
    kind: 'openhive:spec',
    ...identity(d),
  };
  if (stale) attrs.stale = 'true';
  return attrs;
}

function projectCachedSpec(cached: CachedSpecDetail, fallback: SpecData): SpecData | null {
  const spec = cached.spec;
  if (!spec || !spec.id || !spec.resource_id) return null;
  return {
    id: spec.id,
    resource_id: spec.resource_id,
    title: spec.title ?? fallback.title,
    content: spec.content ?? fallback.content ?? '',
  };
}

registerContextType<SpecData>({
  type: 'spec',
  kind: 'openhive:spec',
  description:
    'A markdown document describing intended work, dispatchable to agent swarms.',
  icon: '📄',
  label: (d) => `Spec: ${d.title}`,
  identity,
  format: (d, flags) =>
    fencedBlock(
      'context',
      buildAttrs(d, Boolean(flags?.stale)),
      `# ${d.title}\n\n${d.content}`,
    ),
  live: async (d, { queryClient, signal }) => {
    // Prefer the in-memory React Query cache — that's the live mirror of
    // what `useSpec(resourceId, specId)` keeps fresh via WS invalidation.
    const cached = queryClient.getQueryData<CachedSpecDetail>([
      'spec',
      d.resource_id,
      d.id,
    ]);
    if (cached) {
      return projectCachedSpec(cached, d);
    }
    // Cache miss — fetch with signal so the 200ms timeout aborts cleanly.
    try {
      const fetched = await queryClient.fetchQuery<CachedSpecDetail>({
        queryKey: ['spec', d.resource_id, d.id],
        signal,
      });
      if (!fetched) return null;
      return projectCachedSpec(fetched, d);
    } catch (err) {
      // fetchQuery rejects with AbortError on signal abort. Surface that
      // to the wrapper by rethrowing — `runLiveWithTimeout` treats abort
      // as "use snapshot" via `controller.signal.aborted` check.
      throw err;
    }
  },
});

export function specContextItem(
  spec: SpecData,
  opts: { primary?: boolean } = {},
): ChatFabContextItem & { type: 'spec'; data: SpecData } {
  return {
    type: 'spec',
    label: `Spec: ${spec.title}`,
    data: spec,
    primary: opts.primary,
  };
}
