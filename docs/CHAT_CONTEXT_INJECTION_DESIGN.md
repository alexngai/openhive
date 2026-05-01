# Chat Context Injection — Design Doc

> **Status**: Draft (v0.3, 2026-04-21). Open questions resolved. Incorporates critic review feedback.
> **Owner**: Platform / Web
> **Related**: `src/web/components/chat-fab/*`, `docs/design/spec-to-swarm.md`
> **Changelog**:
> - v0.3 (2026-04-21): Folded in critic review (Layout gap correction, AbortSignal, store separation, feature gate, acceptance criteria) and second-round user decisions (identity reframed as agent-action requirement, `kind` attr, chip-during-stream semantics, tab-local chips, no telemetry, mouse-only v1).
> - v0.2 (2026-04-21): First round of decisions folded in.
> - v0.1 (2026-04-21): Initial draft.

## 1. Problem

Users converse with agents through the ChatFab (floating or docked panel) while
navigating the OpenHive UI — viewing specs, dispatches, streams, tasks, and so
on. The agent does not know what the user is looking at. Today the only bridge
is a one-way "Add context" menu on SpecDetail and DispatchDetail that dumps a
markdown snapshot into the composer.

Three practical problems:

1. **Every new page re-invents context wiring.** Adding support to
   TaskDetail, CascadeStreamDetail, SessionDetail, SwarmDetail, etc. means
   editing a closed union in `ChatFabContext.tsx`, extending a switch in
   `ContextFormatter.tsx`, and bespoke per-page item construction. Pages
   drift — DispatchDetail exposes only the dispatch (no source spec, no
   linked tasks), while SpecDetail exposes both.
2. **Snapshots are stale.** `chatFabItems` is built at render time; the
   formatted markdown is generated at inject time but pulls from data
   captured at provider mount. Ten minutes of typing and the injected spec
   is ten minutes old.
3. **The agent cannot structurally distinguish injected context from user
   prose.** Everything becomes one user turn prefixed with
   `📄 **Shared context — …**`. Agents have no reliable hook to treat
   context as context, and no consistent identifier to reference or act on
   (update, query) the entity.
4. **The existing mechanism has a wiring gap.** See §2.1 — the provider
   today is mounted inside the page tree but `ChatFab` renders as a Layout
   sibling, so the floating-FAB context menu reads the default empty items
   array. The feature works on the docked sidebar path only if (and when)
   a page wraps it, and even there the shared provider assumption doesn't
   hold.

This doc proposes a page-aware, registry-based context injection mechanism
that generalizes the SpecDetail pattern across the app and fixes the
wiring gap.

## 2. What exists today

### 2.1 Pieces in place

| File | Role |
|---|---|
| `src/web/components/chat-fab/ChatFabContext.tsx` | React context provider; `ChatFabContextItem` type (closed union of 8 types); `useChatFabContext()` |
| `src/web/components/chat-fab/ContextFormatter.tsx` | Switch on `item.type` producing the markdown string injected into the chat composer |
| `src/web/components/chat-fab/ContextMenu.tsx` | Dropdown in the chat composer rendering the list of items from the provider |
| `src/web/components/chat-fab/ChatPanel.tsx` | Wires the "Add context" button → `ContextMenu` → composer insertion via `channel.send()` |
| `src/web/components/layout/Layout.tsx` | Renders `<ChatSidebar />` and `<ChatFab />` as **siblings** to `<Outlet />` |

**Wiring gap (verified at HEAD, 2026-04-21).** `ChatFabContextProvider` is
mounted inside individual page components (`SpecDetail.tsx:231`,
`DispatchDetail.tsx:98`) that render inside `<Outlet />`. But
`ChatFab` / `ChatSidebar` — which contain the `ContextMenu` consumer —
render in `Layout.tsx:37-39` as siblings to `<Outlet />`, outside the
provider. The consumer therefore reads the **default** context value
`{ items: [] }` and `ContextMenu.tsx` short-circuits to `return null`.

Upshot: the "Add context" menu on today's floating FAB never shows page
items, and the sidebar path works only by accident of where it's mounted.
Fixing this is a prerequisite for the rest of the design — the proposed
registry is the fix.

### 2.2 Pages wired up

| Page | Provider usage | Items exposed |
|---|---|---|
| `SpecDetail.tsx` | wraps page body | Spec (title + full content); linked tasks (when present) |
| `DispatchDetail.tsx` | wraps page body | Dispatch (id, spec_id, status, target_swarm_id) only |
| All other detail pages | not wrapped | — |

### 2.3 Formatter coverage

The formatter already has branches for `spec`, `tasks`, `task`, `dispatch`,
`swarm`, `session`, plus a `default` that dumps `data` as bullet key-value
pairs. So the type surface is structurally present — it just is not reached
because (a) no pages construct most of those items, and (b) the union in
`ChatFabContext.tsx` is closed, and (c) the provider/consumer disconnect
above would make it unreachable even if they did.

