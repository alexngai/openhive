# OpenHive UI Pass

Working doc tracking a design/UX review pass. Each item has current state, problem, proposed change, effort, and open questions to discuss.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` dropped

---

## Priority 0 — Quick wins (daily friction, small diffs)

### 1. `[x]` Close the dispatch loop — **DONE**

**Current state**
- `POST /specs/:resourceId/:specId/dispatch` returns a `{ dispatch_id }`.
- `DispatchModal` fires a toast "Dispatch created" and closes. No link, no navigation.
- User manually goes to `/dispatches`, scrolls, clicks in.
- `DispatchDetail.tsx` is read-only — no auto-refresh. A running dispatch looks identical on reload vs. no reload.
- The `/specs/:id` page has a `SpecDispatchesPanel` in the sidebar — easy to miss; most authors check `/dispatches` instead.

**Problem**
8-click flow for a first-class action. The outcome of dispatching a spec is the thing the user cares about; burying it behind a toast makes the feature feel afterthought-y.

**Proposed change**
1. On dispatch success, navigate to `/dispatches/:id` (drop the toast, or demote it to a passive confirmation in the detail header).
2. On `DispatchDetail`, subscribe to `map:dispatches` WS channel (already exists per CLAUDE.md) and invalidate the detail query on any event for this id. Fallback: poll every 5s while `status === 'running'`.
3. On `SpecDetail`, lift the last 3 dispatches out of the sidebar panel and into an inline strip under the title — status chip + relative time + click-through.

**Effort** — S. Three isolated edits: `DispatchModal.tsx`, `DispatchDetail.tsx`, `SpecDetail.tsx`.

**Open questions**
- If the dispatch is created for a *different* swarm than the user's current context, should we still auto-nav? (Probably yes — the user just committed to it.)
- Should the toast stay for bulk/multi-swarm dispatches where navigation would be ambiguous?

---

### 2. `[x]` Add search/filter to Memory, Skills, Specs, Dispatches — **DONE**

**Shipped**
- New `src/web/components/common/ListFilters.tsx`: shared toolbar with debounced search input, result count (`N of M` when filtered, `N items` when not), and a `right` slot for page-specific controls. Exports `useDebouncedValue` and `matchesSearch` helpers.
- Applied to Memory (name/description/scope), Skills (name/description/scope), Specs (title/content/resource_name, with the archived toggle slotted in), Dispatches (id/spec_id/initiator_id/swarm-name, with the existing status chips + swarm dropdown slotted in).
- Agents intentionally skipped — deleted in #5.
- Typecheck clean; 423/425 tests passing (2 pre-existing Dispatches failures unrelated).


**Tasks list deferred** — same pattern would apply but the page has a different shape (setup form + graph view) that's worth a separate small pass.

**Open questions (resolved)**
- Client-side search was fine at current scale — all four use it. If any list grows past ~200 rows we can add a `search` query param to the relevant endpoint and keep the component contract identical.

---

## Priority 1 — Structural (next sprint)

### 3. `[-]` Break SwarmDetail into tabs — **reverted**

Tabs hid too much information behind clicks; flat layout works better in practice. Ship-and-revert confirms the stack is easier to scan — reviewer can glance at everything without a tab selection. Leaving the page as a flat vertical stack. If individual sections get overloaded later, collapsing them in place (a la the existing Logs section toggle) is a lower-cost alternative than a tab bar.

---


**Current state**
`SwarmDetail.tsx` (~1400 lines) is a vertical stack of:
1. Header (name, status, actions)
2. Terminal section
3. Logs (collapsible)
4. Nodes / Registered Agents
5. Resumable Sessions
6. Sessions
7. Compose Message
8. Messages
9. Events
10. Peers

Most of these are collapsible (good instinct) but the page is still a scroll slog and the primary action ("Spawn Agent") is at the top but gets scrolled past when you're looking at anything else.

**Problem**
- Too many concerns on one page.
- No obvious "where do I go for X?" — everything is potentially anywhere.
- Accidentally-discovered sections (Events, Peers) could disappear behind a tab nobody opens, which is fine.

**Proposed change**
Tabs (URL-synced, `?tab=operations`):
- **Overview** — header + Registered Agents + Nodes (primary daily-use surface)
- **Operations** — Terminal + Logs (ops engineers)
- **Activity** — Sessions + Resumable Sessions + Messages + Events + Compose (observers/coordinators)
- **Peers** — standalone

Keep the sticky header (name + status + key actions) above the tab bar so context doesn't disappear.

**Effort** — M. Mostly moving JSX around. The trickiest part is which sections become Overview vs. Activity — may want to user-test.

**Open questions**
- Does "Compose Message" belong on the same tab as Sessions/Messages, or is it swarm-level coordination (different concept)? See chat review: ComposeMessageSection is coordination-only but looks identical to agent chat. May want to rename it on this page.
- URL-synced tabs or local state? URL-synced lets users share links to "this swarm's logs."

---

### 4. `[x]` Surface buried routes — **DONE**

**Shipped**
- **Events** — now in the sidebar under Control Plane with a Bell icon, between Swarms and Streams. The page manages fleet-wide event subscriptions + delivery log.
- **Terminal** — no sidebar entry; entry point lives on SwarmDetail. Prominence fine there.
- **Streams** — rebuilt and renamed to **Changes** (see notes below). Primary actor is a human reviewer with override write access; default view is a triage-first list (Needs attention / In progress / Recently landed). Stack + Graph demoted to secondary views. Conflicts converted from a top-level view into a filter chip. Force-resolve copy reframed as an escape hatch so the design leans on agents to handle conflict resolution when possible. URL renamed `/streams` → `/changes` with redirect. Layout promoted to full-width. Deferred to a future pass: manual stack creation / override writes, and a MAP method to ping agent owners for conflict resolution.

---


**Current state**
- `Events` — route exists at `/events`, **not in sidebar**.
- `Terminal` — route at `/terminal/:swarmId`, only reachable from SwarmDetail.
- `Streams` — in sidebar. Refers to **git stack artifacts** accumulated across agent sessions. The concept itself needs sharpening before the UX question is solved.

**Problem**
Dark routes are either dead weight or undiscoverable features. For Streams specifically, the *concept* is fuzzy before the UI can be fixed.

**Proposed change**
- **Events** — if kept, add to sidebar under Control Plane (near Threads). Or delete the route if it's superseded by per-swarm events.
- **Terminal** — stays as a contextual route from SwarmDetail. No sidebar entry needed, but make the entry point in SwarmDetail more prominent (currently inside a collapsible).
- **Streams** — **refine the concept first**, then design. "Git stack artifacts" is the raw fact; the user-facing framing needs to answer: what decision does Streams help the user make? What's the primary action on this page? Once that's pinned down, rename accordingly (e.g., "Stacks", "Branches", "Changes") and give the page a real shape.

**Effort** — S for Events + Terminal; Streams depends on how much conceptual work is needed first (M–L).

**Decisions made**
- Streams = git stack artifacts (confirmed). Concept refinement blocks UI work.

**Open questions**
- What's the primary action on the Streams page? Viewing diffs? Reviewing? Landing? This determines the whole layout.
- Does Streams belong in Control Plane (an action surface) or Resources (a browsable archive)?
- Events vs. Streams vs. Threads — is there a unifying concept (agent output over time)?

---

### 5. `[x]` Delete the Agents concept — **DONE**

**Current state**
- `/agents` — flat list, karma scores, social-profile vibe (from the old Reddit-style hive era).
- `/a/:agentName` — social profile page. CLAUDE.md already notes it's unreachable from primary nav and was "removed as unused" — but the route is still there.
- `/swarms/:id` has a "Registered Agents" section that covers the operational use case.

**Decisions made**
- **Agents is an outdated concept. Delete it.** The social/karma model is vestigial from the hive era; operational agent context lives on SwarmDetail.

**Proposed change**
- Delete `/agents` route + `Agents.tsx` page.
- Delete `/a/:agentName` route + `Agent.tsx` page.
- Delete `AgentBadge`, karma-related bits, and any dashboard/sidebar references.
- Audit for other social-layer holdovers (posts, comments, hives, votes) — some may still be wired but unused. Separate pass if significant.

**Effort** — S for the deletion; +M if we also rip out the wider social-layer scaffolding in the same pass.

**Open questions**
- Do we want to keep the social-layer *backend* (posts/hives/comments tables) for a future use case, or is that also dead?

---

### 6. `[x]` Group Specs + Dispatches + Tasks as one "Work" section — **DONE**

**Shipped**
- Three sidebar groups now: **Control Plane** (Overview · Threads · Swarms · Streams) · **Work** (Specs · Dispatches · Tasks) · **Resources** (Memory · Skills · Learning).
- Section state persists via existing `expandedSections` localStorage, so the new "Work" group opens expanded on first load and remembers user toggles thereafter.
- Tests unchanged — the existing sidebar test keys on label + href, not grouping.

---


**Current state**
Three sidebar entries for one pipeline:
- **Specs** — authored intent
- **Dispatches** — (spec, swarm) pairings handed to orchestrator
- **Tasks** — OpenTasks graph (different resource model)

**Problem**
The conceptual distinction is clear to engineers but cryptic to newcomers. "I want to give the agents work" has three entry points.

**Proposed change**
- Group under a single sidebar section "Work" with Specs, Dispatches, Tasks as children.
- On `SpecDetail`, show dispatch history inline (see item #1) so Dispatches becomes less of a required navigation step.
- Long term: consider whether Tasks (OpenTasks graphs) belongs in this group or in Resources — it's a different lifecycle.

**Effort** — XS for sidebar reshuffle; M for inlining dispatch history.

**Open questions**
- Does Tasks belong with Specs/Dispatches, or is it closer to Memory/Skills (agent-owned resources)?

---

## Priority 2 — Chat consolidation (bigger call, needs alignment)

### 7. `[ ]` Unify Sessions + Messages into **Threads**

**Current state**
Four chat surfaces, each with its own entry point:

| Surface | Entry | Transport | Creates new stream? |
|---|---|---|---|
| `SessionDetail` trajectory | Sessions list → click | ACP + Mail | Yes on open |
| `Conversation` | Messages list → click | Mail only | N/A |
| `SwarmDetail` ComposeMessageSection | Scroll to bottom | Coordination (polling) | N/A |
| `ChatFab` | Floating button, docks/undocks | ACP + Mail | Yes on open |

**Problem**
- **Bug:** opening ChatFab while on SessionDetail for the same agent creates a *second* independent ACP stream. `findLiveAcpSession` checks in-memory `streamId` but not liveness.
- Sessions and Mail conversations are the same artifact under different transports — but currently separate pages.
- ComposeMessageSection looks like agent chat but is swarm-to-swarm coordination. Confusing.

**Conceptual model (locked)**

Two axes that Sessions-only was conflating:
- **Thread** = the container. Who's in the conversation + topic + messages over time. Can be 1:1 or group (multi-party, mail-transport).
- **Session** = a specific agent's participation *inside* a thread. Their trajectory, checkpoints, ACP stream.

Three thread flavors, all rendered as trajectories with UI that adapts based on capabilities:

| Thread flavor | Looks like | Transport |
|---|---|---|
| 1:1 live | DM with live-typing indicator | ACP |
| 1:1 async | DM, delayed | Mail |
| Group | Channel / group DM (N avatars) | Mail (multi-party) |
| Run (autonomous) | Single agent's journal | No user transport |

**Decisions made**
- **Name: Threads.** URL: `/threads` (redirect from `/sessions` and `/messages`).
- **Three flavors coexist** in one list (interactive ACP, async mail, autonomous dispatch). All visible by default; distinct styling for runs so they don't noise the signal.
- **Group threads** render with per-message inline "View session →" affordance (no sidebar drawer).
- **ACP connection shared** across SessionDetail and ChatFab — one live stream per `(owner, swarm, targetAgent)`.
- **ChatFab is disabled when the user is on the ThreadDetail page for the same thread the FAB is open to.** No pill, no duplicate surface. Re-enables on navigation away.
- **Drop active/inactive sidebar pattern.** Replace with pinned-live section + timeline + filter chips.

**Proposed change**

Broken into sub-items to ship incrementally:

- **7a. `[x]` ACP stream liveness check + dedup.** New `isAcpStreamLive(sc, streamId, serverId)` helper in `src/api/routes/sessions.ts` replaces the bare `streams.has(id)` check. Three layers: (1) stream exists in manager Map, (2) stream not `isClosed` and has `initialized`, (3) `mapClientManager.isConnected(serverId)` reports connected. Any layer failing → fall through to recreate, log info with context. Helper tolerates partial mocks (existing tests still green). **3 new tests** cover the mid-flight close, unfinished-init, and outbound-disconnect paths; all 9 acp-connect multitab tests pass. **S. DONE.**
- **7b. `[x]` Route rename + redirect.** Added `/threads`, `/threads/:id` (rendering existing Sessions + SessionDetail components for now). Redirects `/sessions` → `/threads`, `/sessions/:id` → `/threads/:id`. Updated 12 internal Link/navigate call sites. Sidebar nav item renamed Sessions → Threads. Messages nav item removed (dynamic "Active Mail" sidebar section preserves access to /messages until 7c+7d land). Tests updated. Typecheck clean. **S. DONE.**
- **7c. `[x]` Unified list shape.** Sessions.tsx rewritten (client-side merge; V1). Sidebar now has: filter chips (All/Live/Mail), pinned Live section + Recent section (mixed) or single flat list (filtered), unified ThreadRow (agent avatar for session, Mail icon for 1:1 mail, Users icon for group mail). Detail pane routes to SessionDetail (session id param) or MailThreadView (mailId param). New `/threads/mail/:mailId` route. Thread-model types: `session` | `mail`; status: `live` | `recent` | `idle` | `mail-active` | `mail-completed`. **M. DONE.**
- **7d. `[x]` Unified detail.** New `MailThreadView.tsx` under `src/web/components/sessions/` mirrors SessionDetail's sticky-header + ChatMessageList + PermissionDialog (sticky-external) + ChatInput layout. Group chips when participants > 2. Same chat contract underneath. `/threads/:id` → SessionDetail (existing); `/threads/mail/:mailId` → MailThreadView. **M. DONE.**
- **7e. `[x]` Group-thread participants.** Mail thread detail shows stacked participant avatars (up to 5 + overflow), a `group · N` chip in the header for N>2, and — for group threads — a horizontal participants strip under the header with per-participant "View session →" drill-in when a linked session exists. Participant→session matching is client-side via two paths: (a) `session.metadata.acp_target_agent_id === participant.agent_id`, (b) `session.metadata.mail_conversation_id === conversationId && session.owner_agent_id === participant.agent_id`. Backend change: `SessionListItem` DTO extended with `acp_target_agent_id` + `mail_conversation_id` (read from session metadata in `listAllSessions`). Per-message (intra-bubble) drill-in is NOT implemented because swarmcraft's `ChatBubble` is an external npm package with no per-message/sender click callback; participant-level strip delivers the same drill-in at a lower visual cost. **DONE.**
- **7f. `[x]` ChatFab disable-on-match.** FAB and ChatSidebar both suppress when `pathname === /threads/:fabSessionId` (or legacy `/sessions/:id`). Re-appear on navigation away. **XS. DONE.**
- **7g. `[x]` Delete `/messages`, `/messages/:id`, Conversation page.** Messages.tsx, Conversation.tsx + their tests deleted. Redirects in App.tsx send legacy URLs to `/threads` and `/threads/mail/:id`. Sidebar "Active Mail" section now links to `/threads/mail/:id`. **XS. DONE.**
- **7h. `[x]` Rename `ComposeMessageSection` → "Coordination Broadcast"** on SwarmDetail. Now uses Megaphone icon + honey-accent left-border + subheader reading "Swarm-to-swarm coordination · not agent chat" + tooltip on the toggle. **XS. DONE.**

**Effort** — L overall. But 7a, 7b, 7f, 7h can ship standalone in any order.

**Status:** All of #7 (7a–7h) shipped. 7e's per-message "View session →" drill-in is the only deferred piece — it needs per-speaker session linkage in the mail-turn payload before it can be wired.

**Open questions**
- Does a mail thread *ever* exist today without a linked session? Mail is a MAP concept and user confirmed multiple sessions can interact in one thread — so threads pre-exist sessions. The merged query needs to handle: (a) thread with N sessions, (b) thread with 0 sessions, (c) session with no thread wrapper (autonomous). Data model audit needed before 7c.
- For group threads with >3 participants, does the stacked-avatar pattern scale, or do we need a "12 participants" count-badge variant?
- Filter chips default state: should `Runs` be checked by default, or collapsed into `All` with runs visually de-emphasized? Decision made to default-show, but we should test whether runs swamp the list in practice.
- When opening a group thread, do we render *all* participant messages in one unified stream, or do we paginate/filter by participant? (Probably unified with speaker attribution; filter is a secondary affordance.)

---

### 8. `[x]` Explicit "Unavailable" state for chat — **DONE**

**Shipped**
- ChatInput already renders an "unavailable" strip when no adapter can handle the target, with a `deriveUnavailableReason` fallback that handles the "offline" + "no capability" cases.
- MailThreadView now passes an explicit `unavailableReason={"Conversation ${status} — replies disabled"}` when the conversation itself is inactive — distinguishes thread-closed from swarm-offline.
- Session and ACP paths use the existing fallback ("Agent is offline" / "Agent does not publish chat capabilities"), which is accurate enough. No extra wiring needed at those call sites.

---


**Current state**
Capability resolvers return `{ available: false, connected: false }` when:
- Swarm is offline
- No chat capability declared
- Conversation is closed

But the UI still renders `ChatInput` as if it's interactive. User types, hits enter, nothing happens.

**Decisions made**
- **Ship this.** Standalone, independent of #7.

**Proposed change**
When `available === false`, render a banner above the input (or disable + lock-icon the input) with the reason:
- "Swarm offline — chat unavailable"
- "Agent has no chat capability"
- "Conversation closed"

Wire the reason through the capability resolver's return (currently just `{ available: false }` — extend to `{ available: false, reason: 'swarm_offline' | 'no_capability' | 'closed' }`).

**Effort** — S. One component, three call sites.

---

### 9. `[x]` PermissionDialog: use sticky-external everywhere — **DONE**

**Shipped**
- ChatPanel (the FAB) now uses `<PermissionDialog channel={...} variant="sticky-external" descriptionAs="code" approveLabel="Allow" />` — same variant as SessionDetail + MailThreadView.
- Allow/Deny no longer consumes vertical space inside the FAB's message list; it docks above the input just like the other surfaces.

---


**Current state**
Per CLAUDE.md, `ChatPanel` (the FAB) uses `inline` variant; SessionDetail and Conversation use `sticky-external`. On a 360px-wide floating panel, inline takes ~20% vertical space.

**Proposed change**
Switch ChatPanel to `sticky-external`. Add a countdown badge showing time remaining before the 5-min server-side timeout.

**Effort** — XS.

**Open questions**
- Does `sticky-external` actually fit in a 360px panel? May need a compact variant.

---

## Priority 3 — Visual system cleanup

### 10. `[x]` Exile unused purple/SwarmCraft tokens — **DONE**

**Shipped** — `src/web/styles/globals.css` cleaned out:
- Purple `--color-accent: #7c3aed`, `--color-accent-dim` (overridden by `:root` honey anyway; the theme block versions generated no used classes).
- `--color-void`, `--color-deep`, all `--color-node-*` (swarmcraft graph-viz tokens; no `bg-node-*` / `bg-void` consumers in openhive).
- `--shadow-glow`, `--shadow-glow-soft` (hardcoded purple, never applied).
- Declared-but-unused animations: `--animate-fade-in-up`, `--animate-glow-breathe`, `--animate-breathe`, `--animate-pulse-glow`, `--animate-sc-slide-in/up`, `--animate-sc-fade-in` + their keyframes.
- Kept: workspace surface tokens that generate used utility classes (`bg-elevated`, `text-text-muted`, `text-text-secondary`, etc.) with a comment explaining the SSR-fallback intent.

