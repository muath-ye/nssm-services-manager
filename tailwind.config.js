/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

module.exports = {
  // Only our own files; resources/js/neutralino.js is a large generated library.
  content: ['./resources/index.html', './resources/app.js', './resources/api.js'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Segoe UI Variable Text"', '"Segoe UI Variable"', '"Segoe UI"', 'system-ui', 'sans-serif'],
      },
      colors: {
        surface: token('surface'),
        card: token('card'),
        cardhover: token('cardhover'),
        control: token('control'),
        stroke: token('stroke'),
        fg: token('fg'),
        fg2: token('fg2'),
        fg3: token('fg3'),
        accent: token('accent'),
        accenthover: token('accenthover'),
        onaccent: token('onaccent'),
        subtle: token('subtle'),
        ok: token('ok'),
        bad: token('bad'),
        warn: token('warn'),
      },
    },
  },
  plugins: [],
};
