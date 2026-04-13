import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentAvatar } from '../../../components/common/AgentAvatar';

// Mock boring-avatars
vi.mock('boring-avatars', () => ({
  default: ({ name, size, variant, colors }: { name: string; size: number; variant: string; colors: string[] }) => (
    <svg data-testid="boring-avatar" data-name={name} data-size={size} data-variant={variant} data-colors={colors.join(',')} />
  ),
}));

// Mock the palette generator to verify it's called
vi.mock('swarmcraft/ui/embed', () => ({
  generateAgentPalette: (name: string) => {
    // Return a deterministic fake palette based on name
    return [`#${name.length}00000`, '#111111', '#222222', '#333333', '#444444'];
  },
}));

describe('AgentAvatar', () => {
  it('renders boring-avatar when no src provided', () => {
    render(<AgentAvatar name="test-agent" />);
    const avatar = screen.getByTestId('boring-avatar');
    expect(avatar).toBeDefined();
    expect(avatar.getAttribute('data-name')).toBe('test-agent');
    expect(avatar.getAttribute('data-variant')).toBe('beam');
  });

  it('uses the default size of 24', () => {
    render(<AgentAvatar name="test-agent" />);
    const avatar = screen.getByTestId('boring-avatar');
    expect(avatar.getAttribute('data-size')).toBe('24');
  });

  it('passes custom size to boring-avatar', () => {
    render(<AgentAvatar name="test-agent" size={40} />);
    const avatar = screen.getByTestId('boring-avatar');
    expect(avatar.getAttribute('data-size')).toBe('40');
  });

  it('renders image when src is provided', () => {
    render(<AgentAvatar name="test-agent" src="https://example.com/avatar.png" />);
    const img = screen.getByRole('img');
    expect(img).toBeDefined();
    expect(img.getAttribute('src')).toBe('https://example.com/avatar.png');
    expect(img.getAttribute('alt')).toBe('test-agent');
  });

  it('does not render boring-avatar when src is provided', () => {
    render(<AgentAvatar name="test-agent" src="https://example.com/avatar.png" />);
    expect(screen.queryByTestId('boring-avatar')).toBeNull();
  });

  it('renders boring-avatar when src is null', () => {
    render(<AgentAvatar name="test-agent" src={null} />);
    expect(screen.getByTestId('boring-avatar')).toBeDefined();
  });

  it('generates different palettes for different names', () => {
    const { unmount } = render(<AgentAvatar name="alpha" />);
    const avatar1 = screen.getByTestId('boring-avatar');
    const colors1 = avatar1.getAttribute('data-colors');
    unmount();

    render(<AgentAvatar name="beta" />);
    const avatar2 = screen.getByTestId('boring-avatar');
    const colors2 = avatar2.getAttribute('data-colors');

    expect(colors1).not.toBe(colors2);
  });

  it('applies className to the wrapper', () => {
    const { container } = render(<AgentAvatar name="test-agent" className="mt-2" />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.classList.contains('mt-2')).toBe(true);
  });
});
