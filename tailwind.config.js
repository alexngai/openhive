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
      },
      fontFamily: {
        sans: ['"DM Sans"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"DM Mono"', 'monospace'],
        display: ['"DM Sans"', 'system-ui', 'sans-serif'],
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
    },
  },
  plugins: [],
};
