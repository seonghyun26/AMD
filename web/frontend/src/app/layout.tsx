import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import ThemeProvider from "@/components/ThemeProvider";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "AMD — Ahn MD",
  description: "Claude-powered molecular dynamics simulation assistant",
  icons: { icon: "/icon.svg" },
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
