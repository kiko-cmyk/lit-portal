"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";
import { T, useLang } from "@/lib/i18n";
import type { Subscription, SubscriptionAddress } from "@/lib/types";

/**
 * AddressOverlay — edit the shipping address on the active subscription.
 *
 * PATCHes /api/subscription/address (Seal s_* + Shopify default address).
 * Enforces the 72h cutoff server-side; surfaces "cutoff_passed" inline.
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
  // Shopify scope restrictions block direct contract mutations from our
  // backend (write_own_subscription_contracts only sees app-owned contracts;
  // Seal-owned ones are invisible). Until the Subscription Apps Program
  // approves us, address changes redirect to Seal's hosted portal.
  const sealPortalUrl = subscription.payment?.sealEditUrl ?? null;
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
            phone: form.phone || undefined,
          }),
        },
      );
      if (res.subscription) onUpdated(res.subscription);
      onClose();
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(
        code === "cutoff_passed"
          ? t({
              en: "Too late — your next box ships within 72h.",
              es: "Demasiado tarde — tu próxima caja sale en 72h.",
            })
          : t({
              en: "Couldn't save. Try again.",
              es: "No se pudo guardar. Inténtalo de nuevo.",
            }),
      );
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends keyof SubscriptionAddress>(k: K, v: SubscriptionAddress[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

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
          <T en="Shipping" es="Envío" />
        </div>
        <h1 className="mt-2 font-display text-4xl font-black uppercase leading-none">
          <T en="Address" es="Dirección" />
          <span className="text-[color:var(--color-bold-yellow)]">.</span>
        </h1>
        <p className="mt-3 text-sm opacity-70">
          <T
            en="Takes effect on your next box (if outside the 72h cutoff)."
            es="Aplica desde tu próxima caja (si estás fuera del cutoff de 72h)."
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
          <Field label={t({ en: "Phone", es: "Teléfono" })} value={form.phone ?? ""} onChange={(v) => set("phone", v || null)} />
        </div>

        {error && (
          <div className="mt-4 rounded-sm bg-red-50 px-4 py-3 text-xs text-red-700">{error}</div>
        )}

        <a
          href={sealPortalUrl ?? "#"}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            if (!sealPortalUrl) e.preventDefault();
          }}
          className={`mt-6 block w-full rounded-sm py-4 text-center text-xs font-black uppercase tracking-[0.2em] ${
            sealPortalUrl
              ? "bg-[color:var(--color-bold-yellow)] text-[color:var(--color-lit-grey)]"
              : "bg-[color:var(--color-bold-yellow)]/30 text-[color:var(--color-lit-grey)]/40 cursor-not-allowed"
          }`}
        >
          <T en="Manage address" es="Gestionar dirección" />
        </a>
        <p className="mt-2 text-[10px] uppercase tracking-[0.18em] opacity-50 text-center">
          <T en="Opens secure subscription portal" es="Abre el portal seguro de suscripción" />
        </p>
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
      <span className="text-[10px] font-bold uppercase tracking-[0.18em] opacity-60">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-sm border border-[color:var(--color-lit-grey)]/15 bg-[color:var(--color-sharp-white)] px-3 py-2 text-sm focus:border-[color:var(--color-lit-grey)] focus:outline-none"
      />
    </label>
  );
}
