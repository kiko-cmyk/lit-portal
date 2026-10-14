"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { T, useLang, useLangValue } from "@/lib/i18n";
import type { ReferralCodeResponse } from "@/lib/types";

/** La foto del banner, en el CDN de Shopify. */
const FRIENDS_PHOTO = "https://cdn.shopify.com/s/files/1/0896/3319/4288/files/3-2_2.jpg?v=1789544120";

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
 *    (ProfileSurveyBanner, SubscribeBanner), pero con SU foto: dos amigos con
 *    LIT en un picnic (Juan 2026-10-14, del CDN de Shopify), no la misma imagen
 *    en todos los banners.
 *  - Los 10€ a la vista: van en el TITULAR y en amarillo, no solo en el
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
    lines.push(t({ en: `€10 off your delivery on ${d}`, es: `10€ menos en tu envío del ${d}` }));
  }
  if (rewards.queued > 0) {
    lines.push(
      rewards.queued === 1
        ? t({ en: "€10 waiting for your next delivery", es: "10€ esperando a tu próximo envío" })
        : t({
            en: `${rewards.queued} rewards of €10 waiting for your next deliveries`,
            es: `${rewards.queued} premios de 10€ esperando a tus próximos envíos`,
          }),
    );
  }

  // Sin margen propio desde el rediseño lp2 (2026-10-13): Suscripción y Cuenta
  // separan sus tarjetas con el hueco de la columna (16 px en móvil, 24 en
  // escritorio), y un margen aquí se sumaría a ese hueco. `placement` queda como
  // atributo, por si las dos pantallas vuelven a necesitar algo distinto.
  return (
    <section
      data-placement={placement}
      className="relative isolate mx-6 overflow-hidden rounded-[24px] bg-[#16130C] px-6 py-7 text-[#F2EEE1] md:mx-0 md:rounded-[28px] md:px-10 md:py-9"
      style={{
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.06) inset, 0 26px 54px -22px rgba(30,24,12,0.5), 0 8px 16px -10px rgba(30,24,12,0.3)",
        isolation: "isolate",
      }}
    >
      {/* Su foto (Juan 2026-10-14): dos amigos con LIT en un picnic, del CDN
          de Shopify (está en el img-src de la CSP). `srcSet` con el ancho que
          sirve el CDN, para que el móvil no baje los 480 KB del original: unos
          160 KB a 800 px. Encuadre en las caras, que están arriba a la derecha;
          en escritorio la tarjeta es ancha y baja, y al 24 % se cortaba la cara
          de ella por los ojos (Juan 2026-10-14): al 10 % entran las dos.
          Con algo de color y contraste, como la anterior: en blanco y negro
          puro no se reconocía a nadie. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        aria-hidden
        alt=""
        src={`${FRIENDS_PHOTO}&width=1200`}
        srcSet={[800, 1200, 1500].map((w) => `${FRIENDS_PHOTO}&width=${w} ${w}w`).join(", ")}
        sizes="(min-width: 768px) 1200px, 100vw"
        loading="lazy"
        decoding="async"
        className="pointer-events-none absolute inset-0 -z-10 h-full w-full object-cover object-[68%_22%] md:object-[center_10%]"
        style={{ filter: "saturate(0.6) contrast(1.15) brightness(1.1)" }}
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
            <T en="€10 each" es="10€ para cada uno" />
          </p>
          {/* Los 10€ en el titular y en amarillo: es lo primero que se tiene
              que leer. Dos líneas fijas («TRAE A ALGUIEN» / «Y LLÉVATE 10€»):
              dejando que el navegador partiera, la «Y» se quedaba colgando al
              final de la primera. `whitespace-nowrap` para que «10» y «€» no se
              separen nunca. */}
          {/* Dos pesos y aire entre letras (Juan 2026-10-13): con todo en
              semibold y el tracking a -0.02em «se leía como si estuviera todo
              junto». Primera línea fina, segunda en negrita, como los títulos
              de la landing. */}
          <h2
            className="mt-3 uppercase leading-[1.02] tracking-[0.01em]"
            style={{ fontFamily: "var(--font-display)", fontSize: "clamp(28px, 7.6vw, 44px)" }}
          >
            {lang === "en" ? (
              <>
                <span className="block font-light">Bring someone in</span>
                <span className="block font-semibold">
                  and get <span className="whitespace-nowrap text-[color:var(--color-bold-yellow)]">€10</span>
                </span>
              </>
            ) : (
              <>
                <span className="block font-light">Trae a alguien</span>
                <span className="block font-semibold">
                  y llévate <span className="whitespace-nowrap text-[color:var(--color-bold-yellow)]">10€</span>
                </span>
              </>
            )}
          </h2>
        </div>

        {/* La mitad derecha: qué gana cada uno, el código y la letra pequeña. */}
        <div className="mt-4 min-w-0 md:mt-0">
          <p className="text-[14px] leading-[1.55] text-[#cfc8b6] md:text-[15px]">
            <T
              en="Share your code with anyone you like. Your friend saves €10 on their first order, and you get €10 off your next delivery."
              es="Comparte tu código con quien quieras. Tu amigo ahorra 10€ en su primer pedido y tú, 10€ en tu próximo envío."
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
              en="Valid on your friend's first purchase, with a subscription or one-time."
              es="Válido en la primera compra de tu amigo, con suscripción o en compra única."
            />
            {data.termsUrl && (
              <>
                {" "}
                <a href={data.termsUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                  <T en="See terms" es="Ver condiciones" />
                </a>
              </>
            )}
          </p>
        </div>
      </div>
    </section>
  );
}
