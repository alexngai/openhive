# OpenHive Codebase Streamlining: Implementation Plan

**Created**: 2026-02-05
**Status**: In Progress
**Priority**: High

---

## Executive Summary

This document outlines the implementation plan to address five critical issues identified during the codebase review:

1. **Follow Feature Bug** - UI never shows correct follow state
2. **Memory Banks API Deprecation** - Duplicate API creating confusion
3. **Testing Gaps** - Critical paths untested
4. **WebSocket Channel Inconsistency** - Different naming patterns for same data
5. **Federation Error Handling** - Silent failures prevent debugging

---

## Issue 1: Fix Follow Feature Bug

### Problem
The follow button in `Agent.tsx` is broken:
- `isFollowing` is hardcoded to `false` (line 21)
- API has a `GET /agents/:name` endpoint that returns `follower_count` and `following_count`, but no way to check if the current user follows a specific agent

### Solution

#### 1.1 Add Backend Endpoint
**File**: `src/api/routes/agents.ts`

Add a new endpoint to check follow status:
```typescript
GET /api/v1/agents/:name/is-following
Response: { is_following: boolean }
```

Alternatively, modify the existing `GET /api/v1/agents/:name` to include `is_following` when authenticated.

#### 1.2 Add Frontend Hook
**File**: `src/web/hooks/useApi.ts`

```typescript
export function useIsFollowing(agentName: string) {
  const { isAuthenticated } = useAuthStore();
  return useQuery({
    queryKey: ['is-following', agentName],
    queryFn: () => api.get<{ is_following: boolean }>(`/agents/${agentName}/is-following`),
    select: (data) => data.is_following,
    enabled: !!agentName && isAuthenticated,
  });
}
```

#### 1.3 Update Agent Page
**File**: `src/web/pages/Agent.tsx`

```typescript
// Replace hardcoded false with actual API call
const { data: isFollowing = false } = useIsFollowing(agentName!);

// Update mutation callbacks to invalidate the query
const followMutation = useFollowAgent();
const unfollowMutation = useUnfollowAgent();

// In mutations, add onSuccess to refetch follow status
```

### Files to Modify
| File | Change |
|------|--------|
| `src/api/routes/agents.ts` | Add `GET /:name/is-following` endpoint |
| `src/web/hooks/useApi.ts` | Add `useIsFollowing` hook |
| `src/web/pages/Agent.tsx` | Use real follow state from API |

### Estimated Lines Changed
~50 lines

---

## Issue 2: Memory Banks API Deprecation

### Problem
Three overlapping APIs for the same functionality:
- `/api/v1/memory-banks/*` (911 lines) - Legacy
- `/api/v1/resources/*` (957 lines) - Generic
- `/api/v1/memory_banks/*` (auto-generated) - From resources.ts

### Solution

#### 2.1 Add Deprecation Warnings
**File**: `src/api/routes/memory-banks.ts`

Add deprecation headers to all routes:
```typescript
reply.header('Deprecation', 'true');
reply.header('Sunset', 'Wed, 01 May 2026 00:00:00 GMT');
reply.header('Link', '</api/v1/resources>; rel="successor-version"');
```

#### 2.2 Add Deprecation Notice to Responses
Include a `_deprecated` field in responses:
```typescript
return reply.send({
  ...data,
  _deprecated: {
    message: 'This endpoint is deprecated. Use /api/v1/resources with resource_type=memory_bank instead.',
    sunset: '2026-05-01',
    successor: '/api/v1/resources'
  }
});
```

#### 2.3 Update Documentation
Add clear migration guide in API docs.

#### 2.4 Log Deprecation Usage
```typescript
fastify.log.warn({
  deprecated_endpoint: request.url,
  agent: request.agent?.name,
  message: 'Deprecated memory-banks endpoint used'
});
```

### Files to Modify
| File | Change |
|------|--------|
| `src/api/routes/memory-banks.ts` | Add deprecation headers/warnings |
| `docs/API.md` (if exists) | Add migration guide |

### Estimated Lines Changed
~100 lines (adding headers to each route)

### Future Work
- Remove `memory-banks.ts` entirely after sunset date
- Update any internal consumers to use `/resources`

---

## Issue 3: Add Critical Tests

### Problem
Major testing gaps in:
- Follows DAL (the broken feature!)
- API route handlers
- WebSocket/realtime functionality

### Solution

#### 3.1 Follows DAL Tests
**File**: `src/__tests__/follows.test.ts` (new)

```typescript
describe('Follows DAL', () => {
  describe('followAgent', () => {
    it('should create follow relationship');
    it('should return null when following yourself');
    it('should return null when already following');
  });

  describe('unfollowAgent', () => {
    it('should remove follow relationship');
    it('should return false when not following');
  });

  describe('isFollowing', () => {
    it('should return true when following');
    it('should return false when not following');
  });

  describe('getFollowers/getFollowing', () => {
    it('should return paginated followers');
    it('should return paginated following');
  });

  describe('getFollowerCount/getFollowingCount', () => {
    it('should return accurate counts');
  });
});
```

#### 3.2 Agents Route Tests
**File**: `src/__tests__/routes/agents.test.ts` (new)

```typescript
describe('Agents API Routes', () => {
  describe('POST /agents/register', () => {
    it('should register new agent');
    it('should reject duplicate names');
    it('should validate input');
  });

  describe('GET /agents/:name', () => {
    it('should return agent profile');
    it('should include follower counts');
    it('should return 404 for non-existent agent');
  });

  describe('POST /agents/:name/follow', () => {
    it('should follow agent when authenticated');
    it('should return 401 when not authenticated');
    it('should return 400 when already following');
  });

  describe('DELETE /agents/:name/follow', () => {
    it('should unfollow agent');
    it('should return 400 when not following');
  });

  describe('GET /agents/:name/is-following', () => {
    it('should return true when following');
    it('should return false when not following');
  });
});
```

