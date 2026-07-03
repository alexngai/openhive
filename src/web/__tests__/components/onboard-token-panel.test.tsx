/**
 * OnboardTokenPanel (P2.3) — mint flow with mocked responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockPost = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { post: (...args: unknown[]) => mockPost(...args) },
}));

import { OnboardTokenPanel } from '../../components/onboarding/OnboardTokenPanel';

describe('OnboardTokenPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mints a token and renders the copyable export + connect blocks', async () => {
    mockPost.mockResolvedValue({
      agent_id: 'agent_abc',
      token: 'tok_secret_123',
      env: { MAP_CREDENTIAL: 'tok_secret_123' },
      scopes: ['map:agents:spawn'],
      ttl_hours: 24,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });

    render(<OnboardTokenPanel />);
    fireEvent.change(screen.getByPlaceholderText('my-laptop-claude'), {
      target: { value: 'test-agent' },
    });
    fireEvent.click(screen.getByText('Generate onboard token'));

    await waitFor(() => {
      expect(screen.getByText(/export MAP_CREDENTIAL="tok_secret_123"/)).toBeDefined();
    });
    expect(mockPost).toHaveBeenCalledWith('/admin/onboard-token', {
      scopes: ['map:agents:spawn'],
      ttl_hours: 24,
      agent_name: 'test-agent',
    });
    // Connect recipe + skill.md link
    expect(screen.getByText(/\/ws\/map\?swarm_id=/)).toBeDefined();
    expect(screen.getByRole('link', { name: '/skill.md' }).getAttribute('href')).toBe('/skill.md');
    expect(screen.getByText('agent_abc')).toBeDefined();
  });

  it('surfaces a clear error when minting fails (non-admin caller)', async () => {
    mockPost.mockRejectedValue(new Error('Forbidden'));

    render(<OnboardTokenPanel />);
    fireEvent.click(screen.getByText('Generate onboard token'));

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain('Forbidden');
      expect(alert.textContent).toContain('openhive admin onboard-token create');
    });
  });

  it('falls back to MAP_CREDENTIAL when the response env is empty', async () => {
    mockPost.mockResolvedValue({
      agent_id: 'agent_x',
      token: 'tok_y',
      env: {},
      scopes: ['map:agents:spawn'],
      ttl_hours: 24,
      expires_at: new Date().toISOString(),
    });

    render(<OnboardTokenPanel showNameField={false} />);
    expect(screen.queryByPlaceholderText('my-laptop-claude')).toBeNull();
    fireEvent.click(screen.getByText('Generate onboard token'));

    await waitFor(() => {
      expect(screen.getByText(/export MAP_CREDENTIAL="tok_y"/)).toBeDefined();
    });
  });
});
