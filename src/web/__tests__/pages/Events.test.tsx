import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Events } from '../../pages/Events';

// ── Mock data ──

const mockHives = [
  { id: 'hive_1', name: 'test-hive', description: null, banner_url: null, is_public: true, member_count: 3, post_count: 10, created_at: '2025-01-01' },
  { id: 'hive_2', name: 'dev-hive', description: null, banner_url: null, is_public: true, member_count: 5, post_count: 20, created_at: '2025-01-02' },
];

const mockSwarms = [
  { id: 'swarm_1', name: 'swarm-alpha', description: null, map_endpoint: 'ws://localhost:9001', map_transport: 'websocket', status: 'online', last_seen_at: null, capabilities: null, auth_method: null, agent_count: 2, scope_count: 1, metadata: null, hives: [], created_at: '2025-01-01' },
];

const mockRules = [
  {
    id: 'rule_1', hive_id: 'hive_1', source: 'github', event_types: ['push', 'pull_request.opened'],
    filters: null, normalizer: 'default', thread_mode: 'post_per_event' as const, priority: 100,
    enabled: true, created_by: 'admin', created_at: '2025-01-01', updated_at: '2025-01-01',
  },
  {
    id: 'rule_2', hive_id: 'hive_2', source: 'slack', event_types: ['message'],
    filters: { channels: ['C_GENERAL'] }, normalizer: 'default', thread_mode: 'skip' as const, priority: 50,
    enabled: false, created_by: null, created_at: '2025-01-02', updated_at: '2025-01-02',
  },
];

const mockSubs = [
  {
    id: 'sub_1', hive_id: 'hive_1', swarm_id: null, source: 'github', event_types: ['push'],
    filters: null, priority: 100, enabled: true, created_by: 'admin',
    created_at: '2025-01-01', updated_at: '2025-01-01',
  },
  {
    id: 'sub_2', hive_id: 'hive_1', swarm_id: 'swarm_1', source: 'slack', event_types: ['message', 'reaction_added'],
    filters: null, priority: 50, enabled: true, created_by: null,
    created_at: '2025-01-02', updated_at: '2025-01-02',
  },
];

const mockDeliveryLog = {
  data: [
    { id: 'dl_1', delivery_id: 'del_gh1', subscription_id: 'sub_1', swarm_id: 'swarm_1', source: 'github', event_type: 'push', status: 'sent', error: null, created_at: '2025-01-01T12:00:00Z' },
    { id: 'dl_2', delivery_id: 'del_sl1', subscription_id: 'sub_2', swarm_id: 'swarm_1', source: 'slack', event_type: 'message', status: 'offline', error: null, created_at: '2025-01-01T12:01:00Z' },
    { id: 'dl_3', delivery_id: 'del_gh2', subscription_id: null, swarm_id: 'swarm_1', source: 'github', event_type: 'issues.opened', status: 'failed', error: 'connection refused', created_at: '2025-01-01T12:02:00Z' },
  ],
  total: 3,
};

// ── Mock hooks ──

const mockCreatePostRule = vi.fn();
const mockUpdatePostRule = vi.fn();
const mockDeletePostRule = vi.fn();
const mockCreateSubscription = vi.fn();
const mockUpdateSubscription = vi.fn();
const mockDeleteSubscription = vi.fn();

const mockUsePostRules = vi.fn();
const mockUseEventSubscriptions = vi.fn();
const mockUseDeliveryLog = vi.fn();

vi.mock('../../hooks/useApi', () => ({
  usePostRules: (...args: unknown[]) => mockUsePostRules(...args),
  useCreatePostRule: () => ({ mutateAsync: mockCreatePostRule, isPending: false }),
  useUpdatePostRule: () => ({ mutateAsync: mockUpdatePostRule, isPending: false }),
  useDeletePostRule: () => ({ mutateAsync: mockDeletePostRule, isPending: false }),
  useEventSubscriptions: (...args: unknown[]) => mockUseEventSubscriptions(...args),
  useCreateSubscription: () => ({ mutateAsync: mockCreateSubscription, isPending: false }),
  useUpdateSubscription: () => ({ mutateAsync: mockUpdateSubscription, isPending: false }),
  useDeleteSubscription: () => ({ mutateAsync: mockDeleteSubscription, isPending: false }),
  useDeliveryLog: (...args: unknown[]) => mockUseDeliveryLog(...args),
  useHives: () => ({ data: mockHives }),
  useMapSwarms: () => ({ data: mockSwarms }),
}));