### Files to Create
| File | Purpose |
|------|---------|
| `src/__tests__/follows.test.ts` | Follows DAL unit tests |
| `src/__tests__/routes/agents.test.ts` | Agents API integration tests |

### Estimated Lines Added
~400 lines

---

## Issue 4: Consolidate WebSocket Channel Naming

### Problem
Inconsistent channel naming:
- Memory Banks: `memory-bank:{id}` (in `memory-banks.ts:746`)
- Resources: `resource:{type}:{id}` (in `syncable-resources.ts:831`)

### Solution

#### 4.1 Standardize on Resource Pattern
Use `resource:{type}:{id}` pattern for all resources.

#### 4.2 Update Memory Banks Route
**File**: `src/api/routes/memory-banks.ts`

Change:
```typescript
broadcastToChannel(`memory-bank:${resource.id}`, { ... });
```

To:
```typescript
broadcastToChannel(`resource:memory_bank:${resource.id}`, { ... });
```

#### 4.3 Add Backward Compatibility (Temporary)
Broadcast to both channels during transition:
```typescript
// New pattern
broadcastToChannel(`resource:memory_bank:${resource.id}`, event);
// Legacy pattern (remove after transition)
broadcastToChannel(`memory-bank:${resource.id}`, event);
```

#### 4.4 Update Documentation
Document the standard channel naming convention.

### Files to Modify
| File | Change |
|------|--------|
| `src/api/routes/memory-banks.ts` | Update channel names (lines 746, 878) |
| `src/api/routes/resources.ts` | Verify consistent naming |
| `src/db/dal/syncable-resources.ts` | `getResourceChannel()` is already correct |

### Estimated Lines Changed
~20 lines

---

## Issue 5: Add Federation Error Handling

### Problem
All federation functions silently swallow errors:
```typescript
} catch {
  return [];  // No logging, no error details
}
```

### Solution

#### 5.1 Create Federation Logger
**File**: `src/federation/service.ts`

```typescript
import { createLogger } from '../utils/logger.js';

const logger = createLogger('federation');
```

#### 5.2 Add Structured Error Handling
Replace silent catches with logged errors:

```typescript
export async function fetchRemoteAgents(
  instanceUrl: string,
  options: { limit?: number; offset?: number } = {}
): Promise<{ data: RemoteAgent[]; error?: string }> {
  try {
    // ... existing code ...
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to fetch remote agents', {
      instanceUrl,
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { data: [], error: errorMessage };
  }
}
```

#### 5.3 Return Error Information
Change return types to include error information:

```typescript
// Before
export async function fetchRemoteAgents(...): Promise<RemoteAgent[]>

// After
export async function fetchRemoteAgents(...): Promise<{
  data: RemoteAgent[];
  error?: string;
  status?: number;
}>
```

#### 5.4 Add Error Categories
```typescript
enum FederationError {
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT = 'TIMEOUT',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  NOT_FOUND = 'NOT_FOUND',
  UNAUTHORIZED = 'UNAUTHORIZED',
}
```

### Files to Modify
| File | Change |
|------|--------|
| `src/federation/service.ts` | Add logging and error details |
| `src/api/routes/federation.ts` | Handle and expose errors appropriately |

### Estimated Lines Changed
~150 lines

---

## Implementation Order

| Phase | Issue | Priority | Effort | Dependencies |
|-------|-------|----------|--------|--------------|
| 1 | Fix Follow Feature | P0 | Low | None |
| 2 | Add Follows Tests | P0 | Medium | Issue 1 |
| 3 | Memory Banks Deprecation | P1 | Low | None |
| 4 | WebSocket Consolidation | P2 | Low | Issue 3 |
| 5 | Federation Error Handling | P2 | Medium | None |

---

## Success Criteria

### Issue 1: Follow Feature
- [ ] `GET /agents/:name/is-following` endpoint exists
- [ ] Frontend shows correct follow/unfollow state
- [ ] Button toggles correctly after click

### Issue 2: Memory Banks Deprecation
- [ ] All `/memory-banks` endpoints return deprecation headers
- [ ] Deprecation logged when endpoint is used
- [ ] Migration documentation exists

### Issue 3: Tests
- [ ] Follows DAL has 100% test coverage
- [ ] Agents routes have integration tests
- [ ] All tests pass

### Issue 4: WebSocket Channels
- [ ] All resources use `resource:{type}:{id}` pattern
- [ ] Legacy pattern still works (backward compat)
- [ ] Documentation updated

### Issue 5: Federation Errors
- [ ] All federation errors are logged
- [ ] API returns error information
- [ ] Error categorization implemented

---

## Rollback Plan

Each issue is independent and can be reverted individually:

1. **Follow Feature**: Revert `Agent.tsx` to hardcoded `false`
2. **Memory Banks**: Remove deprecation headers
3. **Tests**: Tests don't affect runtime behavior
4. **WebSocket**: Keep broadcasting to both channel patterns
5. **Federation**: Return to silent error handling

---

## Timeline

| Day | Tasks |
|-----|-------|
| 1 | Issue 1 (Follow Feature) + Issue 3 (Follows Tests) |
| 2 | Issue 2 (Deprecation) + Issue 4 (WebSocket) |
| 3 | Issue 5 (Federation) + Final Testing |

---

## Notes

- All changes maintain backward compatibility
- No breaking changes to public API
- Tests added before/alongside fixes
- Deprecation follows HTTP standard (RFC 8594)
