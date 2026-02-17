import typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/web/index.html',
    './src/web/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // OpenHive brand colors (dark mode first)
        honey: {
          50: '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          300: '#fcd34d',
          400: '#fbbf24',
          500: '#f59e0b', // Primary accent
          600: '#d97706',
          700: '#b45309',
          800: '#92400e',
          900: '#78350f',
          950: '#451a03',
        },
        // Reddit-like dark theme
        dark: {
          bg: '#08080a',
          card: '#111114',
          elevated: '#19191e',
          hover: '#222229',
          border: '#1f1f27',
          text: '#e8e6e3',
          'text-secondary': '#6e6a7a',
        },
        // Vote colors
        upvote: '#ff4500',
        downvote: '#7193ff',
        // Light theme colors
        light: {
          bg: '#f8f7f4',
          card: '#ffffff',
          elevated: '#f0eeeb',
          hover: '#e4e2de',
          border: '#dbd8d3',
          text: '#1a1815',
          'text-secondary': '#7a7670',
        },
      },
      fontFamily: {
        sans: ['Manrope', 'system-ui', 'sans-serif'],
        display: ['"Instrument Serif"', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.25rem',
      },
      animation: {
        'fade-in-up': 'fade-in-up 0.3s ease-out',
        'glow-breathe': 'glow-breathe 3s ease-in-out infinite',
      },
      keyframes: {
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'glow-breathe': {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [
    typography,
  ],
};
