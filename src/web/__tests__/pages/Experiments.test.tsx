// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Experiment } from '../../hooks/useExperiments';

// ── Mocks ──

const mockUseExperiments = vi.fn();

vi.mock('../../hooks/useExperiments', async () => {
  const actual = await vi.importActual('../../hooks/useExperiments');
  return {
    ...actual,
    useExperiments: (...args: unknown[]) => mockUseExperiments(...args),
  };
});

vi.mock('../../hooks/useExperimentsRealtime', () => ({
  useExperimentsRealtime: vi.fn(),
}));

vi.mock('../../components/common/TimeAgo', () => ({
  TimeAgo: ({ date }: { date: string }) => <span>{date}</span>,
}));

import { Experiments } from '../../pages/Experiments';

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/experiments']}>
        <Experiments />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function makeExperiment(over: Partial<Experiment> = {}): Experiment {
  return {
    id: 'exp_abc',
    hive_id: 'default-general',
    name: 'optimize eval score',
    description: null,
    content_hash: null,
    objective_metric: 'eval.score',
    objective_direction: 'increase',
    objective_min_delta: 0,
    claims: null,
    config: {},
    repo_resource_id: null,
    status: 'active',
    incumbent_candidate_id: null,
    initiator_type: 'user',
    initiator_id: 'admin',
    created_at: '2026-06-24T00:00:00.000Z',
    updated_at: '2026-06-24T00:00:00.000Z',
    ...over,
  };
}

describe('Experiments list page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the loading state', () => {
    mockUseExperiments.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderPage();
    expect(screen.getByLabelText('Loading')).toBeDefined();
  });

  it('renders the empty state when there are no experiments', () => {
    mockUseExperiments.mockReturnValue({
      data: { data: [], total: 0, limit: 100, offset: 0 },
      isLoading: false,
      error: null,
    });
    renderPage();
    expect(screen.getByText('No experiments yet')).toBeDefined();
  });

  it('renders the error state', () => {
    mockUseExperiments.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
    });
    renderPage();
    expect(screen.getByText(/Failed to load experiments: boom/)).toBeDefined();
  });

  it('renders a row per experiment with its name and metric', () => {
    mockUseExperiments.mockReturnValue({
      data: {
        data: [
          makeExperiment({ id: 'exp_1', name: 'first exp' }),
          makeExperiment({ id: 'exp_2', name: 'second exp', status: 'paused' }),
        ],
        total: 2,
        limit: 100,
        offset: 0,
      },
      isLoading: false,
      error: null,
    });
    renderPage();
    expect(screen.getByText('first exp')).toBeDefined();
    expect(screen.getByText('second exp')).toBeDefined();
    // objective metric appears in each row
    expect(screen.getAllByText('eval.score').length).toBe(2);
  });

  it('shows the "exploratory" provenance badge for a null content_hash', () => {
    mockUseExperiments.mockReturnValue({
      data: {
        data: [makeExperiment({ content_hash: null })],
        total: 1,
        limit: 100,
        offset: 0,
      },
      isLoading: false,
      error: null,
    });
    renderPage();
    // Honesty rule: a null content_hash never renders a fabricated lock.
    expect(screen.getByText('exploratory')).toBeDefined();
    expect(screen.queryByText(/locked/)).toBeNull();
  });

  it('shows a "locked" provenance badge with a short hash when content_hash is present', () => {
    mockUseExperiments.mockReturnValue({
      data: {
        data: [makeExperiment({ content_hash: 'sha256:deadbeefcafe' })],
        total: 1,
        limit: 100,
        offset: 0,
      },
      isLoading: false,
      error: null,
    });
    renderPage();
    expect(screen.getByText(/locked · deadbeef/)).toBeDefined();
  });
});
