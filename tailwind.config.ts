import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f5f7fb",
          100: "#e7ebf4",
          200: "#c9d2e4",
          300: "#9aa8c8",
          400: "#6478a4",
          500: "#3f5281",
          600: "#2c3b65",
          700: "#1f2a4a",
          800: "#141c33",
          900: "#0b111f",
          950: "#060a15",
        },
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
