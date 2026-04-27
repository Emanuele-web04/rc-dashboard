// FILE: postcss.config.mjs
// Purpose: Enable Tailwind v4 (CSS-first) via the dedicated PostCSS plugin.
// Layer: Build config

const config = {
  plugins: {
    "@tailwindcss/postcss": {}
  }
};

export default config;
