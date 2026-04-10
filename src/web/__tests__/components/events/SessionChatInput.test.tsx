import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SessionChatInput } from '../../../components/events/SessionChatInput';
import type { SwarmChatCapabilities } from '../../../hooks/useSessionChat';

// Mock swarmcraft types (just need the type imports to work)
vi.mock('swarmcraft/ui/embed', () => ({}));

const noop = async () => {};

function makeCaps(overrides?: Partial<SwarmChatCapabilities>): SwarmChatCapabilities {
  return {
    mail: false,
    messaging: false,
    supportsAcp: false,
    connected: false,
    protocols: [],
    ...overrides,
  };
}

describe('SessionChatInput', () => {
  describe('unavailable mode', () => {
    it('shows "Read-only session" when no capabilities provided', () => {
      render(<SessionChatInput mode="unavailable" status="ready" onSend={noop} />);
      expect(screen.getByText('Read-only session')).toBeDefined();
    });

    it('shows "Agent is offline" when not connected', () => {
      render(
        <SessionChatInput
          mode="unavailable"
          status="ready"
          onSend={noop}
          capabilities={makeCaps({ connected: false })}
        />
      );
      expect(screen.getByText('Agent is offline')).toBeDefined();
    });

    it('shows no-capabilities message when connected but no chat caps', () => {
      render(
        <SessionChatInput
          mode="unavailable"
          status="ready"
          onSend={noop}
          capabilities={makeCaps({ connected: true })}
        />
      );
      expect(screen.getByText(/does not publish chat capabilities/)).toBeDefined();
    });

    it('does not render textarea in unavailable mode', () => {
      const { container } = render(
        <SessionChatInput mode="unavailable" status="ready" onSend={noop} />
      );
      expect(container.querySelector('textarea')).toBeNull();
    });
  });

  describe('ready mode', () => {
    it('renders textarea and send button', () => {
      const { container } = render(
        <SessionChatInput mode="mail" status="ready" onSend={noop} />
      );
      expect(container.querySelector('textarea')).not.toBeNull();
      expect(screen.getByTitle('Send')).toBeDefined();
    });

    it('shows mode badge for ACP', () => {
      render(<SessionChatInput mode="acp" status="ready" onSend={noop} />);
      expect(screen.getByText('ACP')).toBeDefined();
    });

    it('shows mode badge for Mail', () => {
      render(<SessionChatInput mode="mail" status="ready" onSend={noop} />);
      expect(screen.getByText('Mail')).toBeDefined();
    });

    it('shows mode badge for Inject', () => {
      render(<SessionChatInput mode="inject" status="ready" onSend={noop} />);
      expect(screen.getByText('Inject')).toBeDefined();
    });

    it('shows ACP hint', () => {
      render(<SessionChatInput mode="acp" status="ready" onSend={noop} />);
      expect(screen.getByText(/Streaming/)).toBeDefined();
    });

    it('shows Mail hint', () => {
      render(<SessionChatInput mode="mail" status="ready" onSend={noop} />);
      expect(screen.getByText(/Async turns/)).toBeDefined();
    });

    it('shows Inject hint', () => {
      render(<SessionChatInput mode="inject" status="ready" onSend={noop} />);
      expect(screen.getByText(/One-way/)).toBeDefined();
    });

    it('disables send button when textarea is empty', () => {
      render(<SessionChatInput mode="mail" status="ready" onSend={noop} />);
      const btn = screen.getByTitle('Send');
      expect(btn.hasAttribute('disabled')).toBe(true);
    });

    it('enables send button when text is entered', () => {
      const { container } = render(
        <SessionChatInput mode="mail" status="ready" onSend={noop} />
      );
      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: 'hello' } });
      const btn = screen.getByTitle('Send');
      expect(btn.hasAttribute('disabled')).toBe(false);
    });

    it('calls onSend with trimmed text and clears input', async () => {
      const onSend = vi.fn().mockResolvedValue(undefined);
      const { container } = render(
        <SessionChatInput mode="mail" status="ready" onSend={onSend} />
      );
      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: '  hello world  ' } });
      fireEvent.click(screen.getByTitle('Send'));

      await waitFor(() => {
        expect(onSend).toHaveBeenCalledWith('hello world');
      });
      // Input should be cleared after successful send
      await waitFor(() => {
        expect(textarea.value).toBe('');
      });
    });

    it('does not send empty/whitespace-only text', () => {
      const onSend = vi.fn();
      const { container } = render(
        <SessionChatInput mode="mail" status="ready" onSend={onSend} />
      );
      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: '   ' } });
      fireEvent.click(screen.getByTitle('Send'));
      expect(onSend).not.toHaveBeenCalled();
    });

    it('sends on Enter key', async () => {
      const onSend = vi.fn().mockResolvedValue(undefined);
      const { container } = render(
        <SessionChatInput mode="mail" status="ready" onSend={onSend} />
      );
      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: 'hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await waitFor(() => {
        expect(onSend).toHaveBeenCalledWith('hello');
      });
    });

    it('does not send on Shift+Enter', () => {
      const onSend = vi.fn();
      const { container } = render(
        <SessionChatInput mode="mail" status="ready" onSend={onSend} />
      );
      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: 'hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
      expect(onSend).not.toHaveBeenCalled();
    });
  });

  describe('streaming mode', () => {
    it('disables textarea when streaming', () => {
      const { container } = render(
        <SessionChatInput mode="acp" status="streaming" onSend={noop} />
      );
      const textarea = container.querySelector('textarea')!;
      expect(textarea.disabled).toBe(true);
    });

    it('shows streaming placeholder', () => {
      const { container } = render(
        <SessionChatInput mode="acp" status="streaming" onSend={noop} />
      );
      const textarea = container.querySelector('textarea')!;
      expect(textarea.placeholder).toBe('Agent is responding...');
    });

    it('shows cancel button when onCancel provided', () => {
      const onCancel = vi.fn();
      render(
        <SessionChatInput mode="acp" status="streaming" onSend={noop} onCancel={onCancel} />
      );
      expect(screen.getByTitle('Cancel')).toBeDefined();
    });

    it('does not show cancel button when no onCancel', () => {
      render(<SessionChatInput mode="acp" status="streaming" onSend={noop} />);
      expect(screen.queryByTitle('Cancel')).toBeNull();
    });

    it('shows streaming status hint', () => {
      render(<SessionChatInput mode="acp" status="streaming" onSend={noop} />);
      expect(screen.getByText('Agent is responding...')).toBeDefined();
    });
  });

  describe('connecting/detecting states', () => {
    it('shows connecting hint', () => {
      render(<SessionChatInput mode="mail" status="connecting" onSend={noop} />);
      expect(screen.getByText('Connecting...')).toBeDefined();
    });

    it('shows detecting hint', () => {
      render(<SessionChatInput mode="mail" status="detecting" onSend={noop} />);
      expect(screen.getByText('Detecting channel...')).toBeDefined();
    });

    it('disables textarea when not ready', () => {
      const { container } = render(
        <SessionChatInput mode="mail" status="connecting" onSend={noop} />
      );
      expect(container.querySelector('textarea')!.disabled).toBe(true);
    });
  });

  describe('inject mode placeholders', () => {
    it('shows one-way placeholder for inject', () => {
      const { container } = render(
        <SessionChatInput mode="inject" status="ready" onSend={noop} />
      );
      const textarea = container.querySelector('textarea')!;
      expect(textarea.placeholder).toBe('Send a message (one-way)...');
    });
  });
});
