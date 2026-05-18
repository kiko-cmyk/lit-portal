import type { Metadata } from "next";
import type { ReactNode } from "react";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: locale === "es" ? "Colección" : "Collection",
  };
}

export default function CollectionLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <>{children}</>;
}
