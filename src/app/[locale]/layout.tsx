import { notFound } from "next/navigation";
import { LangProvider, type Lang } from "@/lib/i18n";

/**
 * Per-locale layout. Reads the locale from the URL segment and wires the
 * LangProvider so all descendant pages render in the right language without
 * needing localStorage handshakes. Translated ES slugs (mi-lit, coleccion,
 * cuenta) are rewritten to canonical EN slugs by `src/proxy.ts` before
 * they hit this layout.
 */
const LOCALES = ["en", "es"] as const;

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!LOCALES.includes(locale as Lang)) notFound();
  return <LangProvider locale={locale as Lang}>{children}</LangProvider>;
}

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}
