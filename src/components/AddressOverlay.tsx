"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";
import { provinceFromEsPostalCode } from "@/lib/es-provinces";
import { Lp2Sheet, SheetTitle } from "@/components/Lp2Sheet";
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
  /**
   * Called once on a successful save, BEFORE this overlay closes itself. The
   * argument is null when Seal's read-back came up empty, which is rare and
   * harmless (the write landed): the page still owes the customer a
   * confirmation, so success must be reported either way.
   */
  onUpdated: (updated: Subscription | null) => void;
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
            // Vacío se manda como "", no como undefined: quien se muda de un
            // piso a una casa borra este campo y tiene que borrarse de verdad.
            // Con undefined, Seal conservaba el piso anterior (2026-08-12).
            address2: form.address2 ?? "",
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
      onUpdated(res.subscription ?? null);
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

  const detectedProvince =
    (form.countryCode || "ES").toUpperCase() === "ES"
      ? provinceFromEsPostalCode(form.postalCode)?.name ?? null
      : null;

  return (
    <Lp2Sheet onClose={onClose} busy={busy}>

        <div className="lp2-eyebrow">
          <T en="Shipping" es="Envío" />
        </div>
        <SheetTitle thin={t({ en: "Your", es: "Tu" })} bold={t({ en: "address", es: "dirección" })} />
        <p className="lp2-text mt-3">
          <T
            en="Takes effect on your next shipment."
            es="Aplica desde tu próximo envío."
          />
        </p>

        <div className="mt-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t({ en: "First name", es: "Nombre" })} value={form.firstName} onChange={(v) => set("firstName", v)} />
            <Field label={t({ en: "Last name", es: "Apellido" })} value={form.lastName} onChange={(v) => set("lastName", v)} />
          </div>
          <Field label={t({ en: "Address", es: "Dirección" })} value={form.address1} onChange={(v) => set("address1", v)} />
          <Field label={t({ en: "Apt / floor", es: "Piso / puerta" })} value={form.address2 ?? ""} onChange={(v) => set("address2", v || null)} />
          <div className="grid grid-cols-2 gap-3">
            <Field label={t({ en: "Postal code", es: "Código postal" })} value={form.postalCode} onChange={(v) => set("postalCode", v)} />
            <Field label={t({ en: "City", es: "Ciudad" })} value={form.city} onChange={(v) => set("city", v)} />
          </div>
        </div>

        {/* There is no province field on purpose: in Spain the province IS the
            first two digits of the postal code, so the server derives it (see
            lib/es-provinces.ts). We echo it back so a customer moving to another
            province can SEE that we understood, instead of discovering a label
            that still says her old province (incident 2026-07-27). */}
        {detectedProvince && (
          <p className="mt-3 mb-0 text-[12px] text-[#5E6168]">
            {t({
              en: `Province: ${detectedProvince} (from your postal code)`,
              es: `Provincia: ${detectedProvince} (según tu código postal)`,
            })}
          </p>
        )}

        {error && (
          <div className="lp2-notice lp2-notice--error mt-4">{error}</div>
        )}

        <button
          type="button"
          onClick={handleSave}
          disabled={busy || !form.address1 || !form.city || !form.postalCode}
          className="lp2-cta mt-6"
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
          className="lp2-link mt-4"
        >
          <T en="Cancel" es="Cancelar" />
        </button>
    </Lp2Sheet>
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
      <span className="lp2-label mb-1.5">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="lp2-field"
      />
    </label>
  );
}
