import { User, Bot } from 'lucide-react';
import clsx from 'clsx';

interface AvatarProps {
  src?: string | null;
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  isAgent?: boolean;
  className?: string;
}

export function Avatar({ src, name, size = 'md', isAgent = true, className }: AvatarProps) {
  const sizeClasses = {
    xs: 'w-6 h-6 text-xs',
    sm: 'w-8 h-8 text-sm',
    md: 'w-10 h-10 text-base',
    lg: 'w-14 h-14 text-lg',
    xl: 'w-20 h-20 text-2xl',
  }[size];

  const iconSize = {
    xs: 'w-3 h-3',
    sm: 'w-4 h-4',
    md: 'w-5 h-5',
    lg: 'w-7 h-7',
    xl: 'w-10 h-10',
  }[size];

  // Hexagonal shape for agents, round for humans
  const shapeClass = isAgent ? 'hex-avatar' : 'rounded-full';

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={clsx(
          'object-cover',
          shapeClass,
          sizeClasses,
          className
        )}
      />
    );
  }

  // Generate a deterministic warm color from the name
  const colors = [
    'bg-amber-500/15 text-amber-400',
    'bg-orange-500/15 text-orange-400',
    'bg-rose-500/15 text-rose-400',
    'bg-red-500/15 text-red-400',
    'bg-emerald-500/15 text-emerald-400',
    'bg-teal-500/15 text-teal-400',
    'bg-cyan-500/15 text-cyan-400',
    'bg-sky-500/15 text-sky-400',
    'bg-blue-500/15 text-blue-400',
    'bg-indigo-500/15 text-indigo-400',
    'bg-violet-500/15 text-violet-400',
    'bg-purple-500/15 text-purple-400',
    'bg-fuchsia-500/15 text-fuchsia-400',
    'bg-pink-500/15 text-pink-400',
    'bg-lime-500/15 text-lime-400',
    'bg-yellow-500/15 text-yellow-400',
  ];

  const colorIndex = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length;
  const colorClass = colors[colorIndex];

  return (
    <div
      className={clsx(
        'flex items-center justify-center font-medium transition-all duration-200',
        shapeClass,
        sizeClasses,
        colorClass,
        className
      )}
    >
      {isAgent ? (
        <Bot className={iconSize} />
      ) : (
        name.charAt(0).toUpperCase()
      )}
    </div>
  );
}
