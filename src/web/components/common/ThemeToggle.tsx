import { Sun, Moon, Monitor } from 'lucide-react';
import { useThemeStore } from '../../stores/theme';
import clsx from 'clsx';

export function ThemeToggle() {
  const { theme, setTheme } = useThemeStore();

  const themes = [
    { value: 'light' as const, icon: Sun, label: 'Light' },
    { value: 'dark' as const, icon: Moon, label: 'Dark' },
    { value: 'system' as const, icon: Monitor, label: 'System' },
  ];

  return (
    <div
      className="flex items-center gap-0.5 p-0.5 rounded-md"
      style={{ backgroundColor: 'var(--color-elevated)' }}
    >
      {themes.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          className={clsx(
            'p-1 rounded transition-colors',
          )}
          style={{
            backgroundColor: theme === value ? 'var(--color-hover)' : 'transparent',
            color: theme === value ? 'var(--color-text)' : 'var(--color-text-muted)',
          }}
          title={label}
          aria-label={`Switch to ${label} theme`}
        >
          <Icon className="w-3 h-3" />
        </button>
      ))}
    </div>
  );
}
