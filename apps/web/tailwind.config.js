import colors from 'tailwindcss/colors';
import plugin from 'tailwindcss/plugin';

const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];
// Neutral scale and white surface are CSS variables so the whole app flips in dark mode.
const gray = Object.fromEntries(SHADES.map((s) => [s, `rgb(var(--g-${s}) / <alpha-value>)`]));
const TINTS = [
  'red',
  'amber',
  'green',
  'emerald',
  'rose',
  'purple',
  'violet',
  'sky',
  'orange',
  'indigo',
];

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      // The existing UI uses blue-* for actions and gray-* for neutrals: remap them to the brand palette.
      colors: { blue: colors.indigo, gray },
      backgroundColor: { white: 'rgb(var(--surface) / <alpha-value>)' },
      boxShadow: {
        card: '0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06)',
        pop: '0 10px 30px -8px rgba(15, 23, 42, 0.25)',
      },
    },
  },
  plugins: [
    // Dark variants of the coloured status tints (alerts, badges): translucent fills, light text.
    plugin(({ addBase }) => {
      const rules = {};
      for (const hue of [...TINTS, 'blue']) {
        const palette = hue === 'blue' ? colors.indigo : colors[hue];
        const rgb = (hex, a) => {
          const n = parseInt(hex.slice(1), 16);
          return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${a})`;
        };
        for (const s of [50, 100])
          rules[`.dark .bg-${hue}-${s}`] = {
            backgroundColor: rgb(palette[500], s === 50 ? 0.12 : 0.2),
          };
        for (const s of [200, 300]) {
          rules[`.dark .border-${hue}-${s}`] = { borderColor: rgb(palette[500], 0.4) };
          rules[`.dark .ring-${hue}-${s}`] = { '--tw-ring-color': rgb(palette[500], 0.4) };
        }
        for (const s of [600, 700, 800, 900])
          rules[`.dark .text-${hue}-${s}`] = { color: palette[300] };
      }
      addBase(rules);
    }),
  ],
};
