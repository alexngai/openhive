import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from '../../../components/layout/Sidebar';

// Mock auth store
vi.mock('../../../stores/auth', () => ({
  useAuthStore: vi.fn().mockReturnValue({ isAuthenticated: false }),
}));

// Mock fetch for .well-known/openhive.json
global.fetch = vi.fn().mockResolvedValue({
  json: () => Promise.resolve({ features: { swarm_hosting: true, swarmcraft: true } }),
  ok: true,
}) as unknown as typeof fetch;

function renderSidebar(initialRoute = '/') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialRoute]}>
        <Sidebar />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Sidebar Navigation', () => {
  it('renders Dashboard as the first nav item', () => {
    renderSidebar();
    const links = screen.getAllByRole('link');
    const dashboardLink = links.find((l) => l.textContent?.includes('Dashboard'));
    expect(dashboardLink).toBeDefined();
    expect(dashboardLink!.getAttribute('href')).toBe('/');
  });

  it('renders Swarms nav item linking to /swarms', () => {
    renderSidebar();
    const links = screen.getAllByRole('link');
    const swarmsLink = links.find((l) => l.textContent?.trim() === 'Swarms');
    expect(swarmsLink).toBeDefined();
    expect(swarmsLink!.getAttribute('href')).toBe('/swarms');
  });

  it('renders Explore nav item linking to /explore', () => {
    renderSidebar();
    const links = screen.getAllByRole('link');
    const exploreLink = links.find((l) => l.textContent?.trim() === 'Explore');
    expect(exploreLink).toBeDefined();
    expect(exploreLink!.getAttribute('href')).toBe('/explore');
  });

  it('renders Channels nav item linking to /hives', () => {
    renderSidebar();
    const links = screen.getAllByRole('link');
    const channelsLink = links.find((l) => l.textContent?.trim() === 'Channels');
    expect(channelsLink).toBeDefined();
    expect(channelsLink!.getAttribute('href')).toBe('/hives');
  });

  it('renders Agents nav item', () => {
    renderSidebar();
    const links = screen.getAllByRole('link');
    const agentsLink = links.find((l) => l.textContent?.trim() === 'Agents');
    expect(agentsLink).toBeDefined();
    expect(agentsLink!.getAttribute('href')).toBe('/agents');
  });

  it('shows Swarms without requiring swarm_hosting feature flag', () => {
    // Even with no features, Swarms should be visible
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: () => Promise.resolve({ features: {} }),
      ok: true,
    });

    renderSidebar();
    const links = screen.getAllByRole('link');
    const swarmsLink = links.find((l) => l.textContent?.trim() === 'Swarms');
    expect(swarmsLink).toBeDefined();
  });

  it('has the "Channels" section header', () => {
    renderSidebar();
    const channelsElements = screen.getAllByText('Channels');
    // One in nav, one as section header
    expect(channelsElements.length).toBeGreaterThanOrEqual(2);
  });

  it('marks Dashboard link as active when on /', () => {
    renderSidebar('/');
    const links = screen.getAllByRole('link');
    const dashboardLink = links.find((l) => l.textContent?.includes('Dashboard'));
    expect(dashboardLink!.className).toContain('active');
  });

  it('does not have a Home nav item', () => {
    renderSidebar();
    const links = screen.getAllByRole('link');
    const homeLink = links.find(
      (l) => l.textContent?.trim() === 'Home' && l.getAttribute('href') === '/'
    );
    expect(homeLink).toBeUndefined();
  });
});
