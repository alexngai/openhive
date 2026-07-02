// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Schedule, ScheduleDetailResponse } from '../../hooks/useSchedules';

const mockUseSchedule = vi.fn();
const mockMutation = vi.fn(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }));

vi.mock('../../hooks/useSchedules', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useSchedules')>(
    '../../hooks/useSchedules',
  );
  return {
    ...actual,
    useSchedule: (...args: unknown[]) => mockUseSchedule(...args),
    useUpdateSchedule: () => mockMutation(),
    usePauseSchedule: () => mockMutation(),
    useResumeSchedule: () => mockMutation(),
    useDeleteSchedule: () => mockMutation(),
    useCronPreview: () => ({
      data: { fires: ['2026-07-02T16:10:00.000Z'], timezone: 'UTC' },
      isLoading: false,
      error: null,
    }),
  };
});

vi.mock('../../hooks/useSchedulesRealtime', () => ({
  useSchedulesRealtime: vi.fn(),
}));

vi.mock('../../components/common/TimeAgo', () => ({
  TimeAgo: ({ date }: { date: string }) => <span>{date}</span>,
}));

vi.mock('../../components/common/LoadingSpinner', () => ({
  PageLoader: () => <div data-testid="page-loader">Loading...</div>,
}));

import { ScheduleDetail } from '../../pages/ScheduleDetail';

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/schedules/sch_exp']}>
        <Routes>
          <Route path="/schedules/:id" element={<ScheduleDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch_exp',
    cron: '*/5 * * * *',
    timezone: 'UTC',
    payload: { kind: 'experiment', experiment_ref: 'exp_live', run_controls: { cycles: 3 } },
    policy: { catchUp: 'fire-once', skipIfRunning: true },
    paused: false,
    next_fires_at: '2026-07-02T16:10:00.000Z',
    last_fired_at: null,
    hive_id: '',
    initiator_type: 'agent',
    initiator_id: 'agent_1',
    pause_reason: null,
    created_at: '2026-07-02T16:00:00.000Z',
    updated_at: '2026-07-02T16:00:00.000Z',
    ...overrides,
  };
}

describe('<ScheduleDetail />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders experiment schedule details without target_swarm_ids', () => {
    const response: ScheduleDetailResponse = {
      schedule: makeSchedule(),
      fires: [],
      fire_total: 0,
    };
    mockUseSchedule.mockReturnValue({ data: response, isLoading: false, error: null });

    renderPage();

    expect(screen.getAllByText('exp_live').length).toBeGreaterThan(0);
    expect(screen.getByText('experiment worker')).toBeDefined();
    expect(screen.getByText('3 cycles')).toBeDefined();
  });
});
