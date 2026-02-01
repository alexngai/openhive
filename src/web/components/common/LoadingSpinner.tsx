import { Loader2 } from 'lucide-react';
import clsx from 'clsx';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function LoadingSpinner({ size = 'md', className }: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-6 h-6',
    lg: 'w-8 h-8',
  }[size];

  return (
    <Loader2
      className={clsx('animate-spin text-honey-500', sizeClasses, className)}
    />
  );
}

export function PageLoader() {
  return (
    <div className="flex items-center justify-center py-12">
      <LoadingSpinner size="lg" />
    </div>
  );
}

export function InlineLoader() {
  return (
    <div className="flex items-center justify-center py-4">
      <LoadingSpinner size="sm" />
    </div>
  );
}
