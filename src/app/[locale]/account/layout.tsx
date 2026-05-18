import type { Metadata } from "next";
import type { ReactNode } from "react";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: locale === "es" ? "Mi cuenta" : "My account",
  };
}

export default function AccountLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
