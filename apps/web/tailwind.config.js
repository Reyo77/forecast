import colors from 'tailwindcss/colors';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      // The existing UI uses blue-* for actions and gray-* for neutrals: remap them to the brand palette.
      colors: { blue: colors.indigo, gray: colors.slate },
      boxShadow: {
        card: '0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06)',
        pop: '0 10px 30px -8px rgba(15, 23, 42, 0.25)',
      },
    },
  },
  plugins: [],
};