Net: ~60 lines deleted from globals.css. Build + typecheck + tests clean.


**Current state** (`src/web/styles/globals.css`)
- `--color-accent: #7c3aed` declared but never used in OpenHive components.
- `--shadow-glow`, `--animate-pulse-glow`, `--animate-breathe` all hardcode purple.
- Zero grep hits for `animate-breathe` or `animate-pulse-glow` in `src/web/`.

**Proposed change**
- Delete unused purple tokens from the main theme block.
- Keep SwarmCraft-specific tokens scoped to `references/swarmcraft/src/ui/embed.css`.
- If glow is useful, rewire it to use `var(--color-accent)` (honey) for consistency with the live accent.

**Effort** — XS. Straight delete.

---

### 11. `[x]` Collapse font stack to 2 — **DONE**

**Shipped** — dropped `--font-display` (duplicate of DM Sans), `--font-sc-sans` (Outfit), `--font-sc-mono` (JetBrains Mono variant). Kept `--font-sans: DM Sans` + `--font-mono: DM Mono` — the two actually in use via Tailwind's `font-sans` / `font-mono` defaults. No rendered pixels change; swarmcraft's visualization layer still brings its own fonts via its own `embed.css`.


**Current state**
5 fonts declared: DM Sans, DM Mono, Outfit, JetBrains Mono, plus `--font-display` (which is DM Sans again).

