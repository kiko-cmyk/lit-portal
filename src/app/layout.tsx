import type { Metadata } from "next";
import { Barlow, Barlow_Condensed } from "next/font/google";
import "./globals.css";

// Body workhorse + the editorial condensed cuts the v2 design relies on.
const barlow = Barlow({
  variable: "--font-barlow",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700", "800", "900"],
  display: "swap",
});

const barlowCondensed = Barlow_Condensed({
  variable: "--font-barlow-condensed",
  subsets: ["latin", "latin-ext"],
  weight: ["500", "600", "700", "800"],
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
    shortcut: "https://litsalt.com/cdn/shop/t/31/assets/lit-logo-dark-indigo.png",
    apple: "https://litsalt.com/cdn/shop/t/31/assets/lit-logo-dark-indigo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${barlow.variable} ${barlowCondensed.variable} h-full antialiased`}
    >
      <head>
        {/*
          Clash Display from Fontshare is the v2 display face. We preconnect
          + preload the stylesheet so it's available before first paint of
          the hero. Falls back to Helvetica Neue / Arial Black via the
          --font-display token in globals.css when the network blocks it.
        */}
        <link rel="preconnect" href="https://api.fontshare.com" crossOrigin="anonymous" />
        <link
          href="https://api.fontshare.com/v2/css?f[]=clash-display@400,500,600,700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
