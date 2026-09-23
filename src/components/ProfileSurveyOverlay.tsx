"use client";

/**
 * Formulario de perfilado ("Conoce a tus clientes"). Tres pantallas, un toque
 * por opción, cero teclado. Al enviar entrega un descuento de 5 € a quien no
 * tiene suscripción viva y, si procede, propone espaciar la cadencia.
 *
 * Los drops se siguen pagando por detrás, pero NO se mencionan en pantalla
 * (Juan 2026-09-22): ni los drops ni la Colección están visibles todavía para
 * el cliente, así que anunciar un saldo que no puede ver ni gastar prometía
 * algo que no existe.
 *
 * Carcasa: el bottom-sheet crema de SkipOverlay, que es la convención del área
 * personal. Arquitectura de pasos: la de CancelTakeover, con el estado de las
 * respuestas en el padre.
 *
 * Dos cosas que NO se hacen aquí, a propósito:
 *
 *  - No hay auto-avance al tocar una opción. En este repo tocar SELECCIONA y hay
 *    un botón de continuar (CancelTakeover, SkipOverlay). Cambiar esa convención
 *    en el formulario más largo del portal es exactamente donde no conviene
 *    estrenar interacción.
 *  - No se pinta el `value` de una opción, nunca. El valor guardado es la cadena
 *    canónica del CS Platform (a veces en tercera persona: "No lo usa") y el
 *    portal es bilingüe. Se muestra `t({en, es})` y se manda `value`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { T, useLang, useLangValue } from "@/lib/i18n";
import { WaxSeal } from "@/components/WaxSeal";
import { frequencyLabel } from "@/lib/frequency-label";
import {
  HELP_URL,
  MULTI_SEP,
  PROFILE_QUESTIONS,
  SITUACION_CON_PROBLEMA,
  isAsked,
  type ProfileQuestion,
} from "@/lib/profile-questions";
import { SURVEY_CONSENT, SURVEY_NOTICE } from "@/lib/survey-consent-copy";
import type { Frequency, Subscription } from "@/lib/types";

type Step = "intro" | 1 | 2 | 3 | "done";

interface CadenceOffer {
  from: Frequency;
  to: Frequency;
  cappedAtSixMonths: boolean;
}

interface SubmitResult {
  dropsAwarded: number;
  balance: number;
  tierCrossed: boolean;
  cadenceOffer: CadenceOffer | null;
  /** El cupón de 5 €, o null. Ver `hadLiveSubscription` para qué significa null. */
  discount: { code: string; expiresAt: string } | null;
  /** true = es suscriptor y no le tocaba cupón. false + discount null = falló la emisión. */
  hadLiveSubscription: boolean;
}

