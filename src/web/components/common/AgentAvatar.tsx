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
  className?: string;
}

export function AgentAvatar({ name, src, size = 24, className = '' }: AgentAvatarProps) {
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={`rounded-full object-cover shrink-0 ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }

  const palette = generateAgentPalette(name);

  return (
    <div className={`shrink-0 ${className}`} style={{ width: size, height: size }}>
      <BoringAvatar size={size} name={name} variant="beam" colors={palette} />
    </div>
  );
}
