// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import type { Schedule, ScheduleDetailResponse } from '../../hooks/useSchedules';

const mockUseSchedules = vi.fn();
const mockUseSchedule = vi.fn();

vi.mock('../../hooks/useSchedules', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useSchedules')>(
    '../../hooks/useSchedules',
  );
  return {
    ...actual,
    useSchedules: (...args: unknown[]) => mockUseSchedules(...args),
    useSchedule: (...args: unknown[]) => mockUseSchedule(...args),
    useCronPreview: () => ({
      data: { fires: ['2026-06-29T17:00:00.000Z'], timezone: 'UTC' },
      isLoading: false,
      error: null,
    }),
    useUpdateSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
    usePauseSchedule: () => ({ mutate: vi.fn(), isPending: false }),
    useResumeSchedule: () => ({ mutate: vi.fn(), isPending: false }),
    useDeleteSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});

vi.mock('../../hooks/useSchedulesRealtime', () => ({
  useSchedulesRealtime: vi.fn(),
}));

vi.mock('../../components/common/TimeAgo', () => ({
  TimeAgo: ({ date }: { date: string }) => <span>{date}</span>,
}));

import { Schedules } from '../../pages/Schedules';
import { ScheduleDetail } from '../../pages/ScheduleDetail';

function renderPage(ui: React.ReactElement, initialEntries: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function makeExperimentSchedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sched_experiment',
    cron: '0 * * * *',
    timezone: 'UTC',
    payload: {
      kind: 'experiment',
      experiment_ref: 'exp_control_plane',
      run_controls: { cycles: 3, budgetSeconds: 120 },
    },
    policy: { catchUp: 'fire-once', skipIfRunning: true },
    paused: false,
    next_fires_at: '2026-06-29T17:00:00.000Z',
    last_fired_at: null,
    hive_id: '',
    initiator_type: 'user',
    initiator_id: 'admin',
    pause_reason: null,
    created_at: '2026-06-29T16:00:00.000Z',
    updated_at: '2026-06-29T16:00:00.000Z',
    ...over,
  };
}

describe('Schedules pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders experiment schedules in the list without dispatch fields', () => {
    mockUseSchedules.mockReturnValue({
      data: { data: [makeExperimentSchedule()], total: 1, limit: 50, offset: 0 },
      isLoading: false,
      error: null,
    });

    renderPage(<Schedules />, ['/schedules']);

    expect(screen.getByText('exp_control_plane')).toBeDefined();
    expect(screen.getByText('experiment runner')).toBeDefined();
    expect(screen.queryByText(/swarms$/)).toBeNull();
  });

  it('renders experiment schedule detail without dispatch targets or spec refs', () => {
    const detail: ScheduleDetailResponse = {
      schedule: makeExperimentSchedule(),
      fires: [],
      fire_total: 0,
    };
    mockUseSchedule.mockReturnValue({
      data: detail,
      isLoading: false,
      error: null,
    });

    renderPage(
      <Routes>
        <Route path="/schedules/:id" element={<ScheduleDetail />} />
      </Routes>,
      ['/schedules/sched_experiment'],
    );

    expect(screen.getByRole('link', { name: 'exp_control_plane' }).getAttribute('href')).toBe(
      '/experiments/exp_control_plane',
    );
    expect(screen.getByText('experiment runner')).toBeDefined();
    expect(screen.getByText(/3 cycles/)).toBeDefined();
    expect(screen.getByText(/120s budget/)).toBeDefined();
  });
});
