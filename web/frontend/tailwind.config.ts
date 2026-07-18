import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'sans-serif'],
      },
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        amd: {
          primary: "var(--amd-brand-primary)",
          secondary: "var(--amd-brand-secondary)",
          accent: "var(--amd-brand-accent)",
          science: "var(--amd-science)",
          success: "var(--amd-success)",
          warning: "var(--amd-warning)",
          danger: "var(--amd-danger)",
          surface: "var(--amd-surface)",
          muted: "var(--amd-surface-muted)",
          border: "var(--amd-border)",
          text: "var(--amd-text)",
          "text-muted": "var(--amd-text-muted)",
        },
      },
      zIndex: {
        '60': '60',
      },
    },
  },
  plugins: [],
};

export default config;
