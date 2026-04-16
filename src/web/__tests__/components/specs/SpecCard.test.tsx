import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SpecCard } from '../../../components/specs/SpecCard';
import type { Spec } from '../../../hooks/useSpecs';

function makeSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    id: 's-aaa',
    resource_id: 'res_a',
    resource_name: 'Graph A',
    swarm_id: null,
    swarm_name: null,
    title: 'Refactor auth',
    content: 'Detailed plan to redo the auth flow with tighter session handling.',
    status: 'active',
    priority: 1,
    archived: false,
    created_at: null,
    updated_at: null,
    uri: null,
    source: 'local',
    ...overrides,
  };
}

describe('<SpecCard />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders title, id, resource name, and priority', () => {
    render(<SpecCard spec={makeSpec()} />);
    expect(screen.getByText('Refactor auth')).toBeDefined();
    expect(screen.getByText('s-aaa')).toBeDefined();
    expect(screen.getByText('Graph A')).toBeDefined();
    expect(screen.getByText('P1')).toBeDefined();
  });

  it('truncates long content into a preview with ellipsis', () => {
    const long = 'a'.repeat(300);
    render(<SpecCard spec={makeSpec({ content: long })} />);
    const preview = screen.getByText((_text, el) =>
      !!el?.textContent?.startsWith('a') && (el.textContent?.length ?? 0) > 200,
    );
    expect(preview.textContent).toMatch(/…$/);
  });

  it('omits priority chip when priority is 4 (lowest)', () => {
    render(<SpecCard spec={makeSpec({ priority: 4 })} />);
    expect(screen.queryByText('P4')).toBeNull();
  });

  it('shows swarm chip when swarm_name is set', () => {
    render(<SpecCard spec={makeSpec({ swarm_name: 'macro-swarm', source: 'remote' })} />);
    expect(screen.getByText('macro-swarm')).toBeDefined();
  });

  it('renders archived state with reduced opacity', () => {
    const { container } = render(<SpecCard spec={makeSpec({ archived: true })} />);
    expect(container.querySelector('.opacity-60')).not.toBeNull();
  });

  it('calls onClick with spec when card is clicked', () => {
    const onClick = vi.fn();
    render(<SpecCard spec={makeSpec()} onClick={onClick} />);
    fireEvent.click(screen.getByText('Refactor auth'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0]?.[0]?.id).toBe('s-aaa');
  });

  it('does not propagate click when the copy-id button is clicked', () => {
    const onClick = vi.fn();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    render(<SpecCard spec={makeSpec()} onClick={onClick} />);
    const copyBtn = screen.getByTitle(/Copy ID/i);
    fireEvent.click(copyBtn);
    expect(onClick).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('s-aaa');
  });
});
