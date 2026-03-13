import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${inter.variable}`}>
      <body className={`h-screen overflow-hidden bg-gray-950 text-gray-100 ${inter.className}`}>
        {children}
      </body>
    </html>
  );
}
