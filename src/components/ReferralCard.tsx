"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { T, useLang, useLangValue } from "@/lib/i18n";
import { FRIENDS_PHOTO_DATA_URI } from "@/lib/friends-photo";
import type { ReferralCodeResponse } from "@/lib/types";

interface ReferralCardProps {
  /**
   * Dónde va, para el margen: en Suscripción (Hub) sigue el ritmo de sus
   * secciones (40-48px encima); en Cuenta, el de las suyas (12px debajo, igual
   * que ProfileSurveyBanner y cada `Section`).
   */
  placement: "hub" | "account";
}

/**
 * «Trae a alguien» (referidos, fase 0, 2026-10-10).
 *
 * Vive en las DOS pantallas con suscripción (Juan, 2026-10-13): Suscripción,
 * debajo de las acciones rápidas, y Cuenta, debajo del banner del perfilado.
 * Solo con la suscripción ACTIVA: el programa es para quien está suscrito.
 *
 * ── Diseño (Juan, 2026-10-13) ──
 *
 *  - Fondo: el mismo negro con foto velada que el resto de banners del portal
 *    (ProfileSurveyBanner, SubscribeBanner), pero con SU foto: amigos pasándolo
 *    bien (`friends-photo.ts`), no la misma imagen en todos los banners.
 *  - Los 10 € a la vista: van en el TITULAR y en amarillo, no solo en el
 *    antetítulo pequeño.
 *  - Equilibrada: el titular a la izquierda; el texto, el código y la letra
 *    pequeña a la derecha. Con solo el código a la derecha, esa mitad se veía
 *    vacía.
 *  - Solo el código, con su botón de copiar. Fuera WhatsApp y «otras formas de
 *    compartir»: el cliente se lo pasa a quien quiera, como quiera.
 *  - La letra pequeña dice que solo vale en la PRIMERA compra del amigo.
 *
 * Sin enlace: se comparte el CÓDIGO y el amigo lo escribe en el checkout
 * (decisión del 9-oct). Sin Drops: todavía no los ve el cliente (llegarán con
 * Drops 2.0), y prometer lo que no puede ver ni gastar es una deuda.
 *
 * Pide sus propios datos y, si algo falla o el programa no está abierto para
 * este cliente (flag REFERRALS, B2B), no se pinta: ninguna pantalla puede
 * romperse por esto. Nunca enseña nada de los amigos: solo cuántos y cuándo
 * llega el descuento. Sin emojis y sin guiones largos.
 */