vi.mock('../../stores/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Helpers ──

function renderEvents() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Events />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// ── Tests ──

describe('Events Page', () => {
  beforeEach(() => {
    mockUsePostRules.mockReturnValue({ data: mockRules, isLoading: false });
    mockUseEventSubscriptions.mockReturnValue({ data: mockSubs, isLoading: false });
    mockUseDeliveryLog.mockReturnValue({ data: mockDeliveryLog, isLoading: false });
  });

  // ── Header & Tabs ──

  describe('Header & Tabs', () => {
    it('renders the Events heading', () => {
      renderEvents();
      expect(screen.getByRole('heading', { name: 'Events' })).toBeDefined();
    });

    it('renders all three tabs', () => {
      renderEvents();
      expect(screen.getByText('Post Rules')).toBeDefined();
      expect(screen.getByText('Subscriptions')).toBeDefined();
      expect(screen.getByText('Delivery Log')).toBeDefined();
    });

    it('shows Post Rules tab as active by default', () => {
      renderEvents();
      const rulesTab = screen.getByText('Post Rules').closest('button');
      expect(rulesTab!.className).toContain('text-honey-500');
    });

    it('shows rule count badge on Post Rules tab', () => {
      renderEvents();
      // The count is rendered inside the Post Rules tab button
      const rulesTab = screen.getByText('Post Rules').closest('button');
      expect(rulesTab!.textContent).toContain('2');
    });

    it('shows subscription count badge on Subscriptions tab', () => {
      renderEvents();
      const subsTab = screen.getByText('Subscriptions').closest('button');
      expect(subsTab!.textContent).toContain('2');
    });

    it('shows "New Rule" button when on rules tab', () => {
      renderEvents();
      const buttons = screen.getAllByRole('button');
      const newBtn = buttons.find((b) => b.textContent?.includes('New Rule'));
      expect(newBtn).toBeDefined();
    });

    it('shows "New Subscription" button when on subscriptions tab', () => {
      renderEvents();
      fireEvent.click(screen.getByText('Subscriptions'));
      const buttons = screen.getAllByRole('button');
      const newBtn = buttons.find((b) => b.textContent?.includes('New Subscription'));
      expect(newBtn).toBeDefined();
    });

    it('hides the "New" button on Delivery Log tab', () => {
      renderEvents();
      fireEvent.click(screen.getByText('Delivery Log'));
      const buttons = screen.getAllByRole('button');
      const newBtn = buttons.find((b) => b.textContent?.includes('New'));
      expect(newBtn).toBeUndefined();
    });
  });

  // ── Post Rules Tab ──

  describe('Post Rules Tab', () => {
    it('renders post rule cards', () => {
      renderEvents();
      expect(screen.getByText('push, pull_request.opened')).toBeDefined();
      expect(screen.getByText('message')).toBeDefined();
    });

    it('shows source badges', () => {
      renderEvents();
      expect(screen.getByText('github')).toBeDefined();
      expect(screen.getByText('slack')).toBeDefined();
    });

    it('shows hive names from lookup', () => {
      renderEvents();
      expect(screen.getByText('#test-hive')).toBeDefined();
      expect(screen.getByText('#dev-hive')).toBeDefined();
    });

    it('shows priority values', () => {
      renderEvents();
      expect(screen.getByText('p:100')).toBeDefined();
      expect(screen.getByText('p:50')).toBeDefined();
    });

    it('shows thread_mode badge when not post_per_event', () => {
      renderEvents();
      expect(screen.getByText('skip')).toBeDefined();
    });

    it('shows "filtered" when rule has filters', () => {
      renderEvents();
      expect(screen.getByText('filtered')).toBeDefined();
    });

    it('shows created_by when present', () => {
      renderEvents();
      expect(screen.getByText('by admin')).toBeDefined();
    });

    it('renders enabled/disabled dots', () => {
      renderEvents();
      const dots = document.querySelectorAll('[title="Enabled"], [title="Disabled"]');
      expect(dots.length).toBe(2);
    });

    it('shows empty state when no rules', () => {
      mockUsePostRules.mockReturnValue({ data: [], isLoading: false });
      renderEvents();
      expect(screen.getByText('No post rules configured')).toBeDefined();
      expect(screen.getByText('Create your first rule')).toBeDefined();
    });

    it('shows loading state', () => {
      mockUsePostRules.mockReturnValue({ data: undefined, isLoading: true });
      renderEvents();
      // PageLoader should be shown (spinner)
      const spinner = document.querySelector('.animate-spin');
      expect(spinner).toBeDefined();
    });
  });

  // ── Post Rule Form ──

  describe('Post Rule Form', () => {
    it('opens create form when clicking "New Rule"', () => {
      renderEvents();
      const buttons = screen.getAllByRole('button');
      const newBtn = buttons.find((b) => b.textContent?.includes('New Rule'));
      fireEvent.click(newBtn!);
      expect(screen.getByText('New Post Rule')).toBeDefined();
    });

    it('opens edit form when clicking edit button on a rule card', () => {
      renderEvents();
      const editButtons = screen.getAllByTitle('Edit');
      fireEvent.click(editButtons[0]);
      expect(screen.getByText('Edit Post Rule')).toBeDefined();
    });

    it('pre-fills form when editing', () => {
      renderEvents();
      const editButtons = screen.getAllByTitle('Edit');
      fireEvent.click(editButtons[0]);
      // The event types input should be pre-filled
      const input = screen.getByPlaceholderText('push, pull_request.opened, issues.*') as HTMLInputElement;
      expect(input.value).toBe('push, pull_request.opened');
    });

    it('closes form when clicking X', () => {
      renderEvents();
      const buttons = screen.getAllByRole('button');
      const newBtn = buttons.find((b) => b.textContent?.includes('New Rule'));
      fireEvent.click(newBtn!);
      expect(screen.getByText('New Post Rule')).toBeDefined();

      // Click the X button inside the form
      const closeButtons = screen.getAllByRole('button');
      const xBtn = closeButtons.find((b) => {
        const parent = b.closest('.card.p-4');
        return parent && b.classList.contains('btn-ghost');
      });
      // Alternative: click Cancel
      fireEvent.click(screen.getByText('Cancel'));
      expect(screen.queryByText('New Post Rule')).toBeNull();
    });

    it('closes form when clicking Cancel', () => {
      renderEvents();
      const buttons = screen.getAllByRole('button');
      const newBtn = buttons.find((b) => b.textContent?.includes('New Rule'));
      fireEvent.click(newBtn!);
      fireEvent.click(screen.getByText('Cancel'));
      expect(screen.queryByText('New Post Rule')).toBeNull();
    });

    it('renders hive options in the form', () => {
      renderEvents();
      const buttons = screen.getAllByRole('button');
      const newBtn = buttons.find((b) => b.textContent?.includes('New Rule'));
      fireEvent.click(newBtn!);

      const hiveSelect = screen.getByText('Select hive...').closest('select') as HTMLSelectElement;
      const options = Array.from(hiveSelect.options).map((o) => o.text);
      expect(options).toContain('test-hive');
      expect(options).toContain('dev-hive');
    });

    it('renders source options', () => {
      renderEvents();
      const buttons = screen.getAllByRole('button');
      const newBtn = buttons.find((b) => b.textContent?.includes('New Rule'));
      fireEvent.click(newBtn!);

      // Find the source select (labeled "Source")
      const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
      const sourceSelect = selects.find((s) =>
        Array.from(s.options).some((o) => o.value === 'github')
      );
      expect(sourceSelect).toBeDefined();
      const options = Array.from(sourceSelect!.options).map((o) => o.value);
      expect(options).toContain('github');
      expect(options).toContain('slack');
      expect(options).toContain('*');
    });

    it('renders thread mode options', () => {
      renderEvents();
      const buttons = screen.getAllByRole('button');
      const newBtn = buttons.find((b) => b.textContent?.includes('New Rule'));
      fireEvent.click(newBtn!);

      const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
      const threadSelect = selects.find((s) =>
        Array.from(s.options).some((o) => o.value === 'single_thread')
      );
      expect(threadSelect).toBeDefined();
    });

    it('shows filters section when clicking Filters toggle', () => {
      renderEvents();
      const buttons = screen.getAllByRole('button');
      const newBtn = buttons.find((b) => b.textContent?.includes('New Rule'));
      fireEvent.click(newBtn!);

      // Click "Filters" toggle
      const filtersToggle = screen.getAllByRole('button').find((b) => b.textContent?.includes('Filters'));
      fireEvent.click(filtersToggle!);

      expect(screen.getByPlaceholderText('{"repos": ["org/repo"], "branches": ["main"]}')).toBeDefined();
    });

    it('calls create mutation on submit', async () => {
      mockCreatePostRule.mockResolvedValue({});
      renderEvents();

      // Open form
      const buttons = screen.getAllByRole('button');
      const newBtn = buttons.find((b) => b.textContent?.includes('New Rule'));
      fireEvent.click(newBtn!);

      // Fill form
      const hiveSelect = screen.getByText('Select hive...').closest('select') as HTMLSelectElement;
      fireEvent.change(hiveSelect, { target: { value: 'hive_1' } });

      const eventInput = screen.getByPlaceholderText('push, pull_request.opened, issues.*');
      fireEvent.change(eventInput, { target: { value: 'push' } });

      // Submit
      fireEvent.click(screen.getByText('Create'));

      await waitFor(() => {
        expect(mockCreatePostRule).toHaveBeenCalledWith(expect.objectContaining({
          hive_id: 'hive_1',
          source: 'github',
          event_types: ['push'],
          thread_mode: 'post_per_event',
          priority: 100,
        }));
      });
    });

    it('calls update mutation on edit submit', async () => {
      mockUpdatePostRule.mockResolvedValue({});
      renderEvents();

      // Click edit on first rule
      const editButtons = screen.getAllByTitle('Edit');
      fireEvent.click(editButtons[0]);

      // Change priority
      const priorityInput = screen.getByDisplayValue('100') as HTMLInputElement;
      fireEvent.change(priorityInput, { target: { value: '200' } });

      // Submit
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(mockUpdatePostRule).toHaveBeenCalledWith(expect.objectContaining({
          id: 'rule_1',
          priority: 200,
        }));
      });
    });
  });

  // ── Post Rule Card Actions ──

  describe('Post Rule Card Actions', () => {
    it('calls delete mutation when clicking delete', async () => {
      mockDeletePostRule.mockResolvedValue({});
      renderEvents();

      const deleteButtons = screen.getAllByTitle('Delete');
      fireEvent.click(deleteButtons[0]);

      await waitFor(() => {
        expect(mockDeletePostRule).toHaveBeenCalledWith('rule_1');
      });
    });

    it('calls update mutation to toggle enabled', async () => {
      mockUpdatePostRule.mockResolvedValue({});
      renderEvents();

      // Click the enable/disable toggle on first rule (which is enabled)
      const toggleButtons = screen.getAllByTitle('Disable');
      fireEvent.click(toggleButtons[0]);

      await waitFor(() => {
        expect(mockUpdatePostRule).toHaveBeenCalledWith({ id: 'rule_1', enabled: false });
      });
    });

    it('calls update mutation to enable a disabled rule', async () => {
      mockUpdatePostRule.mockResolvedValue({});
      renderEvents();

      const toggleButtons = screen.getAllByTitle('Enable');
      fireEvent.click(toggleButtons[0]);

      await waitFor(() => {
        expect(mockUpdatePostRule).toHaveBeenCalledWith({ id: 'rule_2', enabled: true });
      });
    });
  });

  // ── Subscriptions Tab ──

  describe('Subscriptions Tab', () => {
    it('renders subscription cards when switching to tab', () => {
      renderEvents();
      fireEvent.click(screen.getByText('Subscriptions'));
      expect(screen.getByText('push')).toBeDefined();
      expect(screen.getByText('message, reaction_added')).toBeDefined();
    });

    it('shows "All swarms" for hive-level subscriptions', () => {
      renderEvents();
      fireEvent.click(screen.getByText('Subscriptions'));
      expect(screen.getByText('All swarms')).toBeDefined();
    });

    it('shows swarm name for swarm-specific subscriptions', () => {
      renderEvents();
      fireEvent.click(screen.getByText('Subscriptions'));
      expect(screen.getByText('swarm-alpha')).toBeDefined();
    });

    it('shows empty state when no subscriptions', () => {
      mockUseEventSubscriptions.mockReturnValue({ data: [], isLoading: false });
      renderEvents();
      fireEvent.click(screen.getByText('Subscriptions'));
      expect(screen.getByText('No event subscriptions configured')).toBeDefined();
      expect(screen.getByText('Create your first subscription')).toBeDefined();
    });
  });

  // ── Subscription Form ──

  describe('Subscription Form', () => {
    it('opens create form when clicking "New Subscription"', () => {
      renderEvents();
      fireEvent.click(screen.getByText('Subscriptions'));
      const buttons = screen.getAllByRole('button');
      const newBtn = buttons.find((b) => b.textContent?.includes('New Subscription'));
      fireEvent.click(newBtn!);
      expect(screen.getByText('New Subscription')).toBeDefined();
    });

    it('shows swarm select with "All swarms" default', () => {
      renderEvents();
      fireEvent.click(screen.getByText('Subscriptions'));
      const buttons = screen.getAllByRole('button');
      const newBtn = buttons.find((b) => b.textContent?.includes('New Subscription'));
      fireEvent.click(newBtn!);

      const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
      const swarmSelect = selects.find((s) =>
        Array.from(s.options).some((o) => o.text === 'All swarms (hive default)')
      );
      expect(swarmSelect).toBeDefined();
      const options = Array.from(swarmSelect!.options).map((o) => o.text);
      expect(options).toContain('swarm-alpha');
    });

    it('calls create subscription mutation on submit', async () => {
      mockCreateSubscription.mockResolvedValue({});
      renderEvents();
      fireEvent.click(screen.getByText('Subscriptions'));

      // Open form
      const buttons = screen.getAllByRole('button');
      const newBtn = buttons.find((b) => b.textContent?.includes('New Subscription'));
      fireEvent.click(newBtn!);

      // Fill form
      const hiveSelect = screen.getByText('Select hive...').closest('select') as HTMLSelectElement;
      fireEvent.change(hiveSelect, { target: { value: 'hive_1' } });

      const eventInput = screen.getByPlaceholderText('push, pull_request.*, issues.opened');
      fireEvent.change(eventInput, { target: { value: 'push, issues.opened' } });

      fireEvent.click(screen.getByText('Create'));

      await waitFor(() => {
        expect(mockCreateSubscription).toHaveBeenCalledWith(expect.objectContaining({
          hive_id: 'hive_1',
          source: 'github',
          event_types: ['push', 'issues.opened'],
          priority: 100,
        }));
      });
    });

    it('opens edit form when clicking edit on subscription card', () => {
      renderEvents();
      fireEvent.click(screen.getByText('Subscriptions'));

      const editButtons = screen.getAllByTitle('Edit');
      fireEvent.click(editButtons[0]);
      expect(screen.getByText('Edit Subscription')).toBeDefined();
    });

    it('calls delete mutation for subscription', async () => {
      mockDeleteSubscription.mockResolvedValue({});
      renderEvents();
      fireEvent.click(screen.getByText('Subscriptions'));

      const deleteButtons = screen.getAllByTitle('Delete');
      fireEvent.click(deleteButtons[0]);

      await waitFor(() => {
        expect(mockDeleteSubscription).toHaveBeenCalledWith('sub_1');
      });
    });

    it('calls update mutation to toggle subscription enabled', async () => {
      mockUpdateSubscription.mockResolvedValue({});
      renderEvents();
      fireEvent.click(screen.getByText('Subscriptions'));

      // Both subs are enabled, so click first "Disable" button
      const toggleButtons = screen.getAllByTitle('Disable');
      fireEvent.click(toggleButtons[0]);

      await waitFor(() => {
        expect(mockUpdateSubscription).toHaveBeenCalledWith({ id: 'sub_1', enabled: false });
      });
    });
  });

  // ── Delivery Log Tab ──

  describe('Delivery Log Tab', () => {
    it('renders delivery log entries', () => {
      renderEvents();
      fireEvent.click(screen.getByText('Delivery Log'));
      expect(screen.getByText('sent')).toBeDefined();
      expect(screen.getByText('offline')).toBeDefined();
      expect(screen.getByText('failed')).toBeDefined();
    });

    it('shows source badges in delivery log', () => {
      renderEvents();
      fireEvent.click(screen.getByText('Delivery Log'));
      const githubBadges = screen.getAllByText('github');
      expect(githubBadges.length).toBeGreaterThanOrEqual(2);
    });

    it('shows event types in delivery log entries', () => {
      renderEvents();
      fireEvent.click(screen.getByText('Delivery Log'));
      expect(screen.getByText('push')).toBeDefined();
      expect(screen.getByText('issues.opened')).toBeDefined();
    });

    it('shows error message for failed deliveries', () => {
      renderEvents();
      fireEvent.click(screen.getByText('Delivery Log'));
      expect(screen.getByText('connection refused')).toBeDefined();
    });

    it('shows swarm ID in delivery entries', () => {
      renderEvents();
      fireEvent.click(screen.getByText('Delivery Log'));
      const swarmLabels = screen.getAllByText('swarm: swarm_1');
      expect(swarmLabels.length).toBe(3);
    });

    it('shows total count', () => {
      renderEvents();
      fireEvent.click(screen.getByText('Delivery Log'));
      expect(screen.getByText('3 total')).toBeDefined();
    });

    it('renders filter inputs', () => {
      renderEvents();
      fireEvent.click(screen.getByText('Delivery Log'));
      expect(screen.getByPlaceholderText('Filter by swarm ID...')).toBeDefined();
      expect(screen.getByPlaceholderText('Filter by delivery ID...')).toBeDefined();
    });

    it('shows empty state when no deliveries', () => {
      mockUseDeliveryLog.mockReturnValue({
        data: { data: [], total: 0 },
        isLoading: false,
      });
      renderEvents();
      fireEvent.click(screen.getByText('Delivery Log'));
      expect(screen.getByText('No deliveries recorded')).toBeDefined();
    });

    it('shows pagination when total exceeds limit', () => {
      mockUseDeliveryLog.mockReturnValue({
        data: {
          data: mockDeliveryLog.data,
          total: 100,
        },
        isLoading: false,
      });
      renderEvents();
      fireEvent.click(screen.getByText('Delivery Log'));
      expect(screen.getByText('Previous')).toBeDefined();
      expect(screen.getByText('Next')).toBeDefined();
      // Text is split across nodes: "1" "–" "50" " of " "100"
      const paginationSpan = screen.getByText((_content, element) => {
        return element?.tagName === 'SPAN' && element?.textContent?.includes('of 100') || false;
      });
      expect(paginationSpan).toBeDefined();
    });

    it('disables Previous button on first page', () => {
      mockUseDeliveryLog.mockReturnValue({
        data: { data: mockDeliveryLog.data, total: 100 },
        isLoading: false,
      });
      renderEvents();
      fireEvent.click(screen.getByText('Delivery Log'));
      const prevButton = screen.getByText('Previous') as HTMLButtonElement;
      expect(prevButton.disabled).toBe(true);
    });
  });

  // ── Tab Switching ──

  describe('Tab Switching', () => {
    it('closes form when switching tabs', () => {
      renderEvents();
      // Open create form
      const buttons = screen.getAllByRole('button');
      const newBtn = buttons.find((b) => b.textContent?.includes('New Rule'));
      fireEvent.click(newBtn!);
      expect(screen.getByText('New Post Rule')).toBeDefined();

      // Switch to subscriptions tab
      fireEvent.click(screen.getByText('Subscriptions'));
      expect(screen.queryByText('New Post Rule')).toBeNull();
    });

    it('changes active tab styling on click', () => {
      renderEvents();
      fireEvent.click(screen.getByText('Subscriptions'));

      const subsTab = screen.getByText('Subscriptions').closest('button');
      const rulesTab = screen.getByText('Post Rules').closest('button');
      expect(subsTab!.className).toContain('text-honey-500');
      expect(rulesTab!.className).not.toContain('text-honey-500');
    });
  });
});
