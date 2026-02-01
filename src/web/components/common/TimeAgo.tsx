import { formatDistanceToNow, parseISO } from 'date-fns';

interface TimeAgoProps {
  date: string;
  className?: string;
}

export function TimeAgo({ date, className }: TimeAgoProps) {
  const parsed = parseISO(date);
  const formatted = formatDistanceToNow(parsed, { addSuffix: true });

  return (
    <time dateTime={date} title={parsed.toLocaleString()} className={className}>
      {formatted}
    </time>
  );
}
