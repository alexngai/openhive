import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  DispatchRollup,
  rollupDispatchStatuses,
} from '../../../components/dispatch/DispatchRollup';
import type { DispatchStatus } from '../../../hooks/useDispatch';

const items = (...statuses: DispatchStatus[]) => statuses.map((status) => ({ status }));

describe('rollupDispatchStatuses', () => {
  it('tallies counts, active, settled and allComplete', () => {
    const r = rollupDispatchStatuses(items('running', 'complete', 'queued'));
    expect(r.total).toBe(3);
    expect(r.counts.running).toBe(1);
    expect(r.counts.complete).toBe(1);
    expect(r.counts.queued).toBe(1);
    expect(r.active).toBe(2);
    expect(r.settled).toBe(false);
    expect(r.allComplete).toBe(false);
  });

  it('is settled when nothing is queued/running', () => {
    const r = rollupDispatchStatuses(items('complete', 'failed', 'cancelled'));
    expect(r.settled).toBe(true);
    expect(r.allComplete).toBe(false);
  });

  it('allComplete only when every dispatch is complete', () => {
    expect(rollupDispatchStatuses(items('complete', 'complete')).allComplete).toBe(true);
    expect(rollupDispatchStatuses(items('complete', 'failed')).allComplete).toBe(false);
    expect(rollupDispatchStatuses([]).allComplete).toBe(false);
  });
});

describe('<DispatchRollup />', () => {
  it('renders nothing when there are no items', () => {
    const { container } = render(<DispatchRollup items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one chip per non-zero status plus the summary', () => {
    render(<DispatchRollup items={items('running', 'complete', 'complete')} showSummary />);
    expect(screen.getByText('2/3 done')).toBeDefined();
    expect(screen.getByText('1 running')).toBeDefined();
    expect(screen.getByText('2 complete')).toBeDefined();
    expect(screen.queryByText(/queued/)).toBeNull();
  });
});
