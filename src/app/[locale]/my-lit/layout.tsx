import type { Metadata } from "next";
import type { ReactNode } from "react";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: locale === "es" ? "Suscripción" : "Subscription",
  };
}

export default function YourLitLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
