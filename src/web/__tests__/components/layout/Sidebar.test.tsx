import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from '../../../components/layout/Sidebar';

// Mock auth store
vi.mock('../../../stores/auth', () => ({
  useAuthStore: vi.fn().mockReturnValue({ isAuthenticated: false, authMode: 'local' }),
}));

// Mock useMapSwarms
vi.mock('../../../hooks/useApi', () => ({
  useMapSwarms: vi.fn().mockReturnValue({ data: [] }),
}));

// Mock useInstanceFeatures
vi.mock('../../../hooks/useInstanceFeatures', () => ({
  useInstanceFeatures: vi.fn().mockReturnValue({ features: {} }),
}));

// Mock fetch for mail conversations sidebar query
global.fetch = vi.fn().mockResolvedValue({
  json: () => Promise.resolve({ conversations: [] }),
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
  it('renders Overview as the first nav item linking to /', () => {
    renderSidebar();
    const links = screen.getAllByRole('link');
    const overviewLink = links.find((l) => l.textContent?.includes('Overview'));
    expect(overviewLink).toBeDefined();
    expect(overviewLink!.getAttribute('href')).toBe('/');
  });

  it('renders Swarms nav item linking to /swarms', () => {
    renderSidebar();
    const links = screen.getAllByRole('link');
    const swarmsLink = links.find((l) => l.textContent?.trim() === 'Swarms');
    expect(swarmsLink).toBeDefined();
    expect(swarmsLink!.getAttribute('href')).toBe('/swarms');
  });

  it('renders Threads nav item linking to /threads', () => {
    renderSidebar();
    const links = screen.getAllByRole('link');
    const link = links.find((l) => l.textContent?.trim() === 'Threads');
    expect(link).toBeDefined();
    expect(link!.getAttribute('href')).toBe('/threads');
  });

  it('renders Memory nav item linking to /memory', () => {
    renderSidebar();
    const links = screen.getAllByRole('link');
    const link = links.find((l) => l.textContent?.trim() === 'Memory');
    expect(link).toBeDefined();
    expect(link!.getAttribute('href')).toBe('/memory');
  });

  it('renders Skills nav item linking to /skills', () => {
    renderSidebar();
    const links = screen.getAllByRole('link');
    const link = links.find((l) => l.textContent?.trim() === 'Skills');
    expect(link).toBeDefined();
    expect(link!.getAttribute('href')).toBe('/skills');
  });

  it('renders Tasks nav item linking to /tasks', () => {
    renderSidebar();
    const links = screen.getAllByRole('link');
    const link = links.find((l) => l.textContent?.trim() === 'Tasks');
    expect(link).toBeDefined();
    expect(link!.getAttribute('href')).toBe('/tasks');
  });

  it('has the Fleet section header', () => {
    renderSidebar();
    expect(screen.getByText('Fleet')).toBeDefined();
  });

  it('has the Work section header', () => {
    renderSidebar();
    expect(screen.getByText('Work')).toBeDefined();
  });

  it('has the Library section header', () => {
    renderSidebar();
    expect(screen.getByText('Library')).toBeDefined();
  });

  it('surfaces schedules and events links', () => {
    renderSidebar();
    const links = screen.getAllByRole('link');
    expect(links.find((l) => l.textContent?.trim() === 'Schedules')?.getAttribute('href')).toBe('/schedules');
    expect(links.find((l) => l.textContent?.trim() === 'Events')?.getAttribute('href')).toBe('/events');
  });

  it('marks Overview link as active when on /', () => {
    renderSidebar('/');
    const links = screen.getAllByRole('link');
    const overviewLink = links.find((l) => l.textContent?.includes('Overview'));
    expect(overviewLink).toBeDefined();
    expect(overviewLink!.className).toContain('active');
  });

  it('marks Swarms link as active when on /swarms', () => {
    renderSidebar('/swarms');
    const links = screen.getAllByRole('link');
    const link = links.find((l) => l.textContent?.trim() === 'Swarms');
    expect(link).toBeDefined();
    expect(link!.className).toContain('active');
  });
});