### 2.4 Injection transport

User clicks a menu item → `formatContextItem(item)` returns a markdown string
→ the string is inserted into the composer → sent as a normal user turn via
`channel.send()` → arrives at the agent as part of the ACP session. There is
no side-channel and no distinguished message metadata.

## 3. Goals and non-goals

### Goals

- Any detail page can declare its on-screen entities as context in one line.
- Adding a new context type does not require editing the chat-fab core.
- The currently-viewed entity is pre-pinned and visually distinct.
- Injected context reflects the entity's state at the moment of injection,
  not at provider mount.
- Agents receive a consistent, parseable structure so context is
  distinguishable from user prose, AND enough identity metadata to act on
  the entity (update, query, reference in tool calls).
- Users can preview what will be sent before it lands in the composer.

### Non-goals (for this iteration)

- Bi-directional editing (agent proposing spec edits that land back in
  Tiptap). That is a separate "structured proposal" design, which will build
  on this one.
- Long-term memory of previously-injected context across sessions.
- Agent-initiated context pulls (agent asking the hub for "the current
  spec"). We keep the user in the loop.
- A new transport. Context still rides as a user turn in the existing ACP
  session.
- Telemetry / analytics on injection events. This is a context-management
  feature, not a measured-adoption feature.
- Token-count estimation in the preview. Deferred.
- Mobile layout tuning. Desktop flow only.
- Keyboard-only hover preview affordances. Mouse-first; a11y is a
  follow-up.

### 3.1 Acceptance criteria

Concrete checks that gate v1:

1. **Registry integrity.** Every registered context type has a unit test
   asserting: (a) `identity(data).id` is non-empty and stable for the same
   input; (b) `format(data)` output contains each of `identity(data)`'s
   attrs; (c) `format(data)` round-trips through the `fencedBlock` parser
   defined in `context-registry.ts`.
2. **Menu surfacing.** Given a page has called `usePageContext`, opening
   the chat composer and clicking "Add context" shows all registered items
   for that page, with the `primary` item at the top. Covered by a React
   Testing Library test on SpecDetail.
3. **Fenced-block format.** Every `format()` output matches the regex
   `^<context kind="[a-z]+:[a-z]+"( [a-z_]+="[^"]*")+>[\s\S]*</context>$`
   exactly (identity attrs, no `type` attr, no unquoted attrs).
4. **Live refresh bounded.** Under a simulated 500ms `fetchQuery` delay,
   the injection completes within 250ms using the staged snapshot. Covered
   by a timing test.
5. **AbortSignal honored.** When the `live` timeout fires, the signal is
   aborted and a subsequent `await fetchQuery(..., { signal })` in the
   resolver rejects with `AbortError`. Covered by a unit test.
6. **Primary uniqueness.** Two pages registering concurrently (simulated
   route transition) with `primary: true` items result in exactly one
   primary in `PageContextStore`, last-write-wins, with a dev-mode warning
   logged.
7. **Chip persistence.** Staged chip survives a route navigation; staged
   chip is *not* visible in a second browser tab of the same ACP session.
8. **Layout-gap fix.** A rendered `<ChatFab />` shows the registered items
   of the active page — covered by an integration test mounting `Layout`
   with a page that calls `usePageContext`.

## 4. Proposed design

Three layers, each independently useful:

1. A **registry** of context types with icon, label, format, and optional
   live loader.
2. A **`usePageContext()` hook + module-level `PageContextStore`** that
   pages call to declare their items. (Replaces the broken React-Context
   path in §2.1.)
3. **UX enhancements**: chip-based staging with hover preview, primary
   pinned item, and a self-describing fenced-block convention.

### 4.1 Registry of context types

```ts
// src/web/components/chat-fab/context-registry.ts

export interface ContextTypeSpec<T = unknown> {
  /** Short key used in UI/registry lookups, e.g. 'spec'. */
  type: string;

  /**
   * Qualified kind emitted on fenced blocks, e.g. 'openhive:spec'.
   * Self-describes the entity type so agents reading a turn in isolation
   * (e.g. from history replay, across hubs) know what it is without
   * external vocabulary.
   */
  kind: string;

  /**
   * Short human description. Used in hover preview and reserved for a
   * future capability advertisement channel (see §4.7).
   */
  description: string;

  /** Emoji or icon token shown in the menu. */
  icon: string;

  /** Human label, e.g. (data) => `Spec: ${data.title}`. */
  label: (data: T) => string;

  /** Produces the markdown body injected into the chat turn. */
  format: (data: T) => string;

  /**
   * Identifying attributes emitted on the fenced block. Always includes
   * at least `{ id }`. Agents use these to *act* on the entity: updating
   * a spec, querying task state, referencing in tool calls. Required in
   * v1, not forward-compat noise.
   */
  identity: (data: T) => Record<string, string>;

  /**
   * Optional: re-fetch live data at inject time (not at provider time).
   * Runs with a 200ms soft timeout. The signal is aborted when the
   * timeout fires; honor it by passing { signal } to fetchQuery.
   *
   * Returning null means "use the snapshot". If the settled value
   * arrives after signal.aborted, it is discarded.
   */
  live?: (
    data: T,
    ctx: { queryClient: QueryClient; signal: AbortSignal },
  ) => Promise<T | null> | T | null;
}

export function registerContextType<T>(spec: ContextTypeSpec<T>): void;
export function getContextType(type: string): ContextTypeSpec | undefined;
export function listContextTypes(): ContextTypeSpec[];
```

Built-in registrations live in `src/web/components/chat-fab/context-types/`
(one file per type). An `index.ts` re-exports them so a single import
triggers registration.

**HMR idempotency.** The registry is a module-level `Map`. On Vite HMR,
`registerContextType` overwrites existing entries instead of throwing:
`registry.set(spec.type, spec)` rather than `.has() → throw`. A dev-only
assertion catches duplicates at fresh module load time.

**Type safety at call sites.** `item.type` is typed as `string` in the
open shape, but pages import item constructors (§4.2) whose return types
discriminate on the exact literal. The registry itself is internally typed
as `Map<string, ContextTypeSpec<unknown>>`; consumers read through
`getContextType` which returns a widely-typed `ContextTypeSpec` — the
format/identity invariants are enforced at registration, not call site.

### 4.2 Per-page registration via hook + module-level store

**The Layout gap from §2.1 means React Context is the wrong primitive here.**
Producer (pages, inside `<Outlet />`) and consumer (`ChatFab`, Layout
sibling) live in disjoint subtrees. Using React Context requires lifting
the provider to Layout, which means Layout has to know about the item
schema — and we already have a registry for that.

Instead: a **module-level store** holds the current page's items.

```ts
// src/web/components/chat-fab/page-context-store.ts
import { create } from 'zustand';

interface PageContextState {
  items: ChatFabContextItem[];
  setItems(items: ChatFabContextItem[]): void;
  clear(): void;
}

export const usePageContextStore = create<PageContextState>((set) => ({
  items: [],
  setItems: (items) => set({ items }),
  clear: () => set({ items: [] }),
}));
```

The `usePageContext` hook writes to this store on mount, clears on unmount:

```ts
// SpecDetail.tsx
usePageContext(
  () => [
    specContextItem(spec, { primary: true }),
    linked.tasks.length > 0 ? tasksContextItem(linked.tasks) : null,
  ].filter(Boolean),
  [spec, linked.tasks],
);
```

`ContextMenu` subscribes directly via `usePageContextStore((s) => s.items)`
— no context, no provider, no wrapping.

**Two stores, explicit boundaries.** The design has two distinct stores
that are easy to conflate:

| Store | Contents | Scope | Cleared by |
|---|---|---|---|
| `PageContextStore` (new, module-level) | Menu items declared by the active page via `usePageContext` | Page-scoped. Each page's items replace the previous page's on mount. | `usePageContext` cleanup on unmount |
| `ChatFabStagedChips` (slice on existing `ChatFabStore`) | Chips the user has staged in the composer | Session-scoped within a single tab. Independent of which page is currently mounted. | User `×` on chip; composer Send; explicit Clear |

Navigating from SpecDetail to TaskDetail clears the spec + tasks from
`PageContextStore` (the menu now shows task items), but does **not** clear
staged chips in `ChatFabStagedChips` (the user's prior staging survives).

### 4.3 Primary (pinned) item

`ChatFabContextItem` gains `primary?: boolean`. `ContextMenu` renders the
primary item at the top with a distinct style; the composer exposes an
`@` shortcut that drops straight to it (keybinding conflict check
deferred — see §8.2).

**At-most-one primary, enforced in `PageContextStore`.** Because React's
concurrent rendering and strict mode can run two `usePageContext` effects
near-simultaneously during route transitions, enforcement has to happen
at the store, not at hook call:

```ts
setItems: (items) => {
  const primaries = items.filter((i) => i.primary);
  if (primaries.length > 1) {
    console.warn('[PageContextStore] multiple primary items; keeping last');
    items = [...items.filter((i) => !i.primary), primaries.at(-1)!];
  }
  set({ items });
},
```

Last-write-wins with a dev warning. This is intentional: two pages briefly
overlapping during a route transition is normal; we want the new page's
primary to stick, not an error.

### 4.4 Live refresh at inject time

`ContextTypeSpec.live` refetches at inject time. Signature:

```ts
live?: (data, { queryClient, signal }) => Promise<T | null> | T | null;
```

The 200ms soft timeout aborts `signal`; the settled value is discarded if
the signal aborted while the promise was pending. Example for `spec`:

```ts
live: async (d, { queryClient, signal }) => {
  const cached = queryClient.getQueryData<SpecData>(
    ['spec', d.resource_id, d.id],
  );
  if (cached) return cached;
  return queryClient.fetchQuery({
    queryKey: ['spec', d.resource_id, d.id],
    signal,
  });
},
```

Trade-off: a 200ms window can bite on slow networks; the fallback to the
staged snapshot keeps the injection non-blocking. The hover preview
(§4.6) always shows what will actually be sent, so there is no silent
staleness — by the time the user clicks Send, the chip has resolved or
given up.

### 4.5 Fenced-block formatting convention

All injected context wraps in a self-describing fenced block:

```
<context kind="openhive:spec" id="abc123" resource_id="res-xyz">
# My Spec Title
...body...
</context>
```

**`kind` is qualified** — `openhive:spec`, not bare `spec`. This lets agents
reading a turn in isolation (resumed session, cross-hub federation) know
the entity type without external vocabulary. `kind` comes from
`ContextTypeSpec.kind`; the short unqualified `type` field is UI-only and
never reaches the agent.

**Identity attributes are mandatory** and required for correctness, not
forward-compat. Agents need them to:
- Act on the entity (`update spec abc123 …`, `query task xyz status`)
- Reference the entity in their reply (`"in spec `abc123`…"`)
- Fetch fresh state if reference-mode injection lands later (§4.7)

**Type-dependent body, identity-carrying wrapper.** Prose types
(`spec`, `conversation turn`, `session excerpt`) put markdown inside the
block; data types (`dispatch`, `stream`, `task`, `swarm`) put a key-value
block inside. One wrapper, two bodies.

Sibling to the `<dispatch>…</dispatch>` convention already used by
`buildDispatchSeedPrompt()` (`src/api/routes/specs.ts:303`) — dispatch
seeds and chat-injected context share the format but remain distinct
features with different lifecycles.

A helper:

```ts
function fencedBlock(
  tag: string,
  attrs: Record<string, string>,
  body: string,
): string
```

produces the wrapped form. Attr values are HTML-attribute-escaped (quotes
replaced with `&quot;`, control chars with `\xNN` sequences). `format`
calls this with `tag='context'` and `attrs={ kind: spec.kind, ...identity(data) }`.

The user also sees a human-readable one-liner above the block in their own
chat bubble (`📄 Shared context — Spec: X`) so chat history is readable
without unwrapping. This prefix is English-only; i18n deferred.

**Materialization convention:** v1 always materializes the body inline.
Agents receive full content — no round-trip needed. Identity attrs are
carried anyway because they are functionally required (see above), not
as forward-compat noise.

Multiple items selected at once concatenate with a blank line between
blocks in a single user turn.

### 4.6 Chip-based staging + hover preview

Clicking an item in the menu **stages a chip** above the composer. It does
not immediately send. Interaction shape:

- Menu closes; a chip appears (`📄 Spec: X ×`) in a horizontal strip above
  the textarea.
- User clicks "Add context" again to stage additional chips (chips can
  stack).
- **Hovering a chip** pops a passive preview showing the rendered fenced
  block. No buttons, no modal. Dismissed on pointer-leave or Escape.
- **× on a chip removes it.** Composer text is untouched.
- User types alongside the chips, then presses Send. Chips + text combine
  into one turn with the convention from §4.5.

**Navigation during composition is non-destructive.** §4.2 spelled out the
store boundaries: `ChatFabStagedChips` is session-scoped, independent of
the active page. Navigating to a new page changes the menu items but
leaves staged chips in place. Chips carry their own data payload so the
page they came from can unmount.

**During an active agent stream:** chips + typed text are still editable.
If the user clicks Send while the agent is streaming, the composed turn
is **queued and sent as the next user turn** after the stream completes.
No interruption, no cancel. Send button may visually indicate "queued"
state during streaming.

**Stale entity case.** If the chip's source entity was deleted between
staging and sending, `live` returns null. We send the staged snapshot
with an extra `stale="true"` attr on the fenced block so the agent can
flag it.

**Tab-local.** Staged chips are not synced across tabs of the same ACP
session. Composition state is per-tab (matches Slack, iMessage, Gmail);
the sent turn is shared history (as today via existing ACP fan-out).

**Mouse-first.** Hover preview is a mouse affordance in v1. Keyboard-only
users can still stage, remove, and send — just no preview without a
pointer. Accessibility ticket filed alongside v1 ship.

Rationale: large items (a 500-line spec, a 40-task subtree) surprise users
without a preview. Chips + hover-preview keep the common path to one click
(stage → Send), while still making "what am I about to send" inspectable.

### 4.7 Reference-only injection (deferred, forward-compat today)

v1 materializes full bodies inline. A future mode lets the user inject a
**reference** — just the fenced wrapper with `identity` attrs, no body —
for cases where the agent already has the entity loaded or can query the
hub on demand.

Design constraints carried in v1 to keep this cheap later:

1. **`identity(data)` is required on every registration.** (Already true
   for functional reasons, per §4.5.)
2. **Format stays wrapper-agnostic.** A future `formatReference(data)`
   can return just `fencedBlock('context', { kind, ...identity(d) }, '')` —
   same shape, empty body.
3. **`kind` and `description` are already in the registry.** Reference
   mode can advertise the full vocabulary via a capability channel
   without further registry changes.

What's still needed for the full feature (not in v1):

- A hub-side endpoint agents hit to resolve `kind + id → body`,
  capability-gated so unprivileged agents get 403.
- A menu affordance to choose body vs. reference at stage time.
- Agent-side capability declaration (`chat.contextQuery: true`) so the
  UI only offers reference mode when the agent can resolve it.

Explicitly out of v1.

## 5. Pages to cover

Initial target set; scoped so each is a ~50-line change plus one registry
entry if the type is new:

| Page | Items | New types? |
|---|---|---|
| SpecDetail *(exists)* | Spec (primary), linked tasks | none — reuse `spec`, `tasks` |
| DispatchDetail *(partial)* | Dispatch (primary), source spec, linked tasks, latest attempt | `attempt` added as a **field on the existing `dispatch` payload** — not a new type; payload gains `latest_attempt?: { id, status, started_at, error? }`. No breaking change to consumers that don't read the field. |
| CascadeStreamDetail | Stream (primary), merge state, linked task, commit range summary | new `stream` |
| TaskDetail | Task (primary), parents, children, blocking edges, assignee, linked spec | reuse `task`, `tasks` |
| SwarmDetail | Swarm (primary), registered agents, recent lifecycle events | reuse `swarm`; optional new `agents` |
| SessionDetail | Session (primary), trajectory summary, linked conversation | reuse `session` |
| MailConversation | Conversation (primary), last N turns | new `conversation` |

A "current page" primary is required; the rest are optional. Menu ordering
mirrors the table (top = primary, then related entities, then aggregates).

## 6. UX details

### 6.1 Menu layout

- Top row: `@Current page` — the primary item, pre-highlighted.
- Separator.
- Related items — grouped by kind, same order as source page panels.
- Empty state (page has not called `usePageContext`): the "Add context"
  button is **hidden** rather than showing an empty menu. No broken
  affordances.

### 6.2 Composer affordances

- `@` keystroke in the composer opens the menu with the primary item
  preselected (Enter stages the primary chip immediately). **Caveat**:
  the `@` binding may conflict with swarmcraft's `ChatInput` mention
  handling — verify at implementation. If conflicted, fall back to a
  dedicated icon button and `⌘K`.
- Staged chips render in a horizontal strip above the textarea
  (`📄 Spec: X ×`). Multiple chips stack; max ~5 visible before
  collapsing into a `+N` overflow chip. Width target: fits in the
  384px-wide floating FAB panel.
- **Hovering a chip** shows a passive preview popover with the rendered
  fenced block. No buttons in the popover; dismissed on pointer-leave or
  Escape.
- **× on a chip removes it.** Composer text is untouched. Removing all
  chips reverts to a plain turn.
- **Navigation does not clear chips.** Staged context travels with the
  user. If the underlying entity was deleted by the time Send is pressed,
  the fenced block gets `stale="true"` and the staged snapshot is sent.
- **During streaming**: Send queues the turn for delivery after the
  agent's current stream completes. Composer + chips remain editable
  during streaming.
- **Across tabs**: chips are tab-local. Once Send fires, the turn is
  visible in all tabs of the shared ACP session via existing fan-out.

### 6.3 What the agent sees

One user turn, of the form:

```
<context kind="openhive:spec" id="abc123" resource_id="res-xyz">
# Title
…body…
</context>

<context kind="openhive:tasks" count="3">
- [open] `t-1` — First task
- [in_progress] `t-2` — Second task
- [blocked] `t-3` — Third task
</context>

Please help me tighten section 2.
```

Agents can parse or ignore the fenced blocks at their discretion; they
remain valid markdown to a naive reader.

## 7. Migration plan

### 7.0 Feature gating

Chip-staging UI changes user-visible composer behavior. To enable staged
rollout and easy rollback:

- Gate chip staging + hover preview behind `import.meta.env.VITE_CHAT_CONTEXT_CHIPS`
  (default: `off` in production, `on` in dev/preview builds).
- Legacy one-click-insert remains the default path until the flag flips.
- Rollback: unset the env var and redeploy. No data migration needed
  (both paths read from the same registry).
- Flip to default-on after step 7 lands and ~1 week of internal use.

Steps 1–4 land *without* the flag (registry + store refactor is strictly
additive, old formatter path remains). Steps 5–6 land gated. Steps 7–9
progressively turn the flag on by default.

### 7.1 Steps

Sequenced so each step is a reviewable diff. Steps 1+3 must land together
to demonstrate the shape (step 1 alone is scaffolding with no user-visible
change; calling it a "release" is misleading). Subsequent steps are
independently shippable.

1. **Scaffolding: registry + store + fenced-block helper.**
   Create `context-registry.ts`, `page-context-store.ts`,
   `fenced-block.ts`. Wire `ContextMenu` to read from
   `PageContextStore` (replaces its `useChatFabContext` call).
   `ContextFormatter.tsx` delegates to registry lookup with a fallback
   to the legacy switch for any types not yet registered. No page
   changes yet. (Bundled with step 3 into one PR.)
2. **`usePageContext` hook + first registry entry (`spec`).**
   Writes to `PageContextStore` on mount, clears on unmount. Registers
   the `spec` context type. (Bundled with step 3.)
3. **Migrate SpecDetail** to `usePageContext` + `specContextItem(...)`.
   Delete the `<ChatFabContextProvider>` wrap. Validate the fenced-block
   output in a real chat session. **This is the first user-visible milestone.**
   *(Steps 1–3 land as one PR. Rollback via `git revert` is atomic.)*
4. **Migrate DispatchDetail** to the hook and expand the items it
   exposes (source spec, linked tasks, latest attempt as a `dispatch`
   field).
5. **Chip-staging UI (flag-gated).** Replace direct composer insertion
   in `ContextMenu` + `ChatPanel`. Include hover preview. Keep the
   legacy direct-insert path alive behind `!VITE_CHAT_CONTEXT_CHIPS`.
6. **Primary pinning + `@` shortcut** (flag-gated). At-most-one
   primary enforced in `PageContextStore`. `@` binding verified against
   swarmcraft `ChatInput`.
7. **Add `live` loaders** for `spec`, `task`, `tasks`, `dispatch`. Use
   React Query cache as default source; fall back to `fetchQuery`.
   Honor `AbortSignal` from the 200ms timeout wrapper.
8. **Roll out remaining pages** (CascadeStreamDetail, TaskDetail,
   SwarmDetail, SessionDetail, MailConversation) — one PR each.
9. **Flip the flag and clean up.** Default `VITE_CHAT_CONTEXT_CHIPS`
   to on in production. Remove the legacy direct-insert path. Remove
   the legacy `ChatFabContextProvider` (delete `ChatFabContext.tsx`;
   no pages reference it).

## 8. Risks

### 8.1 Known risks with mitigations

- **Large payloads.** A 10k-line spec dumped into a user turn can blow
  past an agent's context window. Mitigation: per-type `format` truncates
  bodies over a configurable size with a `...[truncated, N lines]...`
  marker. Hard cap enforced at the composer-send level (reject + toast
  if even after truncation the turn exceeds `MAX_USER_TURN_BYTES`,
  default 256KB).
- **Agent confusion.** Agents without a convention for `<context>`
  blocks may parrot them. Mitigation: document the convention in
  `skill.md` so cc-swarm agents pick it up at registration; agents that
  ignore it still see valid markdown.
- **Drift between UI cache and daemon state.** `live` reads React Query,
  which reflects the last sync. Mitigation: per-type `live` can force
  refetch via `queryClient.fetchQuery({ signal })`. The AbortSignal
  keeps slow refetches from hanging the injection.
- **Registry load order.** The registry is module-level state. If
  `ContextMenu` imports `context-registry` before any type file runs
  `registerContextType`, the menu renders empty. Mitigation:
  `context-types/index.ts` side-effect-imports every type file, and
  `context-registry.ts` exports nothing that can be imported without
  triggering the registration. A test in
  `src/__tests__/chat-fab/registry-bootstrap.test.ts` imports the public
  entry point and asserts `listContextTypes().length >= EXPECTED_COUNT`.
- **Vite HMR double-registration.** Module-level singletons are
  re-evaluated on HMR. Mitigation: `registerContextType` uses
  `registry.set(...)` (overwrite) rather than `.has() → throw`, and a
  dev-only assertion at *fresh* module load time warns on duplicate
  registrations.
- **Chip memory across session swaps.** If the user stages chips, closes
  the ChatFab, opens a new chat session with a different agent, the
  chips are: cleared silently on session change. This matches the
  tab-local principle — composition state belongs to the active
  composer, not to a history. Clearing on session change avoids the
  "agent A's context bled into agent B" surprise.
- **Attr quoting.** `fencedBlock()` HTML-escapes attr values (`"` →
  `&quot;`, control chars → `\xNN`). Unit test on malformed inputs.

### 8.2 Open questions (not v1 blockers)

Most v0.1/v0.2 open questions resolved in §11. What remains:

1. **`@` keystroke collision with swarmcraft `ChatInput` mention
   handling.** Needs a 15-minute check at implementation time. Fallback:
   dedicated icon button + `⌘K`. Not a design blocker.
2. **Identity key-namespace convention.** Multiple types emit `id="..."`;
   disambiguation is via the `kind` attr. Convention documented in
   §4.5; test coverage in §3.1.1. Leave open only as a maintenance
   reminder: future types must consistently pair `id` with `kind` and
   avoid inventing parallel primary-key attrs.
3. **Keyboard a11y for hover preview.** Deferred to a follow-up ticket.
   Mouse-first is the v1 scope.
4. **Mobile layout.** ChatFab is desktop-tuned today. Not in v1 scope.

## 9. What this explicitly does not address

- The reverse channel: agent → spec edits. That's the next design, and
  it should assume structured context injection is the foundation it
  builds on (the agent references `<context kind="openhive:spec" id="abc"/>`
  in its proposal, and the UI resolves `kind + id` to decide which
  editor to target).
- Long-term context memory / "the agent has seen this spec before".
- Cross-session pinning of context items.
- Authoring UX for custom context types (user-defined snippets).
- Telemetry / analytics on injection events.
- Token-count estimation in the preview.
- i18n of the human-readable chat-bubble prefix.
- Mobile layout tuning.

## 10. Appendix

### A. Current call site (SpecDetail.tsx:212–231)

```tsx
const chatFabItems: ChatFabContextItem[] = [
  {
    label: `Spec: ${spec.title}`,
    type: 'spec',
    data: {
      id: spec.id,
      title: spec.title,
      content: spec.content,
      resource_id: spec.resource_id,
    },
  },
  ...(linked.tasks.length > 0
    ? [{
        label: `Linked tasks (${linked.tasks.length})`,
        type: 'tasks' as const,
        data: { tasks: linked.tasks },
      }]
    : []),
];

return (
  <ChatFabContextProvider items={chatFabItems}>
    …
  </ChatFabContextProvider>
);
```

### B. After this design

```tsx
usePageContext(
  () => [
    specContextItem(spec, { primary: true }),
    linked.tasks.length > 0 ? tasksContextItem(linked.tasks) : null,
  ].filter(Boolean),
  [spec, linked.tasks],
);

return <>…</>;
```

### C. Registry entry sketch

```ts
// src/web/components/chat-fab/context-types/spec.ts
import { registerContextType } from '../context-registry';
import { fencedBlock } from '../fenced-block';
import type { QueryClient } from '@tanstack/react-query';

export interface SpecData {
  id: string;
  resource_id: string;
  title: string;
  content: string;
}

const identity = (d: SpecData) => ({
  id: d.id,
  resource_id: d.resource_id,
});

registerContextType<SpecData>({
  type: 'spec',
  kind: 'openhive:spec',
  description: 'A markdown document describing intended work, dispatchable to agent swarms.',
  icon: '📄',
  label: (d) => `Spec: ${d.title}`,
  identity,
  format: (d) =>
    fencedBlock(
      'context',
      { kind: 'openhive:spec', ...identity(d) },
      `# ${d.title}\n\n${d.content}`,
    ),
  live: async (d, { queryClient, signal }) => {
    const cached = queryClient.getQueryData<SpecData>(
      ['spec', d.resource_id, d.id],
    );
    if (cached) return cached;
    return queryClient.fetchQuery({
      queryKey: ['spec', d.resource_id, d.id],
      signal,
    });
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
```

### D. Fenced-block helper

```ts
// src/web/components/chat-fab/fenced-block.ts

const ATTR_ESCAPES: Record<string, string> = {
  '"': '&quot;',
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

function escapeAttr(value: string): string {
  return value.replace(/["&<>]/g, (c) => ATTR_ESCAPES[c]!)
    .replace(/[\x00-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
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
```

---

## 11. Decisions Log

### Round 1 (v0.1 → v0.2)

| # | Question | Decision | Rationale |
|---|---|---|---|
| A1 | `live` loader signature | **Refetch-capable.** Receives `{ queryClient }`; 200ms soft timeout. | Strictly more powerful; timeout keeps UX non-blocking. |
| A2 | Reference-only vs. body injection | **v1 = bodies only.** Identity attrs required anyway. Reference mode deferred. | Simpler v1; reference mode adds a hub endpoint that's out of scope. |
| A3 | Primary enforcement | **At-most-one, enforced.** | Advisory warnings get ignored. |
| B1 | Multi-selection UX | **Chip-based staging.** | Predictable, matches familiar attachment UX. |
| B2 | Navigation during composition | **Chips persist.** | Once staged, navigation isn't an implicit revoke. |
| B3 | Preview modal vs. chips | **Chips + hover preview.** | Fewer modals; one-click-send preserved. |
| C1 | Capability declaration | **Defer, non-blocking.** | Not a correctness issue. |
| C2 | Block body shape | **Type-dependent, identity-carrying wrapper.** | One wrapper, two bodies. |
| D1 | Auto-inject on every turn | **Out of scope.** | ACP replays history; re-inject burns tokens. |
| D2 | User-defined types | **Out of scope.** | Needs an authoring surface. |
| D3 | Mobile layout | **Desktop only.** | Don't hold v1 for it. |

### Round 2 (v0.2 → v0.3)

| # | Question | Decision | Rationale |
|---|---|---|---|
| R1 | §8.2 #1 entity-type info | **Option A with qualified `kind` attr.** Replace `type` on blocks with `kind="openhive:spec"`. Registry gains `kind: string` and `description: string` fields. | Self-describing blocks work without capability plumbing. Namespacing avoids cross-hub collisions. |
| R2 | Identity justification in v1 | **Required — not forward-compat.** Agents need identity to *act* on entities (update specs, query tasks, reference in tool calls). Reframed in §4.5 and §4.7. | Reference mode is a *future* consumer; identity is *needed* now for agent-action semantics. |
| R3 | Pre-session behavior | **Non-issue.** No composer without session → no menu surface → no pre-session state to handle. | Overanalyzed in earlier drafts. |
| R4 | Chips during agent streaming | **Sent as next turn.** Send queues the composed turn; delivered after the current stream completes. No interruption. | Matches how attentional queueing works in most chat clients. |
| R5 | Multi-tab chip sync | **Tab-local.** Composition state per-tab; sent history shared via existing ACP fan-out. | Slack/iMessage/Gmail convention. Option 1B session sharing is about sent history, not drafts. |
| R6 | Telemetry on injection | **None in v1.** | Feature is context-management, not measured adoption. |
| R7 | Token budget in preview | **Defer entirely.** No size indicator. | Real tokenizer is expensive; heuristics lie. Revisit if users ask. |
| R8 | Keyboard a11y for hover preview | **Mouse-first v1; a11y follow-up ticket.** | Ship the common path; file the gap. |

### Critic-driven (v0.3 fixes)

| # | Issue | Fix | Rationale |
|---|---|---|---|
| F1 | Layout wiring gap (provider in page tree, consumer in Layout sibling) | Replace React Context with **module-level zustand store** (`PageContextStore`). `ContextMenu` subscribes directly. | Producer/consumer in disjoint subtrees. React Context is the wrong primitive here. |
| F2 | `live` had no cancel story | Added `AbortSignal` to the `ctx` param; 200ms timeout aborts it; settled values discarded if aborted. | Prevents hung fetches; lets implementations pass `signal` to `fetchQuery`. |
| F3 | Two stores conflated (`items` vs. `chips`) | Explicit §4.2 table naming `PageContextStore` (page-scoped items) vs. `ChatFabStagedChips` (session-scoped chips). | Different lifecycles; different clear triggers. |
| F4 | Primary enforcement too narrow | Moved from "same-registration throw" to **store-level last-write-wins with dev warning**. | Route transitions run two `usePageContext` effects near-simultaneously in concurrent mode. |
| F5 | No feature flag | Added §7.0 gating chip staging behind `VITE_CHAT_CONTEXT_CHIPS`. | Makes staged rollout + rollback trivial. |
| F6 | Goals not testable | Added §3.1 with 8 concrete acceptance criteria. | Ungated goals = vibes-based review. |
| F7 | `attempt` payload ambiguous | Clarified as a **field on `dispatch` payload**, not a new type. No breaking change. | One less type file; simpler migration. |
| F8 | Registry load order / HMR risks | Added §8.1 mitigations: index-file side-effect import + registration test; `.set()` overwrite semantics. | Module-level singletons in Vite are a known foot-gun. |
| F9 | Hard cap on turn size | Added `MAX_USER_TURN_BYTES` (256KB default) at composer-send level. | Per-type truncation handles large entities; hard cap handles pathological accumulation. |
| F10 | Attr quoting | Defined `escapeAttr` in §10.D. | HTML-attr-escape + control-char escape. Unit test coverage. |
| F11 | Registry entry type safety | Constructor return type `ChatFabContextItem & { type: 'spec'; data: SpecData }` in §10.C. | Links the `type` discriminant to its payload shape at the call site. |
| F12 | Step 1 honesty | §7.1 bundles steps 1–3 as the first user-visible PR. Step 1 alone is scaffolding. | Don't sell scaffolding as a release. |
