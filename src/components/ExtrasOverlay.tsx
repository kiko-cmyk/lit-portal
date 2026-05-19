"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { T, useLang } from "@/lib/i18n";

interface ExtraItem {
  variantId: string;
  productId: string;
  title: string;
  price: string;
  image: string | null;
}

/**
 * Extras overlay — add a one-time product to the next shipment.
 *
 * Catalog: Shopify products tagged `add-to-box`. Per locked decision
 * 2026-04-27, no custom admin panel — Diane/Juan manage from Shopify Admin.
 *
 * Calls POST /api/subscription/extras with the selected variant ID,
 * which validates the tag and adds via Seal one-time product.
 */
export function ExtrasOverlay({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<ExtraItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<{ variantId: string; appliesFrom: string | null } | null>(
    null,
  );
  const t = useLang();

  useEffect(() => {
    api<{ items: ExtraItem[] }>("/api/subscription/extras/catalog")
      .then((d) => setItems(d.items))
      .catch(() => setError("catalog_unavailable"));
  }, []);

  const handleAdd = async (item: ExtraItem) => {
    setAdding(item.variantId);
    try {
      const res = await api<{ added: boolean; appliesFrom: string | null }>(
        "/api/subscription/extras",
        {
          method: "POST",
          body: JSON.stringify({ shopifyVariantId: item.variantId, quantity: 1 }),
        },
      );
      setAdded({ variantId: item.variantId, appliesFrom: res.appliesFrom });
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(
        code === "cutoff_passed"
          ? t({
              en: "Too late, next box ships within 72h.",
              es: "Demasiado tarde, el próximo envío sale en 72h.",
            })
          : t({
              en: "Couldn't add. Try again or contact us.",
              es: "No se pudo añadir. Inténtalo de nuevo.",
            }),
      );
    } finally {
      setAdding(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-[#0F0E1A]/70 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        className="zone-cream relative mx-auto w-full max-w-md rounded-t-3xl bg-[color:var(--color-brisky-cream)] px-6 pt-9 pb-8 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 text-2xl opacity-60"
        >
          ×
        </button>

        <div className="text-[10px] font-bold uppercase tracking-[0.25em] opacity-60">
          <T en="Add to box" es="Añadir a la caja" />
        </div>
        <h1 className="mt-2 font-display text-4xl font-black uppercase leading-none">
          <T en="Extras" es="Extras" />
          <span className="text-[color:var(--color-bold-yellow)]">.</span>
        </h1>
        <p className="mt-3 text-sm opacity-70">
          <T
            en="Pick something to slip into your next shipment."
            es="Elige algo para añadir a tu próximo envío."
          />
        </p>

        {added && (
          <div className="mt-6 rounded-2xl bg-[color:var(--color-bold-yellow)]/30 p-5">
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
              <T en="Added" es="Añadido" />
            </div>
            <div className="mt-1 text-sm">
              <T
                en="Your extra ships with the next box."
                es="Tu extra va con la próxima caja."
              />
            </div>
          </div>
        )}

        {error && !added && (
          <div className="mt-4 rounded-sm bg-red-50 px-4 py-3 text-xs text-red-700">
            {error === "catalog_unavailable"
              ? t({
                  en: "Couldn't load extras catalog. Try again.",
                  es: "No se pudo cargar el catálogo. Inténtalo de nuevo.",
                })
              : error}
          </div>
        )}

        {!items && !error && (
          <div className="mt-6 text-center text-xs uppercase tracking-[0.2em] opacity-50">
            <T en="Loading…" es="Cargando…" />
          </div>
        )}

        {items && items.length === 0 && (
          <div className="mt-6 rounded-2xl bg-[color:var(--color-sharp-white)] p-5 text-center">
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
              <T en="Coming soon" es="Pronto" />
            </div>
            <p className="mt-2 text-sm opacity-70">
              <T
                en="No extras available yet. New items drop monthly."
                es="Aún no hay extras. Suben novedades cada mes."
              />
            </p>
          </div>
        )}

        {items && items.length > 0 && !added && (
          <ul className="mt-6 space-y-3">
            {items.map((item) => (
              <li
                key={item.variantId}
                className="flex items-center gap-3 rounded-2xl bg-[color:var(--color-sharp-white)] p-3"
              >
                {item.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.image}
                    alt={item.title}
                    className="h-16 w-16 rounded-sm object-cover"
                  />
                )}
                <div className="flex-1">
                  <div className="text-xs font-bold uppercase tracking-[0.1em]">
                    {item.title}
                  </div>
                  <div className="mt-0.5 text-[11px] opacity-60">
                    €{parseFloat(item.price).toFixed(2)}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={adding !== null}
                  onClick={() => handleAdd(item)}
                  className="rounded-sm bg-[color:var(--color-lit-grey)] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.2em] text-[color:var(--color-brisky-cream)] disabled:opacity-30"
                >
                  {adding === item.variantId ? (
                    <T en="Adding…" es="Añadiendo…" />
                  ) : (
                    <T en="Add" es="Añadir" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        {added && (
          <button
            type="button"
            onClick={onClose}
            className="mt-6 w-full rounded-sm bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]"
          >
            <T en="Back to LIT" es="Volver a LIT" />
          </button>
        )}
      </div>
    </div>
  );
}
