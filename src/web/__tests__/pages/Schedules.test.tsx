// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Schedule } from '../../hooks/useSchedules';

const mockUseSchedules = vi.fn();

vi.mock('../../hooks/useSchedules', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useSchedules')>(
    '../../hooks/useSchedules',
  );
  return {
    ...actual,
    useSchedules: (...args: unknown[]) => mockUseSchedules(...args),
  };
});

vi.mock('../../hooks/useSchedulesRealtime', () => ({
  useSchedulesRealtime: vi.fn(),
}));

vi.mock('../../components/common/TimeAgo', () => ({
  TimeAgo: ({ date }: { date: string }) => <span>{date}</span>,
}));

vi.mock('../../components/schedules/CreateScheduleModal', () => ({
  CreateScheduleModal: () => <div data-testid="create-schedule-modal" />,
}));

import { Schedules } from '../../pages/Schedules';

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/schedules']}>
        <Schedules />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch_1',
    cron: '*/5 * * * *',
    timezone: 'UTC',
    payload: {
      kind: 'dispatch_spec',
      spec_ref: { resource_id: 'res_1', spec_id: 'spec_1' },
      target_swarm_ids: ['swarm_1'],
    },
    policy: { catchUp: 'fire-once', skipIfRunning: false },
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

describe('<Schedules />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders experiment schedules without assuming dispatch spec fields', () => {
    mockUseSchedules.mockReturnValue({
      data: {
        data: [
          makeSchedule({
            id: 'sch_exp',
            payload: {
              kind: 'experiment',
              experiment_ref: 'exp_live',
              run_controls: { cycles: 3 },
            },
          }),
        ],
        total: 1,
        limit: 50,
        offset: 0,
      },
      isLoading: false,
      error: null,
    });

    renderPage();

    expect(screen.getByText('exp_live')).toBeDefined();
    expect(screen.getByText('experiment run')).toBeDefined();
  });
});
