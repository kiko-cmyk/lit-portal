"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";
import { provinceFromEsPostalCode } from "@/lib/es-provinces";
import { T, useLang } from "@/lib/i18n";
import type { BusinessDetails, PortalAddress } from "@/lib/types";

/**
 * BusinessAddressOverlay — edit a wholesale account's delivery or billing
 * address in a modal, the same way the subscription address is edited in the
 * rest of the portal (Juan 2026-07-29). Not a variant of AddressOverlay: that
 * one writes to Seal with its own cutoff rules and is on the subscriber's
 * critical path, so it stays untouched. This one PATCHes
 * /api/customer/business, which writes the Shopify customer record.
 *
 * The whole address goes in ONE request: it is a form, not a row, so there is
 * no reason to make the customer save five times.
 */
export function BusinessAddressOverlay({
  scope,
  value,
  onClose,
  onSaved,
}: {
  scope: "delivery" | "billing";
  /**
   * What to open with. For a billing address that does not exist yet the caller
   * passes the DELIVERY address, so the form starts from the data the customer
   * already gave us instead of an empty sheet.
   */
  value: PortalAddress | null;
  onClose: () => void;
  onSaved: (business: BusinessDetails) => void;
}) {
  const t = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    company: value?.company ?? "",
    address1: value?.address1 ?? "",
    address2: value?.address2 ?? "",
    city: value?.city ?? "",
    postalCode: value?.postalCode ?? "",
  });

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const detectedProvince = provinceFromEsPostalCode(form.postalCode)?.name ?? null;

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ updated: boolean; business: BusinessDetails }>(
        "/api/customer/business",
        { method: "PATCH", body: JSON.stringify({ [scope]: form }) },
      );
      onSaved(res.business);
      onClose();
    } catch (e) {
      const code = (e as { code?: string }).code;
      console.error("[business-address] PATCH failed", e);
      if (code === "invalid_address") {
        setError(
          t({
            en: "Some address fields look invalid. Please check them and try again.",
            es: "Algunos campos parecen incorrectos. Revísalos e inténtalo de nuevo.",
          }),
        );
      } else if (code === "rate_limited") {
        setError(
          t({
            en: "Too many tries. Wait a minute and try again.",
            es: "Demasiados intentos. Espera un minuto e inténtalo de nuevo.",
          }),
        );
      } else {
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
          {scope === "delivery" ? (
            <T en="Delivery" es="Entrega" />
          ) : (
            <T en="Billing" es="Facturación" />
          )}
        </div>
        <h1 className="mt-2 font-display text-4xl font-black uppercase leading-none text-[color:var(--color-lit-grey)]">
          <T en="Address" es="Dirección" />
        </h1>
        <p className="mt-3 text-sm text-[color:var(--color-warm-gray)]">
          {scope === "delivery" ? (
            <T
              en="Where your orders ship. It also prefills your checkout."
              es="Donde te llegan los pedidos. También se rellena sola en el checkout."
            />
          ) : (
            <T
              en="Only for invoices. It never changes where your orders ship."
              es="Solo para las facturas. No cambia dónde te llegan los pedidos."
            />
          )}
        </p>

        <div className="mt-5 space-y-2">
          <Field
            label={
              scope === "billing"
                ? t({ en: "Registered name", es: "Razón social" })
                : t({ en: "Company", es: "Empresa" })
            }
            value={form.company}
            onChange={(v) => set("company", v)}
          />
          <Field
            label={t({ en: "Address", es: "Dirección" })}
            value={form.address1}
            onChange={(v) => set("address1", v)}
          />
          <Field
            label={t({ en: "Apt / floor", es: "Piso / puerta" })}
            value={form.address2}
            onChange={(v) => set("address2", v)}
          />
          <div className="grid grid-cols-2 gap-2">
            <Field
              label={t({ en: "Postal code", es: "Código postal" })}
              value={form.postalCode}
              onChange={(v) => set("postalCode", v)}
            />
            <Field
              label={t({ en: "City", es: "Ciudad" })}
              value={form.city}
              onChange={(v) => set("city", v)}
            />
          </div>
        </div>

        {/* No province field on purpose: in Spain the province IS the first two
            digits of the postal code, so the server derives it. Echoed back so a
            customer can SEE that we understood (incident 2026-07-27). */}
        {detectedProvince && (
          <p className="mt-3 text-[11px] text-[color:var(--color-warm-gray)]">
            {t({
              en: `Province: ${detectedProvince} (from your postal code)`,
              es: `Provincia: ${detectedProvince} (según tu código postal)`,
            })}
          </p>
        )}

        {error && (
          <div className="mt-4 rounded-[12px] bg-red-50 px-4 py-3 text-xs text-red-700">{error}</div>
        )}

        <button
          type="button"
          onClick={handleSave}
          disabled={busy || !form.address1 || !form.city || !form.postalCode}
          className="mt-6 w-full rounded-full bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <T en="Saving…" es="Guardando…" /> : <T en="Save address" es="Guardar dirección" />}
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
      <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[color:var(--color-warm-gray)]">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-[12px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] px-3 py-2 text-sm text-[color:var(--color-lit-grey)] focus:border-[color:var(--color-bold-yellow)] focus:outline-none"
      />
    </label>
  );
}
