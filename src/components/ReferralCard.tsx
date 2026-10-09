"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { T, useLang, useLangValue } from "@/lib/i18n";
import { buildShareText, whatsappShareUrl } from "@/lib/referral-core";
import type { ReferralCodeResponse } from "@/lib/types";

/**
 * «Trae a alguien» (referidos, fase 0, 2026-10-10).
 *
 * Vive en el Hub, en la rama de suscripción activa, debajo de las acciones
 * rápidas. Basada en la tarjeta del hi-fi de Drops (`designs/mobile/lit-drops-hifi`):
 * índigo con el código en amarillo. Con dos diferencias deliberadas:
 *
 *  - SIN Drops: todavía no los ve el cliente (llegarán con Drops 2.0) y prometer
 *    lo que no puede ver ni gastar es una deuda, no un incentivo (el mismo motivo
 *    por el que ProfileSurveyBanner no los anuncia).
 *  - SIN enlace: se comparte el CÓDIGO y el amigo lo escribe en el checkout
 *    (decisión del 9-oct). WhatsApp lleva un texto con el código dentro.
 *
 * Pide sus propios datos y, si algo falla o el programa no está abierto para
 * este cliente (flag, B2B), no se pinta: el Hub no puede romperse por esto.
 *
 * Nunca enseña nada de los amigos: solo cuántos y cuándo llega el descuento.
 * Sin emojis y sin guiones largos.
 */
