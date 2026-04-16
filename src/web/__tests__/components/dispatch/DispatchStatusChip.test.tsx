import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DispatchStatusChip } from '../../../components/dispatch/DispatchStatusChip';

describe('<DispatchStatusChip />', () => {
  it('renders the human label for each status', () => {
    const cases = ['queued', 'running', 'complete', 'failed', 'cancelled'] as const;
    const labels = ['Queued', 'Running', 'Complete', 'Failed', 'Cancelled'];
    cases.forEach((s, i) => {
      const { unmount } = render(<DispatchStatusChip status={s} />);
      expect(screen.getByText(labels[i]!)).toBeDefined();
      unmount();
    });
  });

  it('animates the running state', () => {
    const { container } = render(<DispatchStatusChip status="running" />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('does not animate non-running states', () => {
    const { container } = render(<DispatchStatusChip status="complete" />);
    expect(container.querySelector('.animate-spin')).toBeNull();
  });
});
