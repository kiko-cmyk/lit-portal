import type { Metadata } from "next";
import { Barlow } from "next/font/google";
import "./globals.css";
import { LangProvider } from "@/lib/i18n";

// Clash Display is not on Google Fonts — load via @fontsource/clash-display in
// production, or fallback to Helvetica Neue / Arial Black for now.
// Body font is Barlow (Google Fonts).

const barlow = Barlow({
  variable: "--font-barlow",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700", "800", "900"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Your LIT",
  description: "Post-purchase portal for LIT Hydration subscribers.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${barlow.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <LangProvider>{children}</LangProvider>
      </body>
    </html>
  );
}
