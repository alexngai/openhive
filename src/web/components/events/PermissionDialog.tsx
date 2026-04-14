/**
 * PermissionDialog — OpenHive-styled tool-approval UI for a ChatChannel.
 *
 * Renders pending ACP permission requests from channel.permissions as
 * Allow/Deny rows. Mounts above SessionChatInput in the trajectory view.
 */

import { ShieldAlert } from 'lucide-react';
import type { ChatChannel } from 'swarmcraft/ui/embed';

export interface PermissionDialogProps {
  channel?: ChatChannel;
}

export function PermissionDialog({ channel }: PermissionDialogProps) {
  const permissions = channel?.permissions;
  const reply = channel?.replyPermission;
  if (!permissions || permissions.length === 0 || !reply) return null;

  return (
    <div
      className="border-t px-4 py-3 space-y-2"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-secondary)' }}
    >
      {permissions.map((perm) => (
        <div
          key={perm.id}
          className="flex items-center gap-3 px-3 py-2 rounded-lg border text-sm"
          style={{
            borderColor: 'var(--color-border-warning, var(--color-border))',
            background: 'var(--color-bg)',
          }}
        >
          <ShieldAlert
            className="w-4 h-4 shrink-0"
            style={{ color: 'var(--color-text-warning, var(--color-accent))' }}
          />
          <div className="flex-1 min-w-0">
            <span className="font-medium">Tool approval: </span>
            <code
              className="text-xs px-1 py-0.5 rounded"
              style={{ background: 'var(--color-bg-tertiary)' }}
            >
              {perm.description || 'unknown tool'}
            </code>
          </div>
          <div className="flex gap-1.5 shrink-0">
            <button
              onClick={() => reply(perm.id, true)}
              className="px-2.5 py-1 text-xs font-medium rounded"
              style={{ background: 'var(--color-accent)', color: 'white' }}
            >
              Allow
            </button>
            <button
              onClick={() => reply(perm.id, false)}
              className="px-2.5 py-1 text-xs font-medium rounded border"
              style={{
                borderColor: 'var(--color-border)',
                color: 'var(--color-text-secondary)',
              }}
            >
              Deny
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