export function ReferralCard({ placement }: ReferralCardProps) {
  const [data, setData] = useState<ReferralCodeResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const t = useLang();
  const lang = useLangValue();

  useEffect(() => {
    api<ReferralCodeResponse>("/api/referral/code")
      .then(setData)
      .catch(() => setData(null));
  }, []);

  if (!data?.enabled || data.status === "unavailable") return null;

  const code = data.status === "active" ? data.code : null;

  const copy = async () => {
    if (!code) return;
    // Solo para medir cuántos lo comparten (el gesto, nunca el destinatario).
    api("/api/referral/track", { method: "POST", body: JSON.stringify({ channel: "copy" }) }).catch(() => undefined);
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt(t({ en: "Copy your code:", es: "Copia tu código:" }), code);
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

  const margin = placement === "hub" ? "mt-10 md:mt-12" : "mb-3";

  return (
    <section
      className={`relative isolate mx-6 ${margin} overflow-hidden rounded-[24px] bg-[#16130C] px-6 py-7 text-[#F2EEE1] md:mx-0 md:px-10 md:py-9`}
      style={{
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.06) inset, 0 26px 54px -22px rgba(30,24,12,0.5), 0 8px 16px -10px rgba(30,24,12,0.3)",
        isolation: "isolate",
      }}
    >
      {/* Su foto: tres amigos corriendo juntos (foto9 del banco de marca). Con
          algo de color y de contraste: en blanco y negro puro, como el resto de
          banners, la foto (desenfocada por el movimiento) se quedaba en manchas
          y no se reconocía a nadie. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-cover"
        style={{
          backgroundImage: `url(${FRIENDS_PHOTO_DATA_URI})`,
          backgroundPosition: "center 30%",
          filter: "saturate(0.6) contrast(1.15) brightness(1.1)",
        }}
      />
      {/* El velo. En móvil el texto ocupa toda la tarjeta, de arriba abajo; en
          escritorio hay texto a los DOS lados, así que cierra en los extremos y
          se abre en el centro, que es donde están los amigos. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 md:hidden"
        style={{
          background:
            "linear-gradient(180deg, rgba(13,10,6,.86) 0%, rgba(13,10,6,.62) 40%, rgba(13,10,6,.88) 100%)",
        }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 hidden md:block"
        style={{
          background:
            "linear-gradient(90deg, rgba(13,10,6,.9) 0%, rgba(13,10,6,.5) 46%, rgba(13,10,6,.5) 54%, rgba(13,10,6,.86) 100%)",
        }}
      />

      <div className="relative md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,380px)] md:items-center md:gap-12">
        <div className="min-w-0">
          <p
            className="text-[11px] font-bold uppercase tracking-[0.3em] text-[color:var(--color-bold-yellow)]"
            style={{ fontFamily: "var(--font-body)" }}
          >
            <T en="€10 each" es="10 € para cada uno" />
          </p>
          {/* Los 10 € en el titular y en amarillo: es lo primero que se tiene
              que leer. Dos líneas fijas («TRAE A ALGUIEN» / «Y LLÉVATE 10 €»):
              dejando que el navegador partiera, la «Y» se quedaba colgando al
              final de la primera. `whitespace-nowrap` para que «10» y «€» no se
              separen nunca. */}
          <h2
            className="mt-2.5 font-semibold uppercase leading-[0.92] tracking-[-0.02em]"
            style={{ fontFamily: "var(--font-display)", fontSize: "clamp(30px, 8.4vw, 50px)" }}
          >
            {lang === "en" ? (
              <>
                <span className="block">Bring someone in</span>
                <span className="block">
                  and get <span className="whitespace-nowrap text-[color:var(--color-bold-yellow)]">€10</span>
                </span>
              </>
            ) : (
              <>
                <span className="block">Trae a alguien</span>
                <span className="block">
                  y llévate <span className="whitespace-nowrap text-[color:var(--color-bold-yellow)]">10 €</span>
                </span>
              </>
            )}
          </h2>
        </div>

        {/* La mitad derecha: qué gana cada uno, el código y la letra pequeña. */}
        <div className="mt-4 min-w-0 md:mt-0">
          <p className="text-[14px] leading-[1.55] text-[#cfc8b6] md:text-[15px]">
            <T
              en="Send your code to anyone you like. They get €10 off their first order, and you get €10 off your next delivery."
              es="Envía tu código a quien tú quieras. Tendrá 10 € de descuento en su primer pedido, y tú 10 € menos en tu próximo envío."
            />
          </p>

          <div className="mt-5">
            {code ? (
              <div className="flex items-center justify-between gap-3 rounded-[6px] border border-dashed border-[color:var(--color-bold-yellow)]/45 bg-white/[0.06] px-4 py-3.5">
                <span
                  className="min-w-0 truncate font-semibold tracking-[0.06em] text-[color:var(--color-bold-yellow)]"
                  style={{ fontFamily: "var(--font-display)", fontSize: 22 }}
                  aria-label={t({ en: `Your code: ${code}`, es: `Tu código: ${code}` })}
                >
                  {code}
                </span>
                <button
                  type="button"
                  onClick={copy}
                  className="shrink-0 rounded-full bg-[color:var(--color-sharp-white)] px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-lit-grey)] transition-transform duration-200 ease-out hover:-translate-y-[1px] active:translate-y-0"
                >
                  {copied ? <T en="Copied" es="Copiado" /> : <T en="Copy" es="Copiar" />}
                </button>
              </div>
            ) : (
              <div className="rounded-[6px] border border-dashed border-[#F2EEE1]/25 bg-white/[0.04] px-4 py-3.5 text-[13px] text-[#b3ab98]">
                <T en="Your code will be ready in a few hours." es="Tu código estará listo en unas horas." />
              </div>
            )}
          </div>

          {lines.length > 0 && (
            <ul className="mt-4 space-y-1 text-[13px] text-[#F2EEE1]">
              {lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}

          <p className="mt-4 text-[11px] leading-[1.5] text-[#b3ab98]">
            <T
              en="Only valid on your friend's first purchase, with a subscription or one-time."
              es="Solo vale para la primera compra de tu amigo, con suscripción o en compra única."
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
        </div>
      </div>
    </section>
  );
}
