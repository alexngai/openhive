import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Memory } from '../../pages/Memory';

// ── Mock data ──

const mockResources = [
  {
    id: 'res-mem-1',
    resource_type: 'memory_bank' as const,
    name: 'agent/minimem-memory',
    description: 'Local memory bank',
    visibility: 'private',
    scope: 'agent',
    sync_strategy: 'local',
    last_push_at: '2026-03-27T10:00:00Z',
    metadata: null,
    owner: { id: 'a1', name: 'local' },
    tags: [],
    subscriber_count: 1,
    is_subscribed: true,
  },
  {
    id: 'res-mem-2',
    resource_type: 'memory_bank' as const,
    name: 'team/shared-memory',
    description: 'Shared team memory',
    visibility: 'shared',
    scope: 'project',
    sync_strategy: 'ls-remote',
    last_push_at: null,
    metadata: null,
    owner: { id: 'a1', name: 'local' },
    tags: [],
    subscriber_count: 2,
    is_subscribed: true,
  },
];

const mockFiles = [
  { path: 'MEMORY.md', size: 200, modified: '2026-03-27T10:00:00Z' },
  { path: 'memory/2026-03-27.md', size: 500, modified: '2026-03-27T14:00:00Z' },
];

// ── Mock hooks ──

const mockUseResourcesByType = vi.fn();
const mockUseMemoryFiles = vi.fn();
const mockUseKnowledgeGraphFull = vi.fn();

vi.mock('../../hooks/useApi', () => ({
  useResourcesByType: (...args: unknown[]) => mockUseResourcesByType(...args),
  useMemoryFiles: (...args: unknown[]) => mockUseMemoryFiles(...args),
  useKnowledgeGraphFull: (...args: unknown[]) => mockUseKnowledgeGraphFull(...args),
}));

vi.mock('../../hooks/useRealtimeInvalidation', () => ({
  useResourcesRealtime: vi.fn(),
}));

vi.mock('../../hooks/useWebSocket', () => ({
  useSubscribe: vi.fn(),
  useWSEvent: vi.fn(),
}));

// ── Helpers ──

function renderMemory() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Memory />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// ── Tests ──

describe('Memory Page', () => {
  beforeEach(() => {
    mockUseResourcesByType.mockReturnValue({
      data: { data: mockResources, total: 2 },
      isLoading: false,
    });
    mockUseMemoryFiles.mockReturnValue({ data: mockFiles, isLoading: false });
    mockUseKnowledgeGraphFull.mockReturnValue({ data: { results: [], total: 0 }, isLoading: false });
  });

  describe('Header', () => {
    it('renders the page title', () => {
      renderMemory();
      expect(screen.getByRole('heading', { name: 'Memory' })).toBeDefined();
    });

    it('shows resource count', () => {
      renderMemory();
      expect(screen.getByText(/2 banks/)).toBeDefined();
    });
  });

  describe('Resource cards', () => {
    it('renders a card for each memory bank', () => {
      renderMemory();
      expect(screen.getByText('agent/minimem-memory')).toBeDefined();
      expect(screen.getByText('team/shared-memory')).toBeDefined();
    });

    it('shows descriptions', () => {
      renderMemory();
      expect(screen.getByText('Local memory bank')).toBeDefined();
      expect(screen.getByText('Shared team memory')).toBeDefined();
    });

    it('shows scope labels', () => {
      renderMemory();
      expect(screen.getByText('agent')).toBeDefined();
      expect(screen.getByText('project')).toBeDefined();
    });

    it('links to detail page', () => {
      renderMemory();
      const links = screen.getAllByRole('link');
      const memLinks = links.filter(l => l.getAttribute('href')?.startsWith('/memory/'));
      expect(memLinks.length).toBe(2);
      expect(memLinks[0].getAttribute('href')).toBe('/memory/res-mem-1');
    });
  });

  describe('Empty state', () => {
    it('shows empty state when no resources', () => {
      mockUseResourcesByType.mockReturnValue({
        data: { data: [], total: 0 },
        isLoading: false,
      });
      renderMemory();
      expect(screen.getByText('No memory banks yet')).toBeDefined();
    });
  });

  describe('Loading state', () => {
    it('shows loader while loading', () => {
      mockUseResourcesByType.mockReturnValue({
        data: undefined,
        isLoading: true,
      });
      renderMemory();
      // PageLoader renders a spinner — just verify no cards are shown
      expect(screen.queryByText('agent/minimem-memory')).toBeNull();
    });
  });

  describe('API calls', () => {
    it('fetches memory_bank resources', () => {
      renderMemory();
      expect(mockUseResourcesByType).toHaveBeenCalledWith('memory_bank');
    });
  });
});
