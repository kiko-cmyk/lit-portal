"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";
import { T, useLang } from "@/lib/i18n";
import type { Subscription, SubscriptionAddress } from "@/lib/types";

/**
 * AddressOverlay — edit the shipping address on the active subscription.
 *
 * PATCHes /api/subscription/address (Seal s_* + Shopify default address).
 * Enforces the 24h cutoff server-side; surfaces "cutoff_passed" inline.
 */
export function AddressOverlay({
  subscription,
  onClose,
  onUpdated,
}: {
  subscription: Subscription;
  onClose: () => void;
  onUpdated: (updated: Subscription) => void;
}) {
  const t = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<SubscriptionAddress>(
    subscription.shippingAddress ?? {
      firstName: "",
      lastName: "",
      address1: "",
      address2: null,
      city: "",
      postalCode: "",
      province: null,
      provinceCode: null,
      country: "España",
      countryCode: "ES",
      phone: null,
    },
  );

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ subscription: Subscription | null }>(
        "/api/subscription/address",
        {
          method: "PATCH",
          body: JSON.stringify({
            firstName: form.firstName || undefined,
            lastName: form.lastName || undefined,
            address1: form.address1,
            address2: form.address2 || undefined,
            city: form.city,
            postalCode: form.postalCode,
            country: form.country,
            countryCode: form.countryCode,
            province: form.province || undefined,
            provinceCode: form.provinceCode || undefined,
            // phone deliberately omitted — managed from Cuenta > Mis datos,
            // not from the shipping address form (Juan 2026-05-22).
          }),
        },
      );
      if (res.subscription) onUpdated(res.subscription);
      onClose();
    } catch (e) {
      const code = (e as { code?: string }).code;
      console.error("[address] PATCH failed", e);
      if (code === "cutoff_passed") {
        setError(
          t({
            en: "Too late, your next box ships within 24h.",
            es: "Demasiado tarde, tu próxima caja sale en 24h.",
          }),
        );
      } else if (code === "contract_not_found" || code === "seal_sub_not_found") {
        setError(
          t({
            en: "There's an issue with your subscription. Please contact support.",
            es: "Hay un problema con tu suscripción. Por favor, contacta a soporte.",
          }),
        );
      } else if (code === "invalid_country_code" || code === "invalid_postal_code" || code === "invalid_province_code" || code === "invalid_address") {
        setError(
          t({
            en: "Some address fields look invalid. Please check them and try again.",
            es: "Algunos campos parecen incorrectos. Revísalos e inténtalo de nuevo.",
          }),
        );
      } else {
        // Fallback: show the code small so we can see it during testing.
        const codeSuffix = code ? ` (${code})` : "";
        setError(
          t({
            en: `Couldn't save. Try again or contact us.${codeSuffix}`,
            es: `No se pudo guardar. Inténtalo de nuevo o escríbenos.${codeSuffix}`,
          }),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends keyof SubscriptionAddress>(k: K, v: SubscriptionAddress[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-[#0F0E1A]/70 backdrop-blur-sm sm:items-center"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="zone-cream relative mx-auto w-full max-w-md rounded-t-[24px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-brisky-cream)] px-6 pt-9 pb-8 sm:rounded-[24px]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label="Close"
          className="absolute right-4 top-4 text-2xl opacity-60 disabled:opacity-30"
        >
          ×
        </button>

        <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]">
          <T en="Shipping" es="Envío" />
        </div>
        <h1 className="mt-2 font-display text-4xl font-black uppercase leading-none text-[color:var(--color-lit-grey)]">
          <T en="Address" es="Dirección" />
        </h1>
        <p className="mt-3 text-sm text-[color:var(--color-warm-gray)]">
          <T
            en="Takes effect on your next shipment."
            es="Aplica desde tu próximo envío."
          />
        </p>

        <div className="mt-5 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Field label={t({ en: "First name", es: "Nombre" })} value={form.firstName} onChange={(v) => set("firstName", v)} />
            <Field label={t({ en: "Last name", es: "Apellido" })} value={form.lastName} onChange={(v) => set("lastName", v)} />
          </div>
          <Field label={t({ en: "Address", es: "Dirección" })} value={form.address1} onChange={(v) => set("address1", v)} />
          <Field label={t({ en: "Apt / floor", es: "Piso / puerta" })} value={form.address2 ?? ""} onChange={(v) => set("address2", v || null)} />
          <div className="grid grid-cols-2 gap-2">
            <Field label={t({ en: "Postal code", es: "Código postal" })} value={form.postalCode} onChange={(v) => set("postalCode", v)} />
            <Field label={t({ en: "City", es: "Ciudad" })} value={form.city} onChange={(v) => set("city", v)} />
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-[12px] bg-red-50 px-4 py-3 text-xs text-red-700">{error}</div>
        )}

        <button
          type="button"
          onClick={handleSave}
          disabled={busy || !form.address1 || !form.city || !form.postalCode}
          className="mt-6 w-full rounded-full bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? (
            <T en="Saving…" es="Guardando…" />
          ) : (
            <T en="Save address" es="Guardar dirección" />
          )}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="mt-2 w-full text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-warm-gray)] underline"
        >
          <T en="Cancel" es="Cancelar" />
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[color:var(--color-warm-gray)]">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-[12px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] px-3 py-2 text-sm text-[color:var(--color-lit-grey)] focus:border-[color:var(--color-bold-yellow)] focus:outline-none"
      />
    </label>
  );
}
