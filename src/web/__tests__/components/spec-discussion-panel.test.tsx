/**
 * SpecDiscussionPanel (P3.3) — Discussion tab body on SpecDetail.
 *
 * Covers:
 * - mounts MailThreadView when a thread resolves
 * - shows the "Start discussion" CTA when no thread exists, and POSTs on click
 * - shows a loading state while resolving
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const mockUseSpecThread = vi.fn();
const mockCreateMutate = vi.fn();
const mockUseCreateSpecThread = vi.fn();

vi.mock('../../hooks/useSpecs', () => ({
  useSpecThread: (...args: unknown[]) => mockUseSpecThread(...args),
  useCreateSpecThread: (...args: unknown[]) => mockUseCreateSpecThread(...args),
}));

vi.mock('../../components/sessions/MailThreadView', () => ({
  MailThreadView: ({ conversationId }: { conversationId: string }) => (
    <div data-testid="mail-thread-view">{conversationId}</div>
  ),
}));

import { SpecDiscussionPanel } from '../../components/specs/SpecDiscussionPanel';

describe('SpecDiscussionPanel', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockCreateMutate.mockReset();
    mockUseCreateSpecThread.mockReturnValue({
      mutate: mockCreateMutate,
      isPending: false,
      isError: false,
      error: null,
    });
  });

  it('mounts MailThreadView when a thread resolves', () => {
    mockUseSpecThread.mockReturnValue({
      data: { conversation_id: 'spec-thread:res-1:s-aaa', turn_count: 3 },
      isLoading: false,
      isError: false,
    });

    render(<SpecDiscussionPanel resourceId="res-1" specId="s-aaa" />);

    const view = screen.getByTestId('mail-thread-view');
    expect(view).toBeDefined();
    expect(view.textContent).toBe('spec-thread:res-1:s-aaa');
  });

  it('shows the Start discussion CTA and POSTs when no thread exists', () => {
    mockUseSpecThread.mockReturnValue({ data: null, isLoading: false, isError: false });

    render(<SpecDiscussionPanel resourceId="res-1" specId="s-aaa" />);

    expect(screen.getByText('No discussion yet')).toBeDefined();
    expect(screen.queryByTestId('mail-thread-view')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Start discussion/ }));
    expect(mockCreateMutate).toHaveBeenCalledTimes(1);
  });

  it('shows a loading state while resolving', () => {
    mockUseSpecThread.mockReturnValue({ data: undefined, isLoading: true, isError: false });

    const { container } = render(<SpecDiscussionPanel resourceId="res-1" specId="s-aaa" />);

    expect(screen.queryByTestId('mail-thread-view')).toBeNull();
    expect(screen.queryByText('No discussion yet')).toBeNull();
    // LoadingSpinner renders some element in the container.
    expect(container.firstChild).toBeTruthy();
  });
});
