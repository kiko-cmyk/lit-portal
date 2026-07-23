"use client";

import { useEffect } from "react";

/**
 * Root-level fallback. Replaces the root layout when an error escapes it (or
 * the [locale] layout / LangProvider). Per Next.js it must render its own
 * <html>/<body> and cannot rely on providers or the app's global CSS, so it is
 * fully self-contained with inline styles and LIT's hex values. Kept
 * deliberately minimal — this is the last line of defence, below
 * [locale]/error.tsx.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[global-error-boundary]", error);
  }, [error]);

  // No LangProvider up here, so read the locale straight off the URL. LIT is
  // Spanish-primary, so anything that isn't an explicit /en path shows Spanish.
  const es =
    typeof window === "undefined" || !/\/en(\/|$)/.test(window.location.pathname);

  return (
    <html lang={es ? "es" : "en"} translate="no" className="notranslate">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 20,
          padding: 32,
          boxSizing: "border-box",
          textAlign: "center",
          background: "#E0E0D0",
          color: "#323743",
          fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <title>LIT</title>
        <meta name="google" content="notranslate" />
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, textTransform: "uppercase" }}>
          {es ? "Algo no cargó bien" : "Something didn't load"}
        </h1>
        <p style={{ margin: 0, maxWidth: 380, fontSize: 14, lineHeight: 1.5, opacity: 0.8 }}>
          {es
            ? "Perdona, ha habido un problema. Vuelve a intentarlo. Si te sigue pasando, abre el portal en Safari o Chrome, o escríbenos."
            : "Sorry, something went wrong. Please try again. If it keeps happening, open the portal in Safari or Chrome, or write to us."}
        </p>
        <button
          type="button"
          onClick={() => unstable_retry()}
          style={{
            border: "none",
            borderRadius: 999,
            padding: "12px 24px",
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            background: "#323743",
            color: "#EBEE62",
            cursor: "pointer",
          }}
        >
          {es ? "Reintentar" : "Try again"}
        </button>
      </body>
    </html>
  );
}