export function ReferralCard() {
  const [data, setData] = useState<ReferralCodeResponse | null>(null);
  const [copied, setCopied] = useState(false);
  // Se calcula una vez al montar. En el servidor da false, pero da igual: hasta
  // que llegan los datos (ya en el cliente) la tarjeta no pinta nada, así que no
  // hay desajuste de hidratación.
  const [canNativeShare] = useState(
    () => typeof navigator !== "undefined" && typeof navigator.share === "function",
  );
  const t = useLang();
  const lang = useLangValue();

  useEffect(() => {
    api<ReferralCodeResponse>("/api/referral/code")
      .then(setData)
      .catch(() => setData(null));
  }, []);

  if (!data?.enabled || data.status === "unavailable") return null;

  const code = data.status === "active" ? data.code : null;
  const shareText = code ? buildShareText(code, lang) : "";

  // Solo para medir cuántos comparten (el canal, nunca el destinatario).
  const track = (channel: "copy" | "whatsapp" | "native") => {
    api("/api/referral/track", { method: "POST", body: JSON.stringify({ channel }) }).catch(() => undefined);
  };

  const copy = async () => {
    if (!code) return;
    track("copy");
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt(t({ en: "Copy your code:", es: "Copia tu código:" }), code);
    }
  };

  const nativeShare = async () => {
    if (!code) return;
    track("native");
    try {
      await navigator.share({ text: shareText });
    } catch {
      // Cancelado por el cliente, o el navegador de una app no lo deja: no pasa nada.
    }
  };

  const dateLabel = (iso: string) =>
    new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "es-ES", { day: "numeric", month: "long" }).format(
      new Date(iso),
    );

  const { friendsJoined, rewards } = data;
  const lines: string[] = [];
  if (friendsJoined > 0) {
    lines.push(
      friendsJoined === 1
        ? t({ en: "1 friend has joined with your code", es: "1 amigo se ha unido con tu código" })
        : t({
            en: `${friendsJoined} friends have joined with your code`,
            es: `${friendsJoined} amigos se han unido con tu código`,
          }),
    );
  }
  if (rewards.nextDiscountedChargeAt) {
    const d = dateLabel(rewards.nextDiscountedChargeAt);
    lines.push(t({ en: `€10 off your delivery on ${d}`, es: `10 € menos en tu envío del ${d}` }));
  }
  if (rewards.queued > 0) {
    lines.push(
      rewards.queued === 1
        ? t({ en: "€10 waiting for your next delivery", es: "10 € esperando a tu próximo envío" })
        : t({
            en: `${rewards.queued} rewards of €10 waiting for your next deliveries`,
            es: `${rewards.queued} premios de 10 € esperando a tus próximos envíos`,
          }),
    );
  }

  return (
    <section
      className="relative isolate mx-6 mt-10 overflow-hidden rounded-[24px] bg-[color:var(--color-dark-indigo)] px-6 py-7 text-[color:var(--color-cream)] md:mx-0 md:mt-12 md:px-8 md:py-8"
      style={{
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.06) inset, 0 26px 54px -22px rgba(31,29,48,0.55), 0 8px 16px -10px rgba(31,29,48,0.35)",
        isolation: "isolate",
      }}
    >
      {/* El fondo del hi-fi: dos halos (amarillo y ocre) muy velados. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-25"
        style={{
          background:
            "radial-gradient(circle at 82% 28%, var(--color-bold-yellow) 0%, transparent 42%), radial-gradient(circle at 18% 82%, var(--color-retro-ochre) 0%, transparent 46%)",
        }}
      />

      <div className="relative md:flex md:items-end md:justify-between md:gap-10">
        <div className="min-w-0 md:max-w-md">
          <p
            className="text-[10px] font-bold uppercase tracking-[0.3em] text-[color:var(--color-bold-yellow)]"
            style={{ fontFamily: "var(--font-body)" }}
          >
            <T en="€10 each" es="10 € para cada uno" />
          </p>
          <h2
            className="mt-2.5 font-semibold uppercase leading-[0.9] tracking-[-0.02em]"
            style={{ fontFamily: "var(--font-display)", fontSize: "clamp(32px, 9vw, 46px)" }}
          >
            <T en="Bring someone in." es="Trae a alguien." />
          </h2>
          <p className="mt-4 text-[14px] leading-[1.55] text-[color:var(--color-warm-gray-lt)]">
            <T
              en="Give your code to anyone you like. They get €10 off their first box, and you get €10 off your next delivery."
              es="Pásale tu código a quien quieras. Tiene 10 € en su primera caja, y tú 10 € menos en tu próximo envío."
            />
          </p>
        </div>

        <div className="mt-6 md:mt-0 md:w-[320px] md:shrink-0">
          {code ? (
            <>
              <div className="flex items-center justify-between gap-3 rounded-[4px] border border-dashed border-[color:var(--color-bold-yellow)]/40 bg-white/[0.06] px-4 py-3">
                <span
                  className="font-semibold tracking-[0.08em] text-[color:var(--color-bold-yellow)]"
                  style={{ fontFamily: "var(--font-display)", fontSize: 20 }}
                  aria-label={t({ en: `Your code: ${code}`, es: `Tu código: ${code}` })}
                >
                  {code}
                </span>
                <button
                  type="button"
                  onClick={copy}
                  className="shrink-0 rounded-full border border-[color:var(--color-cream)]/25 px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-cream)] transition-colors hover:border-[color:var(--color-cream)]/60"
                >
                  {copied ? <T en="Copied" es="Copiado" /> : <T en="Copy" es="Copiar" />}
                </button>
              </div>

              <a
                href={whatsappShareUrl(shareText)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => track("whatsapp")}
                className="mt-3 block w-full rounded-full bg-[color:var(--color-bold-yellow)] px-6 py-3.5 text-center text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--color-lit-grey)] transition-transform duration-200 ease-out hover:-translate-y-[1px] active:translate-y-0"
              >
                <T en="Send on WhatsApp" es="Enviar por WhatsApp" />
              </a>
              {canNativeShare && (
                <button
                  type="button"
                  onClick={nativeShare}
                  className="mt-2 w-full py-2 text-center text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--color-cream)]/80 underline-offset-4 hover:underline"
                >
                  <T en="Other ways to share" es="Otras formas de compartir" />
                </button>
              )}
            </>
          ) : (
            <div className="rounded-[4px] border border-dashed border-[color:var(--color-cream)]/25 bg-white/[0.04] px-4 py-3.5 text-[13px] text-[color:var(--color-warm-gray-lt)]">
              <T en="Your code will be ready in a few hours." es="Tu código estará listo en unas horas." />
            </div>
          )}
        </div>
      </div>

      {lines.length > 0 && (
        <ul className="relative mt-6 space-y-1.5 border-t border-[color:var(--color-cream)]/10 pt-4 text-[13px] text-[color:var(--color-cream)]">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}

      <p className="relative mt-5 text-[11px] leading-[1.5] text-[color:var(--color-warm-gray-lt)]">
        <T
          en="For people new to LIT. Works on subscriptions and one-time orders."
          es="Para quien aún no ha probado LIT. Vale en suscripción y en compra única."
        />
        {data.termsUrl && (
          <>
            {" "}
            <a href={data.termsUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              <T en="Terms" es="Condiciones" />
            </a>
          </>
        )}
      </p>
    </section>
  );
}
