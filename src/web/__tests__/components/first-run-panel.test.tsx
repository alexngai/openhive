/**
 * FirstRunPanel (P2.2) — renders only on a settled zero-swarm instance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockHosted = vi.fn();
const mockMap = vi.fn();

vi.mock('../../hooks/useApi', () => ({
  useHostedSwarms: (...args: unknown[]) => mockHosted(...args),
  useMapSwarms: (...args: unknown[]) => mockMap(...args),
}));

import { FirstRunPanel } from '../../components/onboarding/FirstRunPanel';

function renderPanel(props?: { onSpawn?: () => void; onConnect?: () => void }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <FirstRunPanel {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('FirstRunPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the three entry cards when both queries settle at zero', () => {
    mockHosted.mockReturnValue({ isSuccess: true, data: { data: [] } });
    mockMap.mockReturnValue({ isSuccess: true, data: [] });

    renderPanel();
    expect(screen.getByTestId('first-run-panel')).toBeDefined();
    expect(screen.getByText('Spawn a hosted agent')).toBeDefined();
    expect(screen.getByText('Connect an existing agent')).toBeDefined();
    expect(screen.getByText('Create your first spec')).toBeDefined();
  });

  it('renders nothing while queries are still loading', () => {
    mockHosted.mockReturnValue({ isSuccess: false, data: undefined });
    mockMap.mockReturnValue({ isSuccess: true, data: [] });

    renderPanel();
    expect(screen.queryByTestId('first-run-panel')).toBeNull();
  });

  it('renders nothing when any swarm exists', () => {
    mockHosted.mockReturnValue({ isSuccess: true, data: { data: [{ id: 'hs_1' }] } });
    mockMap.mockReturnValue({ isSuccess: true, data: [] });

    renderPanel();
    expect(screen.queryByTestId('first-run-panel')).toBeNull();
  });

  it('invokes the spawn/connect callbacks when provided', () => {
    mockHosted.mockReturnValue({ isSuccess: true, data: { data: [] } });
    mockMap.mockReturnValue({ isSuccess: true, data: [] });

    const onSpawn = vi.fn();
    const onConnect = vi.fn();
    renderPanel({ onSpawn, onConnect });

    fireEvent.click(screen.getByText('Spawn a hosted agent'));
    expect(onSpawn).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('Connect an existing agent'));
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it('falls back to links when callbacks are omitted (Threads empty state)', () => {
    mockHosted.mockReturnValue({ isSuccess: true, data: { data: [] } });
    mockMap.mockReturnValue({ isSuccess: true, data: [] });

    renderPanel();
    const links = screen.getAllByRole('link');
    const hrefs = links.map((l) => l.getAttribute('href'));
    expect(hrefs).toContain('/swarms');
    expect(hrefs).toContain('/specs/new');
  });
});
