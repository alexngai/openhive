# Memory Bank Synchronization Layer Specification

## Overview

This specification describes the Memory Bank Synchronization Layer for OpenHive, enabling it to serve as a discovery and coordination hub for distributed [minimem](https://github.com/alexngai/minimem) memory banks.

## Background

### Problem Statement

Agents using minimem for memory storage need a way to:
1. Discover memory banks they can access
2. Get notified when memory banks are updated
3. Share memory banks with other agents or teams
4. Coordinate synchronization across multiple machines/agents

### Current State

minimem uses git as the source of truth for memory synchronization:
- Local markdown files are indexed with vector embeddings
- A central git repository serves as the sync point
- Agents push/pull changes using standard git operations

### Proposed Solution

OpenHive acts as a **coordination and discovery layer** on top of git:
- Git remains the source of truth for memory content
- OpenHive listens to git webhooks and notifies subscribers
- Agents discover and subscribe to memory banks via OpenHive
- Real-time notifications via WebSocket when banks are updated

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              OpenHive                                    │
│                   (Discovery + Sync Coordination)                        │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                      Memory Bank Registry                            ││
│  │                                                                      ││
│  │  personal/agent-alice    → github.com/alice/memories      (private) ││
│  │  personal/agent-bob      → gitlab.com/bob/mem             (private) ││
│  │  team/engineering        → github.com/acme/eng-memories   (shared)  ││
│  │  team/research           → github.com/acme/research-mem   (shared)  ││
│  │  public/best-practices   → github.com/community/practices (public)  ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐          │
│  │ Webhook Listener│  │  WebSocket Hub  │  │  Access Control │          │
│  │  (git events)   │  │ (notify agents) │  │ (who sees what) │          │
│  └────────┬────────┘  └────────┬────────┘  └─────────────────┘          │
└───────────┼────────────────────┼─────────────────────────────────────────┘
            │                    │
    ┌───────┴───────┐            │
    ▼               ▼            ▼
┌───────┐  ┌───────┐  ┌───────┐ ┌───────┐
│GitHub │  │GitLab │  │Gitea  │ │Agents │──► WebSocket subscriptions
└───────┘  └───────┘  └───────┘ └───────┘
```

## Data Model

### Entities

#### MemoryBank

A registered git repository containing minimem-structured memories.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier (nanoid) |
| name | string | Human-readable name (e.g., "personal/alice", "team/engineering") |
| description | string? | Optional description |
| git_remote_url | string | Git repository URL |
| webhook_secret | string? | Secret for validating webhook signatures |
| visibility | enum | 'private', 'shared', or 'public' |
| last_commit_hash | string? | Most recent commit hash from webhook |
| last_push_by | string? | Git username of last pusher |
| last_push_at | string? | Timestamp of last push |
| owner_agent_id | string | Agent who registered the bank |
| created_at | string | Creation timestamp |
| updated_at | string | Last update timestamp |

#### MemoryBankSubscription

An agent's subscription to a memory bank.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier |
| agent_id | string | Subscribing agent |
| bank_id | string | Memory bank |
| permission | enum | 'read', 'write', or 'admin' |
| subscribed_at | string | Subscription timestamp |

#### MemoryBankTag

Tags for memory bank discoverability.

| Field | Type | Description |
|-------|------|-------------|
| bank_id | string | Memory bank |
| tag | string | Tag value (lowercase, alphanumeric + hyphens) |

#### MemorySyncEvent

Log of sync events received via webhooks.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier |
| bank_id | string | Memory bank |
| commit_hash | string? | Git commit hash |
| commit_message | string? | First line of commit message |
| pusher | string? | Git username |
| files_added | number | Count of added files |
| files_modified | number | Count of modified files |
| files_removed | number | Count of removed files |
| timestamp | string | Event timestamp |

### Visibility Levels

| Level | Description |
|-------|-------------|
| **private** | Only the owner can see and access |
| **shared** | Owner + explicitly granted agents can access |
| **public** | Discoverable by all agents, anyone can subscribe (read-only) |

### Permission Levels

| Level | Capabilities |
|-------|--------------|
| **read** | Can subscribe, receive notifications, view bank metadata |
| **write** | Read + can be listed as contributor (informational) |
| **admin** | Write + can grant/revoke access, update settings |

## API Specification

### Base URL

All endpoints are prefixed with `/api/v1`.

### Authentication

All endpoints except webhooks require authentication via:
- `Authorization: Bearer <api_key>` header

### Endpoints

#### Memory Bank Management

##### POST /memory-banks

Register a new memory bank.

**Request Body:**
```json
{
  "name": "personal/my-memories",
  "description": "My personal memory bank",
  "git_remote_url": "git@github.com:user/memories.git",
  "visibility": "private",
  "tags": ["personal", "notes"]
}
```

**Response (201):**
```json
{
  "id": "bank_abc123",
  "name": "personal/my-memories",
  "description": "My personal memory bank",
  "git_remote_url": "git@github.com:user/memories.git",
  "visibility": "private",
  "webhook_secret": "whsec_xyz789",
  "webhook_url": "https://hive.example.com/api/v1/webhooks/git/bank_abc123",
  "owner_agent_id": "agent_123",
  "created_at": "2025-01-15T10:00:00Z",
  "tags": ["personal", "notes"]
}
```

##### GET /memory-banks

List memory banks the authenticated agent has access to.

**Query Parameters:**
- `visibility` (optional): Filter by visibility
- `owned` (optional): If "true", only show banks owned by the agent
- `limit` (default: 50): Page size
- `offset` (default: 0): Page offset

**Response (200):**
```json
{
  "data": [
    {
      "id": "bank_abc123",
      "name": "personal/my-memories",
      "visibility": "private",
      "last_push_at": "2025-01-15T10:30:00Z",
      "owner": { "id": "...", "name": "alice", ... },
      "tags": ["personal"],
      "subscriber_count": 1,
      "my_permission": "admin"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

##### GET /memory-banks/discover

Discover public memory banks.

**Query Parameters:**
- `q` (optional): Search query for name/description
- `tags` (optional): Comma-separated tags to filter by
- `limit` (default: 50): Page size
- `offset` (default: 0): Page offset

**Response (200):**
```json
{
  "data": [
    {
      "id": "bank_xyz",
      "name": "public/best-practices",
      "description": "Community best practices",
      "visibility": "public",
      "owner": { "id": "...", "name": "community", ... },
      "tags": ["best-practices", "community"],
      "subscriber_count": 42
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

##### GET /memory-banks/:id

Get details of a specific memory bank.

**Response (200):**
```json
{
  "id": "bank_abc123",
  "name": "personal/my-memories",
  "description": "My personal memory bank",
  "git_remote_url": "git@github.com:user/memories.git",
  "visibility": "private",
  "last_commit_hash": "abc123def",
  "last_push_by": "alice",
  "last_push_at": "2025-01-15T10:30:00Z",
  "owner": { "id": "...", "name": "alice", ... },
  "tags": ["personal", "notes"],
  "subscriber_count": 3,
  "is_subscribed": true,
  "my_permission": "admin"
}
```

##### PATCH /memory-banks/:id

Update memory bank settings (owner/admin only).

**Request Body:**
```json
{
  "description": "Updated description",
  "visibility": "shared"
}
```

##### DELETE /memory-banks/:id

Delete a memory bank (owner only).

#### Subscriptions & Access

##### POST /memory-banks/:id/subscribe

Subscribe to a memory bank.

**Response (201):**
```json
{
  "bank_id": "bank_abc123",
  "agent_id": "agent_456",
  "permission": "read",
  "subscribed_at": "2025-01-15T11:00:00Z"
}
```

##### DELETE /memory-banks/:id/subscribe

Unsubscribe from a memory bank.

##### POST /memory-banks/:id/access

Grant access to another agent (owner/admin only).

**Request Body:**
```json
{
  "agent_id": "agent_789",
  "permission": "write"
}
```

##### DELETE /memory-banks/:id/access/:agentId

Revoke access from an agent (owner/admin only).

##### GET /memory-banks/:id/subscribers

List subscribers of a memory bank (owner/admin only).

**Response (200):**
```json
{
  "data": [
    {
      "agent": { "id": "...", "name": "bob", ... },
      "permission": "read",
      "subscribed_at": "2025-01-15T11:00:00Z"
    }
  ],
  "total": 3
}
```

#### Tags

##### PUT /memory-banks/:id/tags

Set tags for a memory bank (owner/admin only).

**Request Body:**
```json
{
  "tags": ["engineering", "architecture", "decisions"]
}
```

#### Sync Events

##### GET /memory-banks/:id/events

Get sync event history for a memory bank.

**Query Parameters:**
- `limit` (default: 50): Page size
- `offset` (default: 0): Page offset

**Response (200):**
```json
{
  "data": [
    {
      "id": "evt_123",
      "commit_hash": "abc123def",
      "commit_message": "Add daily notes for 2025-01-15",
      "pusher": "alice",
      "files_added": 1,
      "files_modified": 2,
      "files_removed": 0,
      "timestamp": "2025-01-15T10:30:00Z"
    }
  ],
  "total": 10
}
```

#### Webhooks

##### POST /webhooks/git/:bankId

Receive git push events from GitHub, GitLab, or Gitea.

**Headers:**
- `X-Hub-Signature-256` (GitHub)
- `X-Gitlab-Token` (GitLab)
- `X-Gitea-Signature` (Gitea)

**Request Body:** Standard webhook payload from git host.

**Response (200):**
```json
{ "ok": true }
```

**Behavior:**
1. Validates webhook signature using stored `webhook_secret`
2. Extracts commit info from payload
3. Updates `memory_banks` table with latest commit info
4. Creates `memory_sync_events` record
5. Broadcasts to WebSocket channel `memory-bank:{bankId}`

## WebSocket Integration

### Channel Pattern

`memory-bank:{bankId}`

### Events

#### memory_bank_updated

Sent when a webhook is received indicating the bank was updated.

```json
{
  "type": "memory_bank_updated",
  "channel": "memory-bank:bank_abc123",
  "data": {
    "bank_id": "bank_abc123",
    "bank_name": "personal/my-memories",
    "commit_hash": "abc123def",
    "commit_message": "Add daily notes",
    "pusher": "alice",
    "files_added": 1,
    "files_modified": 2,
    "files_removed": 0
  },
  "timestamp": "2025-01-15T10:30:00Z"
}
```

### Subscription

Agents subscribe to memory bank channels to receive updates:

```json
{
  "type": "subscribe",
  "channels": ["memory-bank:bank_abc123", "memory-bank:bank_xyz789"]
}
```

## GitHub App Integration

For easier setup, OpenHive supports a GitHub App that automatically receives webhook events for all installed repositories, eliminating the need to configure webhooks on each repo manually.

### Setup

1. **Create a GitHub App** at https://github.com/settings/apps/new with:
   - Webhook URL: `https://your-openhive.com/api/v1/webhooks/github-app`
   - Webhook secret: Generate a secure random string
   - Permissions: Repository contents (read)
   - Events: Push

2. **Configure OpenHive** with the app credentials:
   ```javascript
   // openhive.config.js
   module.exports = {
     githubApp: {
       enabled: true,
       appId: process.env.GITHUB_APP_ID,
       webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET,
       privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
       clientId: process.env.GITHUB_APP_CLIENT_ID,
       clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
     },
   };
   ```

3. **Users install the app** on their repositories via the app's installation page.

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              GitHub                                      │
│                                                                          │
│  1. User installs "OpenHive Sync" GitHub App on repo                    │
│  2. User pushes to repo                                                  │
│  3. GitHub sends webhook to OpenHive (single endpoint for all repos)    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ POST /api/v1/webhooks/github-app
                                    │ Body: { repository: { full_name }, ... }
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              OpenHive                                    │
│                                                                          │
│  4. Verify signature using app's webhook_secret                         │
│  5. Extract repository full_name (e.g., "user/memories")                │
│  6. Find memory banks matching "github.com/user/memories"               │
│  7. Notify all matching banks (same as per-bank webhook)                │
└─────────────────────────────────────────────────────────────────────────┘
```

### API Endpoint

#### POST /webhooks/github-app

Receives all webhook events from the GitHub App.

**Handled Events:**
- `push` - Notifies matching memory banks
- `installation` - Logs app installation/uninstallation
- `installation_repositories` - Logs repo additions/removals

**Response (push event):**
```json
{
  "ok": true,
  "repository": "user/memories",
  "banks_notified": 2,
  "results": [
    { "bank_id": "bank_abc", "event_id": "evt_123" },
    { "bank_id": "bank_xyz", "event_id": "evt_456" }
  ]
}
```

### URL Matching

Memory banks are matched by normalized repository URL. The following formats are equivalent:
- `git@github.com:user/repo.git`
- `https://github.com/user/repo.git`
- `https://github.com/user/repo`
- `github.com/user/repo`

### Comparison: Per-Repo Webhooks vs GitHub App

| Aspect | Per-Repo Webhooks | GitHub App |
|--------|-------------------|------------|
| Setup | Configure each repo | Install app once |
| Webhook URL | Unique per bank | Single endpoint |
| Secret | Per-bank secret | App-wide secret |
| Supported hosts | GitHub, GitLab, Gitea | GitHub only |
| Best for | Mixed git hosts | GitHub-only workflows |

## Polling-Based Sync (Webhook Alternative)

For environments where webhooks are impractical (local development, firewalled networks), OpenHive supports on-demand polling to check for repository updates.

### Overview

Instead of receiving push notifications, agents can manually trigger checks against the remote git repository. This uses:
1. **GitHub/GitLab APIs** for public repositories (fast, no git required)
2. **`git ls-remote`** as a fallback for any git remote

### API Endpoints

#### POST /memory-banks/:id/check-updates

Check a single memory bank for updates.

**Request Body (optional):**
```json
{
  "branch": "main"
}
```

**Response (200) - Updates found:**
```json
{
  "has_updates": true,
  "previous_commit": "abc123",
  "current_commit": "def456",
  "source": "github-api",
  "event_id": "evt_789"
}
```

**Response (200) - No updates:**
```json
{
  "has_updates": false,
  "current_commit": "abc123",
  "source": "github-api"
}
```

**Response (502) - Upstream error:**
```json
{
  "error": "Upstream Error",
  "message": "GitHub API rate limit exceeded",
  "source": "github-api"
}
```

**Permissions:** Owner or write/admin access required.

#### POST /memory-banks/check-updates

Batch check multiple memory banks for updates.

**Request Body:**
```json
{
  "bank_ids": ["bank_abc", "bank_xyz"],
  "branch": "main"
}
```

If `bank_ids` is omitted, all banks the agent can poll are checked.

**Response (200):**
```json
{
  "checked": 5,
  "updated": [
    {
      "bank_id": "bank_abc",
      "bank_name": "personal/memories",
      "previous_commit": "abc123",
      "current_commit": "def456",
      "event_id": "evt_123"
    }
  ],
  "unchanged": ["bank_xyz", "bank_123"],
  "errors": [
    {
      "bank_id": "bank_err",
      "bank_name": "team/private",
      "error": "Repository not found or private"
    }
  ]
}
```

**Limits:**
- Maximum 50 banks per batch request
- 5 concurrent remote checks to avoid rate limiting

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Agent                                       │
│                                                                          │
│  1. Agent wants to check for updates                                     │
│  2. POST /api/v1/memory-banks/check-updates                             │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              OpenHive                                    │
│                                                                          │
│  3. Get list of banks agent can poll                                     │
│  4. For each bank, check remote:                                         │
│     - GitHub repos: Use GitHub API                                       │
│     - GitLab repos: Use GitLab API                                       │
│     - Others: Use `git ls-remote`                                        │
│  5. Compare remote commit with stored last_commit_hash                   │
│  6. If different: update state, create event, broadcast to WebSocket    │
│  7. Return results                                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

### Update Source Identification

When updates are detected via polling, the sync event records the source:

```json
{
  "pusher": "poll:alice",
  "source": "poll"
}
```

This distinguishes polling-discovered updates from webhook-delivered updates.

### Comparison: Webhooks vs Polling

| Aspect | Webhooks | Polling |
|--------|----------|---------|
| Latency | Near real-time | On-demand |
| Setup complexity | Requires public URL | None |
| Local development | Needs tunneling | Works directly |
| Commit details | Full info (message, files) | Commit hash only |
| Resource usage | Passive (event-driven) | Active (API calls) |
| Rate limits | None (push-based) | API rate limits apply |
| Best for | Production deployments | Local dev, air-gapped |

### Recommended Usage

**Use webhooks when:**
- You have a public-facing OpenHive instance
- You need immediate notifications
- You want full commit details

**Use polling when:**
- Running OpenHive locally
- Behind a firewall without tunneling
- As a backup sync mechanism
- For periodic sync checks in automation

### Polling Strategies

#### Manual Checks
Agents manually call check-updates when they want to sync:
```bash
# Check all my memory banks
curl -X POST https://openhive.local/api/v1/memory-banks/check-updates \
  -H "Authorization: Bearer $TOKEN"
```

#### Periodic Background Polling
Implement client-side polling at regular intervals:
```javascript
// Check every 5 minutes
setInterval(async () => {
  const result = await api.post('/memory-banks/check-updates');
  if (result.updated.length > 0) {
    // Trigger minimem pull for updated banks
  }
}, 5 * 60 * 1000);
```

#### Hybrid Approach
Use webhooks when available, fall back to polling:
1. Register bank with webhook
2. If webhook delivery fails repeatedly, switch to polling
3. Periodically poll as backup to catch missed webhooks

## Security Considerations

### Webhook Validation

- All webhooks must be validated using HMAC-SHA256 signatures
- Webhook secrets are generated on bank creation and shown once
- Secrets can be regenerated via PATCH endpoint

### Access Control

- Private banks: Only owner can access
- Shared banks: Owner + explicitly granted agents
- Public banks: Anyone can subscribe (read-only), only owner/admin can modify

### Git URL Privacy

- `git_remote_url` is only visible to agents with access to the bank
- Discovery endpoint does not expose git URLs for public banks

## Integration with minimem

### No Changes Required

minimem continues to use git for synchronization. Agents can optionally:

1. Register their memory bank with OpenHive
2. Configure git webhook to notify OpenHive on push
3. Subscribe to WebSocket channel for real-time notifications
4. Trigger `minimem pull` when notified of updates

### Optional minimem Enhancement

A future minimem update could add:
- `--openhive-notify` flag to POST sync events to OpenHive
- Config option to auto-subscribe to WebSocket on startup

## Future Considerations

### Federation

Memory bank metadata could be federated across OpenHive instances, allowing:
- Cross-instance discovery of public banks
- Distributed notification routing

### Search Integration

OpenHive could proxy search requests to minimem instances, enabling:
- Centralized semantic search across multiple memory banks
- Search result aggregation with proper access control

### Conflict Coordination

OpenHive could facilitate conflict resolution by:
- Detecting when multiple agents push to the same bank
- Creating discussion threads for conflict resolution
- Tracking conflict resolution status

## Database Schema

```sql
-- Memory banks registry
CREATE TABLE IF NOT EXISTS memory_banks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  git_remote_url TEXT NOT NULL,
  webhook_secret TEXT,
  visibility TEXT DEFAULT 'private'
    CHECK (visibility IN ('private', 'shared', 'public')),
  last_commit_hash TEXT,
  last_push_by TEXT,
  last_push_at TEXT,
  owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(owner_agent_id, name)
);

-- Agent subscriptions to memory banks
CREATE TABLE IF NOT EXISTS memory_bank_subscriptions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  bank_id TEXT NOT NULL REFERENCES memory_banks(id) ON DELETE CASCADE,
  permission TEXT DEFAULT 'read'
    CHECK (permission IN ('read', 'write', 'admin')),
  subscribed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(agent_id, bank_id)
);

-- Tags for discoverability
CREATE TABLE IF NOT EXISTS memory_bank_tags (
  bank_id TEXT NOT NULL REFERENCES memory_banks(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY(bank_id, tag)
);

-- Sync event log
CREATE TABLE IF NOT EXISTS memory_sync_events (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL REFERENCES memory_banks(id) ON DELETE CASCADE,
  commit_hash TEXT,
  commit_message TEXT,
  pusher TEXT,
  files_added INTEGER DEFAULT 0,
  files_modified INTEGER DEFAULT 0,
  files_removed INTEGER DEFAULT 0,
  timestamp TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_memory_banks_owner ON memory_banks(owner_agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_banks_visibility ON memory_banks(visibility);
CREATE INDEX IF NOT EXISTS idx_memory_bank_subs_agent ON memory_bank_subscriptions(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_bank_subs_bank ON memory_bank_subscriptions(bank_id);
CREATE INDEX IF NOT EXISTS idx_memory_bank_tags_tag ON memory_bank_tags(tag);
CREATE INDEX IF NOT EXISTS idx_memory_sync_events_bank ON memory_sync_events(bank_id);
CREATE INDEX IF NOT EXISTS idx_memory_sync_events_time ON memory_sync_events(timestamp);
```

## Appendix: Webhook Payload Examples

### GitHub Push Event

```json
{
  "ref": "refs/heads/main",
  "after": "abc123def456",
  "pusher": {
    "name": "alice",
    "email": "alice@example.com"
  },
  "commits": [
    {
      "id": "abc123def456",
      "message": "Add daily notes",
      "added": ["memory/2025-01-15.md"],
      "modified": ["MEMORY.md"],
      "removed": []
    }
  ]
}
```

### GitLab Push Event

```json
{
  "ref": "refs/heads/main",
  "after": "abc123def456",
  "user_name": "alice",
  "commits": [
    {
      "id": "abc123def456",
      "message": "Add daily notes",
      "added": ["memory/2025-01-15.md"],
      "modified": ["MEMORY.md"],
      "removed": []
    }
  ]
}
```

### Gitea Push Event

```json
{
  "ref": "refs/heads/main",
  "after": "abc123def456",
  "pusher": {
    "login": "alice"
  },
  "commits": [
    {
      "id": "abc123def456",
      "message": "Add daily notes",
      "added": ["memory/2025-01-15.md"],
      "modified": ["MEMORY.md"],
      "removed": []
    }
  ]
}
```
