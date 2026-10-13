"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";
import { provinceFromEsPostalCode } from "@/lib/es-provinces";
import { Lp2Sheet, SheetTitle } from "@/components/Lp2Sheet";
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
    <Lp2Sheet onClose={onClose} busy={busy}>

        <div className="lp2-eyebrow">
          {scope === "delivery" ? (
            <T en="Delivery" es="Entrega" />
          ) : (
            <T en="Billing" es="Facturación" />
          )}
        </div>
        <SheetTitle thin={t({ en: "Your", es: "Tu" })} bold={t({ en: "address", es: "dirección" })} />
        <p className="lp2-text mt-3">
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

        <div className="mt-5 space-y-3">
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
          <div className="grid grid-cols-2 gap-3">
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
          {busy ? <T en="Saving…" es="Guardando…" /> : <T en="Save address" es="Guardar dirección" />}
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
      <span className="lp2-eyebrow">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="lp2-field"
      />
    </label>
  );
}