None of the `--font-*` variables are referenced in components — they all use Tailwind's default `font-sans` / `font-mono`.

**Proposed change**
- Keep DM Sans (body) + JetBrains Mono (code/terminal).
- Delete Outfit, `--font-display`, `--font-sc-sans`, `--font-sc-mono`.
- Wire `--text-*` scale to a small set of semantic classes (`.text-display`, `.text-body`, `.text-caption`) or just lean on Tailwind's defaults.

**Effort** — S.

**Open questions**
- Do you want a distinct display font for headings/hero moments, or is DM Sans enough for the whole app?

---

### 12. `[x]` Formalize spacing into 3 tiers — **DONE**

**Shipped** — new comment block in `globals.css` defining the three tiers and when to reach for each (Compact `py-1` / Default `py-1.5` / Breathing `py-2.5`). No existing component padding changed in this pass — the doc serves as the convention for new code and a reference when reviewing diffs. A separate audit pass could normalize stragglers if desired.


**Current state**
- Sidebar items: `py-1`
- Buttons / inputs: `py-1.5`
- Stat cards: `py-2.5`
- Various mid-level elements floating between

**Proposed change**
Three named tiers used consistently:
- **Compact** (`py-1`) — sidebar, badges, inline lists
- **Default** (`py-1.5`) — buttons, inputs, nav sections
- **Breathing** (`py-2.5`) — primary cards, hero sections

