import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Skills } from '../../pages/Skills';

// ── Mock data ──

const mockResources = [
  {
    id: 'res-skill-1',
    resource_type: 'skill' as const,
    name: 'project/skilltree',
    description: 'Project skill library',
    visibility: 'shared',
    scope: 'project',
    sync_strategy: 'local',
    last_push_at: '2026-03-27T10:00:00Z',
    metadata: null,
    owner: { id: 'a1', name: 'local' },
    tags: [],
    subscriber_count: 1,
    is_subscribed: true,
  },
];

const mockSkills = [
  { id: 'tdd', name: 'Test-Driven Development', version: '1.0.0', status: 'active', description: 'Write tests first', tags: ['testing'], author: 'agent-v1', path: 'skills/tdd/SKILL.md' },
  { id: 'code-review', name: 'Code Review', version: '0.5.0', status: 'draft', description: 'Review patterns', tags: ['quality'], author: 'agent-v2', path: 'skills/code-review/SKILL.md' },
  { id: 'debugging', name: 'Debugging Workflow', version: '2.0.0', status: 'active', description: 'Debug systematically', tags: ['debugging'], author: 'agent-v1', path: 'skills/debugging/SKILL.md' },
];

// ── Mock hooks ──

const mockUseResourcesByType = vi.fn();
const mockUseSkillsList = vi.fn();

vi.mock('../../hooks/useApi', () => ({
  useResourcesByType: (...args: unknown[]) => mockUseResourcesByType(...args),
  useSkillsList: (...args: unknown[]) => mockUseSkillsList(...args),
}));

vi.mock('../../hooks/useRealtimeInvalidation', () => ({
  useResourcesRealtime: vi.fn(),
}));

vi.mock('../../hooks/useWebSocket', () => ({
  useSubscribe: vi.fn(),
  useWSEvent: vi.fn(),
}));

// ── Helpers ──

function renderSkills() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Skills />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// ── Tests ──

describe('Skills Page', () => {
  beforeEach(() => {
    mockUseResourcesByType.mockReturnValue({
      data: { data: mockResources, total: 1 },
      isLoading: false,
    });
    mockUseSkillsList.mockReturnValue({ data: mockSkills, isLoading: false });
  });

  describe('Header', () => {
    it('renders the page title', () => {
      renderSkills();
      expect(screen.getByRole('heading', { name: 'Skills' })).toBeDefined();
    });

    it('shows resource count', () => {
      renderSkills();
      // Shared ListFilters toolbar labels skill lists as "libraries".
      expect(screen.getByText(/1 library/)).toBeDefined();
    });
  });

  describe('Resource cards', () => {
    it('renders a card for each skill resource', () => {
      renderSkills();
      expect(screen.getByText('project/skilltree')).toBeDefined();
    });

    it('shows description', () => {
      renderSkills();
      expect(screen.getByText('Project skill library')).toBeDefined();
    });

    it('shows active skill count', () => {
      renderSkills();
      expect(screen.getByText(/2 active/)).toBeDefined();
    });

    it('shows other (non-active) skill count', () => {
      renderSkills();
      expect(screen.getByText(/1 other/)).toBeDefined();
    });

    it('links to detail page', () => {
      renderSkills();
      const links = screen.getAllByRole('link');
      const skillLinks = links.filter(l => l.getAttribute('href')?.startsWith('/skills/'));
      expect(skillLinks.length).toBe(1);
      expect(skillLinks[0].getAttribute('href')).toBe('/skills/res-skill-1');
    });
  });

  describe('Empty state', () => {
    it('shows empty state when no resources', () => {
      mockUseResourcesByType.mockReturnValue({
        data: { data: [], total: 0 },
        isLoading: false,
      });
      renderSkills();
      expect(screen.getByText('No skill libraries yet')).toBeDefined();
    });
  });

  describe('API calls', () => {
    it('fetches skill resources', () => {
      renderSkills();
      expect(mockUseResourcesByType).toHaveBeenCalledWith('skill');
    });
  });
});
