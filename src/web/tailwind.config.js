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
          bg: '#0e0e0f',
          card: '#1a1a1b',
          elevated: '#272729',
          hover: '#343536',
          border: '#343536',
          text: '#d7dadc',
          'text-secondary': '#818384',
        },
        // Vote colors
        upvote: '#ff4500',
        downvote: '#7193ff',
        // Light theme colors
        light: {
          bg: '#ffffff',
          card: '#ffffff',
          elevated: '#f3f4f6',
          hover: '#e5e7eb',
          border: '#d1d5db',
          text: '#111827',
          'text-secondary': '#6b7280',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [
    typography,
  ],
};
