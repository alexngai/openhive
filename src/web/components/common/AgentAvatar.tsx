/**
 * AgentAvatar — Boring-avatars based agent avatar matching SwarmCraft.
 *
 * Uses the same deterministic palette generation as SwarmCraft's AgentPortrait
 * so agent avatars are visually consistent across all views.
 */

import BoringAvatar from 'boring-avatars';
import { generateAgentPalette } from 'swarmcraft/ui/embed';

interface AgentAvatarProps {
  name: string;
  src?: string | null;
  size?: number;
  borderColor?: string;
  className?: string;
}

export function AgentAvatar({ name, src, size = 24, borderColor, className = '' }: AgentAvatarProps) {
  const borderStyle = borderColor
    ? { border: `2px solid ${borderColor}`, borderRadius: '9999px' }
    : undefined;

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={`rounded-full object-cover shrink-0 ${className}`}
        style={{ width: size, height: size, ...borderStyle }}
      />
    );
  }

  const palette = generateAgentPalette(name);

  return (
    <div
      className={`shrink-0 rounded-full overflow-hidden ${className}`}
      style={{ width: size, height: size, ...borderStyle }}
    >
      <BoringAvatar size={borderColor ? size - 4 : size} name={name} variant="beam" colors={palette} />
    </div>
  );
}
