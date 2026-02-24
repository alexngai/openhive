import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  HostedStateBadge,
  MapStatusBadge,
  SectionLabel,
  HOSTED_STATE_STYLES,
  MAP_STATUS_STYLES,
} from '../../../components/swarm/StatusBadges';
import type { HostedSwarm } from '../../../lib/api';

describe('HostedStateBadge', () => {
  const states: HostedSwarm['state'][] = [
    'running', 'starting', 'provisioning', 'unhealthy', 'stopping', 'stopped', 'failed',
  ];

  it.each(states)('renders correct label for state "%s"', (state) => {
    render(<HostedStateBadge state={state} />);
    expect(screen.getByText(HOSTED_STATE_STYLES[state].label)).toBeDefined();
  });

  it('renders a pulsing dot for running state', () => {
    const { container } = render(<HostedStateBadge state="running" />);
    const dot = container.querySelector('.animate-pulse');
    expect(dot).not.toBeNull();
  });

  it('does not render a pulsing dot for stopped state', () => {
    const { container } = render(<HostedStateBadge state="stopped" />);
    const dot = container.querySelector('.animate-pulse');
    expect(dot).toBeNull();
  });
});

describe('MapStatusBadge', () => {
  const statuses = ['online', 'offline', 'unreachable'];

  it.each(statuses)('renders correct label for status "%s"', (status) => {
    render(<MapStatusBadge status={status} />);
    expect(screen.getByText(MAP_STATUS_STYLES[status].label)).toBeDefined();
  });

  it('renders a pulsing dot for online status', () => {
    const { container } = render(<MapStatusBadge status="online" />);
    const dot = container.querySelector('.animate-pulse');
    expect(dot).not.toBeNull();
  });

  it('falls back to offline style for unknown status', () => {
    render(<MapStatusBadge status="unknown-status" />);
    expect(screen.getByText('Offline')).toBeDefined();
  });
});

describe('SectionLabel', () => {
  it('renders children text', () => {
    render(<SectionLabel>Field Name</SectionLabel>);
    expect(screen.getByText('Field Name')).toBeDefined();
  });

  it('renders as a label element', () => {
    const { container } = render(<SectionLabel>Test</SectionLabel>);
    expect(container.querySelector('label')).not.toBeNull();
  });
});
