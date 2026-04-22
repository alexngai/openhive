import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Theme = 'dark' | 'light' | 'system';
export type TextScale = 'sm' | 'md' | 'lg' | 'xl';

const BASE_FONT_SIZE_PX = 15;
const TEXT_SCALE_FACTORS: Record<TextScale, number> = {
  sm: 0.9,
  md: 1.0,
  lg: 1.125,
  xl: 1.25,
};

interface ThemeState {
  theme: Theme;
  resolvedTheme: 'dark' | 'light';
  textScale: TextScale;
  setTheme: (theme: Theme) => void;
  setTextScale: (scale: TextScale) => void;
}

function getSystemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(theme: Theme): 'dark' | 'light' {
  if (theme === 'system') {
    return getSystemTheme();
  }
  return theme;
}

function applyTheme(theme: 'dark' | 'light') {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'dark') {
    root.classList.add('dark');
    root.classList.remove('light');
  } else {
    root.classList.add('light');
    root.classList.remove('dark');
  }
}

function applyTextScale(scale: TextScale) {
  if (typeof document === 'undefined') return;
  const factor = TEXT_SCALE_FACTORS[scale] ?? 1;
  document.documentElement.style.fontSize = `${BASE_FONT_SIZE_PX * factor}px`;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'dark',
      resolvedTheme: 'dark',
      textScale: 'md',
      setTheme: (theme: Theme) => {
        const resolvedTheme = resolveTheme(theme);
        applyTheme(resolvedTheme);
        set({ theme, resolvedTheme });
      },
      setTextScale: (textScale: TextScale) => {
        applyTextScale(textScale);
        set({ textScale });
      },
    }),
    {
      name: 'openhive-theme',
      onRehydrateStorage: () => (state) => {
        if (state) {
          const resolvedTheme = resolveTheme(state.theme);
          applyTheme(resolvedTheme);
          applyTextScale(state.textScale ?? 'md');
          state.resolvedTheme = resolvedTheme;
        }
      },
    }
  )
);

// Listen for system theme changes
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    const state = useThemeStore.getState();
    if (state.theme === 'system') {
      const resolvedTheme = e.matches ? 'dark' : 'light';
      applyTheme(resolvedTheme);
      useThemeStore.setState({ resolvedTheme });
    }
  });
}