Document in `globals.css` as a comment. Audit existing components and normalize.

**Effort** — M. The audit is the bulk of it.

---

### 13. `[ ]` Verify light mode across all pages

**Current state**
`.light` theme CSS is defined (`globals.css:196-214`) but no components use `dark:`/`light:` prefixes — they all read `var(--color-text)` etc. which is class-switched by the `<html>` class.

So technically it works, but nobody has verified it in 30+ pages.

**Decisions made**
- **Both dark and light modes are in-scope.** Audit and fix.

**Proposed change**
- Screenshot every page in both themes (automatable via Chrome DevTools MCP or Playwright).
- Fix contrast/color issues page-by-page. Expect most issues to be:
  - Hardcoded `text-white` / `text-gray-*` that should be `var(--color-text)`.
  - Inline styles with dark-assumed colors.
  - Icons stroked with fixed colors.
  - Any usage of the honey accent at a shade that becomes illegible on a light background (may need a light-mode honey variant — see globals.css:207 which already bumps to `#d97706`).
- Add a simple visual regression snapshot for a handful of key pages so this doesn't re-rot.

**Effort** — L. The audit + fix is the bulk of the work.

**Open questions**
- Worth building a small "theme preview" dev route that renders a representative sample of every component in both themes on one page, to catch issues faster?

---

### 14. `[-]` Move theme toggle out of Settings — **dropped**

**Decision:** keep the theme toggle in Settings. Daily-driver friction is low since theme is a rarely-toggled preference.

---

## Priority 4 — Nice-to-haves / future

### 15. `[ ]` Cmd+K quick nav

With 11+ sidebar items, a command palette pays off fast. Standard pattern, no surprises.

**Effort** — M.

---

### 16. `[ ]` Collapse sidebar sections by default for new users

Control Plane and Resources both default expanded (`Sidebar.tsx:185`). First impression is a wall of text.

**Proposed change**
Collapsed by default; expand on first interaction; persist choice (already does).

**Effort** — XS.

**Open questions**
- Might annoy existing users who expect everything open. Could gate on "first visit" via localStorage.

---

## Out of scope / deferred

- Full redesign — the bones are good (honey accent on dark workspace is a solid pick). This pass is about cleanup, not reinvention.
- `Agent.tsx` social/karma redesign — see item #5 for the delete-or-rebrand call first.
- Mobile — current shell is responsive-ish but hasn't been audited. Separate pass.

---

## Discussion notes

_Use this section to capture decisions as we go through each item._