export function ProfileSurveyOverlay({
  subscription,
  onClose,
  onSubscriptionUpdated,
}: {
  subscription: Subscription | null;
  onClose: () => void;
  onSubscriptionUpdated?: (s: Subscription) => void;
}) {
  const t = useLang();
  const [step, setStep] = useState<Step>("intro");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);

  // El panel es lo que scrollea (`overflow-y-auto`), no la ventana. Al pasar de
  // paso React reemplaza el contenido pero NO toca el scroll, así que el
  // cliente aterrizaba a media pantalla: veía las últimas preguntas del paso
  // nuevo y se perdía el titular y las primeras. Con tres pantallas largas eso
  // se nota en todos los saltos. (Juan 2026-09-15)
  const panelRef = useRef<HTMLDivElement>(null);

  // Respuestas previas: el formulario se puede volver a abrir para cambiarlas.
  useEffect(() => {
    let alive = true;
    api<{ answers: Record<string, string>; consent: boolean }>("/api/survey/profile")
      .then((s) => {
        if (!alive) return;
        if (s?.answers && Object.keys(s.answers).length) setAnswers(s.answers);
        if (s?.consent) setConsent(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Arriba del todo en CADA cambio de paso, incluido volver atrás y llegar a la
  // pantalla final. `behavior: "auto"` y no "smooth": el contenido ya ha
  // cambiado, así que animar el viaje enseña el paso nuevo deslizándose desde
  // un punto donde nunca estuvo.
  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [step]);

  const visible = useMemo(
    () => PROFILE_QUESTIONS.filter((q) => isAsked(q, answers)),
    [answers],
  );

  const pick = (key: string, value: string) =>
    setAnswers((prev) => {
      const next = { ...prev, [key]: value };
      // Cadena vacía = en una multi se desmarcó la última opción. Se BORRA la
      // clave en vez de mandar "": el servidor valida contra el banco y ""
      // no es ninguna opción, así que un envío con la clave vacía se rechazaría
      // entero con `invalid_option` y el cliente perdería las nueve respuestas
      // por haber cambiado de idea en una. Sin clave = sin contestar, que es
      // legítimo porque todas son opcionales.
      if (value === "") delete next[key];
      // Si una respuesta cierra la puerta de una condicional, su respuesta vieja
      // se va con ella. Sin esto, quien contesta "Crossfit" y luego cambia a "no
      // entreno" dejaría un deporte colgando que el servidor rechazaría con
      // `not_asked`, y el cliente vería un error sin entender por qué.
      for (const q of PROFILE_QUESTIONS) {
        if (q.gatedBy && !isAsked(q, next)) delete next[q.key];
      }
      return next;
    });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<SubmitResult>("/api/survey/profile", {
        method: "POST",
        body: JSON.stringify({ answers, consent }),
      });
      setResult(r);
      setStep("done");
    } catch {
      setError(
        t({
          en: "We couldn't save that. Try again in a moment.",
          es: "No hemos podido guardarlo. Inténtalo en un momento.",
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const screenOf = (n: 1 | 2 | 3) => visible.filter((q) => q.screen === n);
  const isEs = useLangValue() === "es";
  const notice = isEs ? SURVEY_NOTICE.es : SURVEY_NOTICE.en;
  // La MISMA frase que la ruta registra en `consent_version`. Ver el comentario
  // en la casilla.
  const consentText = isEs ? SURVEY_CONSENT.es : SURVEY_CONSENT.en;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-[#0F0E1A]/70 backdrop-blur-sm sm:items-center"
      onClick={busy ? undefined : onClose}
    >
      <div
        ref={panelRef}
        className="zone-cream relative mx-auto max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-[28px] bg-[color:var(--color-brisky-cream)] px-7 pt-10 pb-8 sm:rounded-[28px]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label={t({ en: "Close", es: "Cerrar" })}
          className="absolute right-4 top-4 text-2xl opacity-60 disabled:opacity-30"
        >
          ×
        </button>

        {/* INTRO (rediseñada, Juan 2026-09-10).
            Fuera "Solo para suscriptores": el formulario solo se ofrece dentro
            del portal, a quien ya tiene una suscripción, así que informaba de
            algo que el cliente ya sabe por estar donde está.

            El problema de fondo era la jerarquía: titular, párrafo y cinco
            viñetas iguales, todo en el mismo gris, así que la letra legal
            pesaba lo mismo que el motivo para empezar. Ahora hay tres niveles:
            el titular, una frase de entrada legible (el "para qué"), y la
            letra pequeña recogida en su propio bloque, separada por una línea y
            a menor tamaño. Lo legal sigue estando entero y a la vista, pero deja
            de competir con la invitación. */}
        {step === "intro" && (
          <>
            {/* `tracking-0` y `leading-[1.12]`, no el `-0.01em`/`1.05` de antes
                (Juan 2026-09-22). Clash Display en negra ya viene apretada de
                fábrica: restarle tracking a 36px pega las letras entre sí, y en
                un titular de dos líneas el interlineado corto remata el bloque.
                El texto es lo primero que se lee del formulario y estaba siendo
                lo peor maquetado. */}
            {/* "Cuéntanos sobre ti", igual que el banner que trae hasta aquí
                (Juan 2026-09-22): tres palabras caben en una línea y el titular
                deja de partirse. `word-spacing` positivo porque Clash Display
                en negra junta mucho las palabras y en mayúsculas se leen como
                un bloque; el aire va ENTRE palabras, no entre letras, que es lo
                que pedía Juan. */}
            <h1
              className="font-display text-[34px] font-black uppercase leading-[1.12] tracking-normal text-[color:var(--color-lit-grey)] sm:text-[40px]"
              style={{ wordSpacing: "0.12em" }}
            >
              <T en="Tell us about you" es="Cuéntanos sobre ti" />
            </h1>

            {/* La frase de entrada, al tamaño del cuerpo del portal y en el
                gris oscuro: es el motivo para contestar, no una nota al pie. */}
            <p className="mt-5 max-w-[34rem] text-[16px] leading-[1.6] text-[color:var(--color-lit-grey)]/80">
              {notice.intro}
            </p>

            {/* Tres datos rápidos, en horizontal: lo que de verdad decide si
                alguien empieza. Se sacan de las viñetas para que no queden
                enterrados entre la letra legal. */}
            <div className="mt-8 flex flex-wrap items-stretch gap-x-6 gap-y-4 sm:gap-x-8">
              {[
                // Contado desde el banco y no tecleado: con "9" a mano, la
                // pregunta décima (2026-09-23) habría dejado esta cifra mintiendo
                // sin que nada fallara. Es el MÁXIMO: quien no entrena ve una menos.
                { k: String(PROFILE_QUESTIONS.length), l: t({ en: "questions", es: "preguntas" }) },
                { k: "1 min", l: t({ en: "of your time", es: "de tu tiempo" }) },
                {
                  k: t({ en: "Optional", es: "Opcionales" }),
                  l: t({ en: "all of them", es: "todas ellas" }),
                },
              ].map((it) => (
                <div key={it.k}>
                  {/* `font-semibold` y no `font-bold`: en Clash Display a 22px
                      en mayúsculas, la negrita competía con el titular y estos
                      tres datos son apoyo, no titulares. */}
                  <div className="font-display text-[21px] font-semibold uppercase leading-none tracking-normal text-[color:var(--color-lit-grey)]">
                    {it.k}
                  </div>
                  {/* 11px y no 10: la condensada a 10px con tracking .22em se
                      convierte en un rayado gris que nadie lee. */}
                  <div
                    className="mt-1.5 font-semibold uppercase tracking-[0.18em] text-[color:var(--color-warm-gray)]"
                    style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
                  >
                    {it.l}
                  </div>
                </div>
              ))}
            </div>

            {/* La letra pequeña, como FICHA DE DATOS y no como lista de
                viñetas (Juan 2026-09-10).
                Cada punto ya era "etiqueta: valor", pero se pintaba como texto
                corrido detrás de un `·`, así que había que leer las cuatro
                líneas enteras para encontrar una. Ahora la etiqueta va en
                condensada, mayúsculas y espaciada (el mismo recurso que las
                filas de datos de Cuenta), y el valor debajo en su propio
                renglón: se escanea de un vistazo.

                Cada punto en su propia caja sobre `brisky-cream`, en rejilla de
                dos columnas en pantalla ancha. Deja de parecer una condición de
                contrato y se lee como lo que es: información. */}
            <div className="mt-9 border-t border-[color:var(--color-lit-grey)]/12 pt-6">
              <div
                className="mb-4 font-semibold uppercase tracking-[0.18em] text-[color:var(--color-warm-gray)]"
                style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
              >
                <T en="Your answers" es="Tus respuestas" />
              </div>
              {/* Una columna: todas al MISMO ancho (Juan 2026-09-22). En dos
                  columnas, la caja larga ocupaba la fila entera y las cortas
                  media, así que la rejilla se veía descuadrada. Con tres
                  viñetas, apilarlas cuesta menos alto de lo que parece y la
                  lectura es de arriba abajo, que es como se lee un aviso. */}
              <dl className="grid gap-2">
                {notice.bullets.map((b) => (
                  <div
                    key={b.k}
                    // El punto largo ("Dónde acaban", que lleva el aviso de la
                    // transferencia) ocupa la fila entera: partido en media
                    // columna quedaba en cinco renglones y descuadraba la
                    // rejilla, dejando además a la última caja suelta.
                    // Sobre `sharp-white`, no sobre `brisky-cream/45`. Ese
                    // crema al 45% era CASI EL MISMO tono que el panel, así que
                    // las cajas no se distinguían del fondo y el texto quedaba
                    // en 3,5:1 de contraste, por debajo del 4,5:1 que exige
                    // WCAG AA para cuerpo pequeño. Medido, no estimado.
                    className="rounded-[16px] border border-[color:var(--color-lit-grey)]/8 bg-[color:var(--color-sharp-white)] px-4 py-3.5"
                  >
                    {/* 11px y color pleno: a 9,5px y al 70% la etiqueta era un
                        rayado, no una palabra. */}
                    <dt
                      className="font-semibold uppercase tracking-[0.16em] text-[color:var(--color-lit-grey)]"
                      style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
                    >
                      {b.k}
                    </dt>
                    <dd className="mt-1.5 text-[13px] leading-[1.5] text-[color:var(--color-lit-grey)]/75">
                      {b.v}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="mt-8 flex justify-end">
              <PrimaryButton onClick={() => setStep(1)}>
                <T en="Start" es="Empezar" />
              </PrimaryButton>
            </div>
          </>
        )}

        {(step === 1 || step === 2 || step === 3) && (
          <>
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-[color:var(--color-warm-gray)]">
              {step} <T en="of" es="de" /> 3
            </div>
            <h1 className="mt-2 font-display text-3xl font-black uppercase leading-[1.1] text-[color:var(--color-lit-grey)]">
              {step === 1 && <T en="How's it going with LIT?" es="¿Cómo te va con LIT?" />}
              {step === 2 && <T en="Your LIT at home" es="Tu LIT en casa" />}
              {step === 3 && <T en="A bit about you" es="Un poco sobre ti" />}
            </h1>

            {screenOf(step).map((q) => (
              <QuestionBlock
                key={q.key}
                q={q}
                value={answers[q.key]}
                onPick={(v) => pick(q.key, v)}
              />
            ))}

            {step === 3 && (
              <label className="mt-8 flex cursor-pointer items-start gap-3 text-[13px] text-[color:var(--color-warm-gray)]">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5 h-4 w-4 flex-none accent-[color:var(--color-bold-yellow)]"
                />
                {/* El texto sale de SURVEY_CONSENT, que es EL MISMO que la
                    ruta registra en `consent_version` (Juan 2026-09-10).
                    Antes iba escrito a mano aquí y era más corto que el
                    versionado: se guardaba "aceptó la v2" mientras el cliente
                    leía otra frase, así que el registro apuntaba a un texto que
                    esa persona no había visto. Es justo lo que el módulo de
                    copy existe para evitar. */}
                <span>{consentText}</span>
              </label>
            )}

            {/* Por qué el botón está apagado. Sin esta línea, quien no marca la
                casilla ve un "Enviar" muerto y no tiene forma de saber que la
                culpa es de la casilla que tiene justo encima. Solo aparece
                cuando hace falta: si ya está marcada, no hay nada que explicar. */}
            {step === 3 && !consent && (
              <p className="mt-3 text-[12px] leading-[1.5] text-[color:var(--color-warm-gray)]">
                <T
                  en="Tick the box above to send your answers."
                  es="Marca la casilla de arriba para poder enviar tus respuestas."
                />
              </p>
            )}

            {error && <p className="mt-4 text-sm text-[color:var(--color-lit-grey)]">{error}</p>}

            <div className="mt-8 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep(step === 1 ? "intro" : ((step - 1) as 1 | 2))}
                disabled={busy}
                className="text-[11px] uppercase tracking-[0.18em] opacity-60 disabled:opacity-30"
              >
                ← <T en="Back" es="Atrás" />
              </button>
              {step < 3 ? (
                <PrimaryButton onClick={() => setStep((step + 1) as 2 | 3)}>
                  <T en="Continue" es="Continuar" />
                </PrimaryButton>
              ) : (
                // Sin la casilla no se puede enviar (Juan 2026-09-22). El
                // botón se deshabilita en vez de dejar enviar y fallar: el
                // error llegaría después de nueve preguntas y sin decir por qué.
                // La ruta lo rechaza igual, porque un `disabled` del navegador
                // no es una validación.
                <PrimaryButton onClick={submit} disabled={busy || !consent}>
                  {busy ? (
                    <T en="Saving…" es="Guardando…" />
                  ) : (
                    <T en="Send" es="Enviar" />
                  )}
                </PrimaryButton>
              )}
            </div>
            {/* Ninguna pregunta es obligatoria: se puede continuar sin
                contestar, y eso NO cambia (si el premio dependiera de
                completar, "prefiero no decirlo" sería una multa y el
                consentimiento dejaría de ser libre). Lo que se fue es el
                recordatorio en pantalla: el aviso de la intro ya dice que todas
                son opcionales, y repetirlo debajo de cada pantalla sonaba a
                disculpa. */}
          </>
        )}

        {step === "done" && result && (
          <DoneStep
            result={result}
            subscription={subscription}
            onSubscriptionUpdated={onSubscriptionUpdated}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}

// ── una pregunta ─────────────────────────────────────────────────────────────

function QuestionBlock({
  q,
  value,
  onPick,
}: {
  q: ProfileQuestion;
  value: string | undefined;
  onPick: (v: string) => void;
}) {
  const t = useLang();
  const help = t({ en: q.helpEn ?? "", es: q.helpEs ?? "" });

  const selectedSet = new Set(
    q.multi && value ? value.split(MULTI_SEP).filter(Boolean) : [],
  );

  /**
   * Añade o quita una opción y devuelve la cadena nueva.
   *
   * Se reconstruye recorriendo `q.options`, así que el orden es SIEMPRE el del
   * banco y no el de los toques: dos clientes que marcan lo mismo guardan la
   * misma cadena, que es lo que hace comparables los segmentos de Klaviyo.
   *
   * Quitar la última deja "" — el padre lo trata como "sin contestar" y no
   * manda la clave, porque todas las preguntas son opcionales.
   */
  const toggle = (v: string): string => {
    const next = new Set(selectedSet);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return q.options
      .filter((opt) => next.has(opt.value))
      .map((opt) => opt.value)
      .join(MULTI_SEP);
  };

  return (
    <div className="mt-7">
      <p className="text-sm font-semibold text-[color:var(--color-lit-grey)]">
        {t({ en: q.en, es: q.es })}
      </p>
      {help && <p className="mt-1 text-[12px] text-[color:var(--color-warm-gray)]">{help}</p>}
      <ul className="mt-3 space-y-2">
        {q.options.map((o) => {
          // En una multi el valor guardado es "A;B", así que "seleccionada" es
          // pertenencia al conjunto, no igualdad con la cadena entera.
          const selected = q.multi ? selectedSet.has(o.value) : value === o.value;
          return (
            <li key={o.value}>
              <button
                type="button"
                onClick={() => onPick(q.multi ? toggle(o.value) : o.value)}
                // `aria-pressed` en las dos: el botón se comporta como un
                // interruptor en ambos casos, y en la multi además se puede
                // apagar volviéndolo a tocar.
                aria-pressed={selected}
                className={`flex w-full items-center justify-between rounded-[14px] border px-4 py-3 text-left text-sm ${
                  selected
                    ? "border-[color:var(--color-bold-yellow)] bg-[color:var(--color-bold-yellow)]/15"
                    : "border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)]"
                }`}
              >
                <span>{t({ en: o.en, es: o.es })}</span>
                {/* Marca distinta a propósito: el punto dice "esta es LA
                    elegida" y el check dice "esta también". Con el mismo
                    símbolo, una lista de cinco opciones donde caben varias se
                    lee como si solo una pudiera estar activa. */}
                {selected && (
                  <span aria-hidden className="text-[color:var(--color-bold-yellow)]">
                    {q.multi ? "✓" : "●"}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {/* "Tengo un problema" no abre más preguntas: deriva al formulario de
          ayuda, que ya desemboca en Zendesk. Sin campo de texto libre — es donde
          alguien escribiría una condición médica sin que se la pidan, y eso no
          puede acabar en un perfil de marketing. */}
      {q.key === "situacion" && value === SITUACION_CON_PROBLEMA && (
        <a
          href={HELP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 block rounded-[14px] border border-[color:var(--color-bold-yellow)] bg-[color:var(--color-bold-yellow)]/10 px-4 py-3 text-sm underline"
        >
          <T
            en="Tell us here and we'll sort it out →"
            es="Cuéntanoslo aquí y te lo resolvemos →"
          />
        </a>
      )}
    </div>
  );
}

/**
 * "22 de octubre" / "22 October". Del ISO CRUDO y no de un `Date`, por lo mismo
 * que `formatShipDateEs`: `new Date(iso).toLocaleDateString()` se renderiza en
 * la zona del navegador, así que a alguien al oeste de UTC le imprimiría el día
 * anterior. Un cupón que parece caducar antes de tiempo es una reclamación.
 */
function formatExpiry(iso: string, lang: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "";
  const day = Number(m[3]);
  const monthIdx = Number(m[2]) - 1;
  const MESES_ES = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
  ];
  const MONTHS_EN = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return lang === "es"
    ? `${day} de ${MESES_ES[monthIdx]}`
    : `${MONTHS_EN[monthIdx]} ${day}`;
}

// ── pantalla final: el cupón y la propuesta de cadencia ──────────────────────

function DoneStep({
  result,
  subscription,
  onSubscriptionUpdated,
  onClose,
}: {
  result: SubmitResult;
  subscription: Subscription | null;
  onSubscriptionUpdated?: (s: Subscription) => void;
  onClose: () => void;
}) {
  const lang = useLangValue();
  const t = useLang();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState<Subscription | null>(null);
  const [failed, setFailed] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const offer = result.cadenceOffer;

  /**
   * Copia el código al portapapeles. Con la misma red que `LoginScreen`: la
   * Clipboard API está bloqueada en algunos webviews de apps, y ahí un
   * `prompt` deja al cliente seleccionarlo a mano en vez de dejarle tocando un
   * texto que no hace nada.
   */
  const copyCode = async () => {
    const code = result.discount?.code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt(t({ en: "Copy your code:", es: "Copia tu código:" }), code);
    }
  };

  const accept = async () => {
    if (!offer || !subscription) return;
    setBusy(true);
    setFailed(false);
    try {
      // SOLO la frecuencia. Sin boxCount, sin mix, sin flavor: ese carril no
      // toca la variante y por tanto no reprecia, ni siquiera a un legacy de
      // 67,93 €. Es más seguro que lo que manda PlanOverlay, que siempre incluye
      // boxCount y depende de una guarda del servidor para las subs fuera de rango.
      const updated = await api<Subscription>("/api/subscription/plan", {
        method: "PATCH",
        body: JSON.stringify({
          frequency: offer.to,
          sealSubscriptionId: subscription.sealSubscriptionId,
          mainItemId: subscription.mainItemId,
          currentVariantId: subscription.currentVariantId,
          currentFrequency: subscription.frequency,
          expectedLineIds: subscription.lines?.map((l) => l.itemId),
          // "natural": la próxima entrega se recoloca ya. Con "preserve" el
          // cliente que nos acaba de decir que le sobra recibiría una caja más
          // antes de notar nada, y concluiría que no ha servido.
          reanchorMode: "natural",
          source: "profile_survey",
        }),
      });
      setApplied(updated);
      onSubscriptionUpdated?.(updated);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Cabecera SIN drops (Juan 2026-09-22): los drops y la Colección no están
          visibles para el cliente, así que anunciar un saldo y un "inner circle"
          que no puede ver ni gastar era prometer algo que no existe todavía. El
          formulario los SIGUE pagando; simplemente no se cuentan aquí.

          Lo que manda ahora es el descuento, que es lo que el email promete y
          lo único de esta pantalla que el cliente puede usar hoy. */}
      {/* Cabecera. Sin eyebrow "GUARDADO": era una etiqueta de estado de
          sistema encima de un "Gracias", o sea dos formas de decir lo mismo y
          ninguna dirigida al cliente. El titular basta.

          Y el párrafo YA NO anuncia el descuento ("y aquí tienes tu
          descuento:"), porque la tarjeta de abajo se anuncia sola: el sello es
          lo primero que se ve. Presentarlo dos veces restaba fuerza a las dos.
          Dice lo que hacemos con las respuestas, que es lo único que el
          titular no cuenta. */}
      <h1 className="font-display text-4xl font-black uppercase leading-[1.05] tracking-[-0.015em] text-[color:var(--color-lit-grey)]">
        <T en="Thank you" es="Muchas gracias" />
      </h1>

      <p className="mt-3 max-w-sm text-[15px] leading-[1.55] text-[color:var(--color-lit-grey)]/80">
        <T
          en="We'll use what you told us to improve and fit what we send you to what you actually need."
          es="Usaremos lo que nos has contado para mejorar y poder ajustarnos al máximo a tus necesidades."
        />
      </p>

      {/* ── EL CUPÓN, COMO ALGO SELLADO ──
          El email promete "tu código listo para usar", así que este bloque es
          el que cumple la frase y manda en la pantalla.

          Rediseñado el 2026-09-22. El anterior era una tarjeta oscura con el
          código dentro de un recuadro de borde DISCONTINUO, y ese borde
          significa exactamente una cosa en el mundo de los cupones: "recorte
          por aquí". Leía como un vale de supermercado, no como algo de LIT.

          La idea de ahora: no es un ticket que se recorta, es algo SELLADO y
          entregado a esta persona. Por eso el WaxSeal de la marca, el mismo de
          la hero del Hub, preside la tarjeta con su texto girando en el borde,
          y el código va debajo sobre una línea limpia. Sin cajas dentro de
          cajas: una sola superficie, un solo gesto.

          Tres estados, distintos a propósito:
            1. hay código        → la tarjeta sellada.
            2. no le tocaba      → nada. Un suscriptor no tiene por qué saber
                                   que existe un cupón que no va a recibir.
            3. le tocaba y falló → "te lo mandamos por correo", nunca un error. */}
      {result.discount && (
        // SIN `overflow-hidden`: el sello sobresale por arriba a propósito y
        // recortarlo lo dejaba partido por la mitad. El contenedor exterior
        // aporta el margen para que el disco tenga sitio donde asomar.
        <div className="relative mt-14">
          {/* El sello, montado a caballo del borde: entra en la tarjeta como se
              posa un lacre sobre un sobre, no como un icono centrado dentro de
              una caja. Absoluto y centrado, encima de la banda. */}
          <div className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-1/2">
            <WaxSeal
              size={96}
              rim="CUPÓN DESCUENTO · CUPÓN DESCUENTO · CUPÓN DESCUENTO · "
              centerTop="5€"
              centerBottom="PARA TI"
            />
          </div>

          <div
            className="rounded-[24px] px-6 pb-7 pt-14 text-center text-[#F2EEE1]"
            style={{
              background:
                "linear-gradient(150deg, var(--color-lit-grey) 10%, var(--color-dark-indigo))",
              boxShadow: "0 24px 50px -22px rgba(30,24,12,0.55)",
            }}
          >

          {/* El código ES el protagonista: sin recuadro, sobre la banda, con el
              tracking abierto para que se lea carácter a carácter al teclearlo
              en el checkout. `select-all` lo selecciona entero de un toque. */}
            {/* El código ES el botón de copiar (Juan 2026-09-22). Un botón
                aparte al lado obligaría a elegir entre dos cosas que hacen lo
                mismo; así el gesto obvio, tocar el código, es el que funciona.
                `select-all` se queda como red: si el portapapeles está
                bloqueado (pasa en webviews de apps), un toque largo lo
                selecciona entero igual.

                La pista va DEBAJO y en pequeño, que es lo "sutil" que pedía
                Juan: el código sigue mandando y la instrucción no compite. */}
            <button
              type="button"
              onClick={copyCode}
              aria-label={t({ en: "Copy discount code", es: "Copiar código de descuento" })}
              className="block w-full select-all font-display text-[30px] font-black uppercase leading-none tracking-[0.14em] transition-opacity hover:opacity-80 sm:text-[34px]"
            >
              {result.discount.code}
            </button>

            {/* Un solo hueco para los dos estados: sin esto, al cambiar "Copiar
                cupón" por "Copiado" el bloque saltaba unos píxeles. */}
            <div className="mt-2.5 h-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-bold-yellow)]">
              {copied ? (
                <T en="Copied" es="Copiado" />
              ) : (
                <span className="text-[#b3ab98]">
                  <T en="Tap to copy" es="Toca para copiar el cupón" />
                </span>
              )}
            </div>

          {/* Una sola línea de apoyo, con la regla y la caducidad juntas. Antes
              eran tres renglones separados (importe, "en tu próximo pedido",
              caducidad) y competían entre ellos. */}
            <div className="mx-auto mt-4 max-w-[19rem] border-t border-[#F2EEE1]/15 pt-4 text-[12px] leading-[1.6] text-[#b3ab98]">
              <T
                en={`Discount voucher for your next order · valid until ${formatExpiry(result.discount.expiresAt, lang)}.`}
                es={`Cupón de descuento para tu próximo pedido · válido hasta el ${formatExpiry(result.discount.expiresAt, lang)}.`}
              />
            </div>
          </div>
        </div>
      )}

      {!result.discount && !result.hadLiveSubscription && (
        <div className="mt-6 rounded-[18px] border border-[color:var(--color-lit-grey)]/15 bg-[color:var(--color-sharp-white)] px-5 py-4 text-[13px] leading-[1.5] text-[color:var(--color-warm-gray)]">
          <T
            en="Your 5 € discount is on its way: we'll email it to you in a few minutes."
            es="Tu descuento de 5 € está en camino: te lo mandamos por correo en unos minutos."
          />
        </div>
      )}

      {offer && !dismissed && !applied && (
        <div className="mt-8 rounded-[18px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] p-5">
          <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-[color:var(--color-warm-gray)]">
            <T en="One more thing" es="Una cosa más" />
          </div>
          <p className="mt-2 font-display text-2xl font-black uppercase leading-tight text-[color:var(--color-lit-grey)]">
            <T en="Too much LIT?" es="¿Te sobra LIT?" />
          </p>
          <p className="mt-2 text-sm text-[color:var(--color-warm-gray)]">
            <T
              en="From what you tell us, it arrives faster than you drink it."
              es="Por lo que nos cuentas, te llega más rápido de lo que te lo bebes."
            />{" "}
            <T
              en={`We can space it out: ${frequencyLabel(offer.from, lang)} → ${frequencyLabel(offer.to, lang)}.`}
              es={`Podemos espaciarlo: ${frequencyLabel(offer.from, lang)} → ${frequencyLabel(offer.to, lang)}.`}
            />{" "}
            <T
              en="Same boxes, same price, just more time between them."
              es="Mismas cajas, mismo precio, solo más tiempo entre una y otra."
            />
          </p>
          {failed && (
            <p className="mt-3 text-[13px] text-[color:var(--color-lit-grey)]">
              <T
                en="We couldn't change it just now. It's waiting for you in My plan."
                es="No hemos podido cambiarlo ahora. Lo tienes en Mi plan cuando quieras."
              />
            </p>
          )}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <PrimaryButton onClick={accept} disabled={busy || !subscription}>
              {busy ? (
                <T en="Changing…" es="Cambiando…" />
              ) : (
                <T
                  en={`Space it to ${frequencyLabel(offer.to, lang)}`}
                  es={`Espaciar a ${frequencyLabel(offer.to, lang)}`}
                />
              )}
            </PrimaryButton>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              disabled={busy}
              className="text-[11px] uppercase tracking-[0.18em] opacity-60 disabled:opacity-30"
            >
              <T en="Not now" es="Ahora no" />
            </button>
          </div>
        </div>
      )}

      {applied && (
        <div className="mt-8 rounded-[18px] border border-[color:var(--color-bold-yellow)] bg-[color:var(--color-bold-yellow)]/10 p-5">
          <p className="font-display text-2xl font-black uppercase text-[color:var(--color-lit-grey)]">
            <T en="Done" es="Hecho" />
          </p>
          <p className="mt-2 text-sm text-[color:var(--color-warm-gray)]">
            <T
              en={`You now get one every ${frequencyLabel(applied.frequency, lang)}.`}
              es={`Ahora recibes cada ${frequencyLabel(applied.frequency, lang)}.`}
            />{" "}
            <T
              en="You can change it any time from My plan."
              es="Puedes cambiarlo cuando quieras desde Mi plan."
            />
          </p>
        </div>
      )}

      <div className="mt-8 flex justify-end">
        <PrimaryButton onClick={onClose}>
          <T en="Done" es="Listo" />
        </PrimaryButton>
      </div>
    </>
  );
}

function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-full bg-[color:var(--color-bold-yellow)] px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)] disabled:opacity-30"
    >
      {children}
    </button>
  );
}
