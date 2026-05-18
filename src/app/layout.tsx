import type { Metadata } from "next";
import { Barlow } from "next/font/google";
import "./globals.css";

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
  // Per-page titles override this via each route's generateMetadata().
  title: { default: "LIT", template: "%s — LIT" },
  description: "Post-purchase portal for LIT Hydration subscribers.",
  icons: {
    icon: [
      {
        url: "https://litsalt.com/cdn/shop/t/31/assets/lit-logo-dark-indigo.png",
        type: "image/png",
      },
    ],
    shortcut:
      "https://litsalt.com/cdn/shop/t/31/assets/lit-logo-dark-indigo.png",
    apple:
      "https://litsalt.com/cdn/shop/t/31/assets/lit-logo-dark-indigo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${barlow.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {children}
      </body>
    </html>
  );
}
