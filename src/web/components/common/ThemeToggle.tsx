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
      className="flex items-center gap-1 p-1 rounded-lg"
      style={{ backgroundColor: 'var(--color-elevated)' }}
    >
      {themes.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          className={clsx(
            'p-1.5 rounded-md transition-colors',
            theme === value && 'theme-toggle-active'
          )}
          style={{
            backgroundColor: theme === value ? 'var(--color-hover)' : 'transparent',
            color: theme === value ? 'var(--color-text)' : 'var(--color-text-secondary)',
          }}
          title={label}
          aria-label={`Switch to ${label} theme`}
        >
          <Icon className="w-4 h-4" />
        </button>
      ))}
    </div>
  );
}
