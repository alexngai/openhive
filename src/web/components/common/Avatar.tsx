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
    xs: 'w-4 h-4 text-2xs',
    sm: 'w-6 h-6 text-xs',
    md: 'w-8 h-8 text-sm',
    lg: 'w-10 h-10 text-base',
    xl: 'w-14 h-14 text-lg',
  }[size];

  const iconSize = {
    xs: 'w-2.5 h-2.5',
    sm: 'w-3 h-3',
    md: 'w-4 h-4',
    lg: 'w-5 h-5',
    xl: 'w-7 h-7',
  }[size];

  const shapeClass = isAgent ? 'hex-avatar' : 'rounded';

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={clsx('object-cover', shapeClass, sizeClasses, className)}
      />
    );
  }

  const colors = [
    'bg-amber-500/15 text-amber-400',
    'bg-orange-500/15 text-orange-400',
    'bg-rose-500/15 text-rose-400',
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
  ];

  const colorIndex = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length;
  const colorClass = colors[colorIndex];

  return (
    <div
      className={clsx(
        'flex items-center justify-center font-medium',
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
