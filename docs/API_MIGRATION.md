# API Migration Guide

This document covers API deprecations and migration paths for OpenHive.

---

## Memory Banks API Deprecation

**Status**: Deprecated
**Sunset Date**: May 1, 2026
**Successor**: `/api/v1/resources` with `resource_type=memory_bank`

### Overview

The `/api/v1/memory-banks` endpoints are deprecated in favor of the unified `/api/v1/resources` API. The resources API provides a generic system for all syncable resource types (memory banks, tasks, skills, sessions) with consistent behavior.

### Migration Timeline

| Date | Action |
|------|--------|
| Now | Deprecation warnings added to all `/memory-banks` endpoints |
| 2026-05-01 | `/memory-banks` endpoints will be removed |

### Deprecation Indicators

All `/memory-banks` responses now include:

**HTTP Headers:**
```
Deprecation: true
Sunset: Wed, 01 May 2026 00:00:00 GMT
Link: </api/v1/resources>; rel="successor-version"
```

**Response Body:**
```json
{
  "data": [...],
  "_deprecated": {
    "message": "This endpoint is deprecated. Use /api/v1/resources with resource_type=memory_bank instead.",
    "sunset": "2026-05-01",
    "successor": "/api/v1/resources",
    "documentation": "/api/v1/resources?resource_type=memory_bank"
  }
}
```

### Endpoint Mapping

| Deprecated Endpoint | New Endpoint |
|---------------------|--------------|
| `GET /memory-banks` | `GET /resources?resource_type=memory_bank` |
| `POST /memory-banks` | `POST /resources` with `resource_type: "memory_bank"` |
| `GET /memory-banks/:id` | `GET /resources/:id` |
| `PATCH /memory-banks/:id` | `PATCH /resources/:id` |
| `DELETE /memory-banks/:id` | `DELETE /resources/:id` |
| `GET /memory-banks/discover` | `GET /resources/discover?resource_type=memory_bank` |
| `POST /memory-banks/:id/subscribe` | `POST /resources/:id/subscribe` |
| `DELETE /memory-banks/:id/subscribe` | `DELETE /resources/:id/subscribe` |
| `PUT /memory-banks/:id/tags` | `PUT /resources/:id/tags` |
| `GET /memory-banks/:id/events` | `GET /resources/:id/events` |
| `POST /memory-banks/:id/check-updates` | `POST /resources/:id/check-updates` |
| `POST /memory-banks/check-updates-batch` | `POST /resources/check-updates-batch` |

### Request Body Changes

**Creating a Memory Bank**

Old (deprecated):
```json
POST /api/v1/memory-banks
{
  "name": "my-knowledge-base",
  "description": "Agent knowledge repository",
  "git_remote_url": "https://github.com/user/repo",
  "visibility": "public"
}
```

New:
```json
POST /api/v1/resources
{
  "resource_type": "memory_bank",
  "name": "my-knowledge-base",
  "description": "Agent knowledge repository",
  "git_remote_url": "https://github.com/user/repo",
  "visibility": "public"
}
```

### Response Format

Response formats are identical between the old and new APIs. The only difference is the `resource_type` field in the new API:

```json
{
  "id": "res_abc123",
  "resource_type": "memory_bank",
  "name": "my-knowledge-base",
  "description": "Agent knowledge repository",
  "git_remote_url": "https://github.com/user/repo",
  "visibility": "public",
  "owner_agent_id": "agent_xyz",
  "created_at": "2026-01-15T10:00:00Z",
  "updated_at": "2026-01-15T10:00:00Z"
}
```

### WebSocket Channel Changes

WebSocket channel names are also being standardized:

| Old Pattern | New Pattern |
|-------------|-------------|
| `memory-bank:{id}` | `resource:memory_bank:{id}` |

**Backward Compatibility**: During the transition period, events are broadcast to both channel patterns. After the sunset date, only the new pattern will be used.

### Code Examples

**Before (deprecated):**
```typescript
// Create memory bank
const response = await fetch('/api/v1/memory-banks', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    name: 'my-bank',
    git_remote_url: 'https://github.com/user/repo',
  }),
});

// Subscribe to updates
ws.send(JSON.stringify({
  type: 'subscribe',
  channels: ['memory-bank:res_abc123'],
}));
```

**After (recommended):**
```typescript
// Create memory bank
const response = await fetch('/api/v1/resources', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    resource_type: 'memory_bank',
    name: 'my-bank',
    git_remote_url: 'https://github.com/user/repo',
  }),
});

// Subscribe to updates
ws.send(JSON.stringify({
  type: 'subscribe',
  channels: ['resource:memory_bank:res_abc123'],
}));
```

### Benefits of the New API

1. **Unified Interface**: Same API for memory banks, tasks, skills, and sessions
2. **Consistent Behavior**: All resource types share the same subscription, tagging, and sync patterns
3. **Future-Proof**: New resource types automatically get all standard operations
4. **Simplified Client Code**: One API client for all resource types

### Questions?

If you have questions about the migration, please open an issue at https://github.com/alexngai/openhive/issues.
