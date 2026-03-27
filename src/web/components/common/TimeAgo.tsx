import { formatDistanceToNow, parseISO } from 'date-fns';

interface TimeAgoProps {
  date: string;
  className?: string;
}

export function TimeAgo({ date, className }: TimeAgoProps) {
  const normalized = date.endsWith('Z') || date.includes('+') || date.includes('T') && date.match(/[+-]\d{2}:\d{2}$/) ? date : date + 'Z';
  const parsed = parseISO(normalized);
  const formatted = formatDistanceToNow(parsed, { addSuffix: true });

  return (
    <time dateTime={date} title={parsed.toLocaleString()} className={className}>
      {formatted}
    </time>
  );
}
