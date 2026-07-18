import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import ThemeProvider from "@/components/ThemeProvider";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "AMD — Automated MD",
  description: "Claude-powered molecular dynamics simulation assistant",
  icons: {
    icon: [{ url: "/icon.svg?v=20260718-science-assistant", type: "image/svg+xml" }],
    shortcut: "/icon.svg?v=20260718-science-assistant",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

// Blocking script that sets the theme class before first paint to prevent FOUC.
const themeInitScript = `(function(){try{var t=localStorage.getItem("amd-theme");if(t==="light"||t==="dark"){document.documentElement.classList.add(t)}else{document.documentElement.classList.add("dark")}}catch(e){document.documentElement.classList.add("dark")}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className={`h-screen overflow-hidden ${inter.className}`}>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
