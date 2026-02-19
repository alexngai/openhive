/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/web/index.html',
    './src/web/**/*.{js,ts,jsx,tsx}',
    './references/swarmcraft/src/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // OpenHive brand accent
        honey: {
          50: '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          300: '#fcd34d',
          400: '#fbbf24',
          500: '#f59e0b',
          600: '#d97706',
          700: '#b45309',
          800: '#92400e',
          900: '#78350f',
          950: '#451a03',
        },
        // Slack-inspired dark workspace palette
        workspace: {
          bg: '#1a1d21',
          sidebar: '#19171d',
          surface: '#222529',
          elevated: '#2c2d31',
          hover: '#35373b',
          active: '#1164a3',
          border: '#35373b',
          'border-subtle': '#2c2d31',
          text: '#d1d2d3',
          'text-secondary': '#ababad',
          'text-muted': '#7a7b7e',
        },
        // Vote colors
        upvote: '#ff4500',
        downvote: '#7193ff',

        // SwarmCraft visualization theme tokens (from Tailwind v4 @theme block)
        void: '#06060a',
        deep: '#0a0a10',
        surface: '#101018',
        elevated: '#16161f',
        hover: '#1c1c28',
        'border-subtle': '#1e1e2a',
        'border-default': '#2a2a3a',
        'text-primary': '#e4e4ed',
        'text-secondary': '#8888a0',
        'text-muted': '#5a5a70',
        accent: '#7c3aed',
        'accent-dim': '#5b21b6',
        node: {
          file: '#3b82f6',
          folder: '#6366f1',
          class: '#f59e0b',
          function: '#10b981',
          interface: '#ec4899',
          import: '#6b7280',
          method: '#14b8a6',
        },
      },
      fontFamily: {
        sans: ['"DM Sans"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"DM Mono"', 'monospace'],
        display: ['"DM Sans"', 'system-ui', 'sans-serif'],
        'sc-sans': ['"Outfit"', 'system-ui', 'sans-serif'],
        'sc-mono': ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.75rem', { lineHeight: '1.125rem' }],   // 12px
        'xs': ['0.8125rem', { lineHeight: '1.25rem' }],   // 13px
        'sm': ['0.875rem', { lineHeight: '1.375rem' }],   // 14px
        'base': ['0.9375rem', { lineHeight: '1.5rem' }],  // 15px
        'lg': ['1.0625rem', { lineHeight: '1.625rem' }],  // 17px
        'xl': ['1.1875rem', { lineHeight: '1.75rem' }],   // 19px
        '2xl': ['1.375rem', { lineHeight: '1.875rem' }],  // 22px
        '3xl': ['1.625rem', { lineHeight: '2.125rem' }],  // 26px
      },
      spacing: {
        '4.5': '1.125rem', // 18px
      },
      // SwarmCraft animations
      animation: {
        breathe: 'breathe 3s ease-in-out infinite',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'sc-slide-in': 'sc-slide-in 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        'sc-slide-up': 'sc-slide-up 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        'sc-fade-in': 'sc-fade-in 0.3s ease-out',
      },
      // SwarmCraft shadows
      boxShadow: {
        glow: '0 0 20px rgba(124, 58, 237, 0.4)',
        'glow-soft': '0 0 40px rgba(124, 58, 237, 0.15)',
      },
    },
  },
  plugins: [],
};
