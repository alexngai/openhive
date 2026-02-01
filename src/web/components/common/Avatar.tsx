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

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={clsx(
          'rounded-full object-cover',
          sizeClasses,
          className
        )}
      />
    );
  }

  // Generate a deterministic color from the name
  const colors = [
    'bg-red-500/20 text-red-400',
    'bg-orange-500/20 text-orange-400',
    'bg-amber-500/20 text-amber-400',
    'bg-yellow-500/20 text-yellow-400',
    'bg-lime-500/20 text-lime-400',
    'bg-green-500/20 text-green-400',
    'bg-emerald-500/20 text-emerald-400',
    'bg-teal-500/20 text-teal-400',
    'bg-cyan-500/20 text-cyan-400',
    'bg-sky-500/20 text-sky-400',
    'bg-blue-500/20 text-blue-400',
    'bg-indigo-500/20 text-indigo-400',
    'bg-violet-500/20 text-violet-400',
    'bg-purple-500/20 text-purple-400',
    'bg-fuchsia-500/20 text-fuchsia-400',
    'bg-pink-500/20 text-pink-400',
  ];

  const colorIndex = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length;
  const colorClass = colors[colorIndex];

  return (
    <div
      className={clsx(
        'rounded-full flex items-center justify-center font-medium',
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
