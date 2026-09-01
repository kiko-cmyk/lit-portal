"use client";

/**
 * Formulario de perfilado ("Conoce a tus clientes"). Tres pantallas, un toque
 * por opción, cero teclado. Paga 50 drops al enviar y, si procede, propone
 * espaciar la cadencia.
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

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import { T, useLang, useLangValue } from "@/lib/i18n";
import { frequencyLabel } from "@/lib/frequency-label";
import {
  HELP_URL,
  PROFILE_QUESTIONS,
  SITUACION_CON_PROBLEMA,
  isAsked,
  type ProfileQuestion,
} from "@/lib/profile-questions";
import { SURVEY_NOTICE } from "@/lib/survey-consent-copy";
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
}

const TIER_THRESHOLD = 300;

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

  const visible = useMemo(
    () => PROFILE_QUESTIONS.filter((q) => isAsked(q, answers)),
    [answers],
  );

  const pick = (key: string, value: string) =>
    setAnswers((prev) => {
      const next = { ...prev, [key]: value };
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
  const notice = useLangValue() === "es" ? SURVEY_NOTICE.es : SURVEY_NOTICE.en;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-[#0F0E1A]/70 backdrop-blur-sm sm:items-center"
      onClick={busy ? undefined : onClose}
    >
      <div
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

        {step === "intro" && (
          <>
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-[color:var(--color-warm-gray)]">
              <T en="Subscribers only" es="Solo para suscriptores" />
            </div>
            <h1 className="mt-2 font-display text-4xl font-black uppercase leading-[1.1] text-[color:var(--color-lit-grey)]">
              <T en="Tell us how you drink LIT" es="Cuéntanos cómo tomas LIT" />
            </h1>
            <p className="mt-3 text-sm text-[color:var(--color-warm-gray)]">{notice.intro}</p>
            <ul className="mt-4 space-y-1.5 text-[13px] text-[color:var(--color-warm-gray)]">
              {notice.bullets.map((b) => (
                <li key={b} className="flex gap-2">
                  <span aria-hidden>·</span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
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
                <span>
                  <T
                    en="I want LIT to use these answers to personalise what it sends me."
                    es="Quiero que LIT use estas respuestas para personalizar lo que me manda."
                  />
                </span>
              </label>
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
                <PrimaryButton onClick={submit} disabled={busy}>
                  {busy ? (
                    <T en="Saving…" es="Guardando…" />
                  ) : (
                    <T en="Send and claim 50 drops" es="Enviar y llevarme 50 drops" />
                  )}
                </PrimaryButton>
              )}
            </div>
            {/* Ninguna pregunta es obligatoria: se puede continuar sin contestar.
                Si el premio dependiera de completar, "prefiero no decirlo" sería
                una multa y el consentimiento dejaría de ser libre. */}
            <p className="mt-3 text-right text-[11px] text-[color:var(--color-warm-gray)] opacity-70">
              <T
                en="Skip any you'd rather not answer. You still get the drops."
                es="Sáltate las que no quieras. Los drops se llevan igual."
              />
            </p>
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
  return (
    <div className="mt-7">
      <p className="text-sm font-semibold text-[color:var(--color-lit-grey)]">
        {t({ en: q.en, es: q.es })}
      </p>
      {help && <p className="mt-1 text-[12px] text-[color:var(--color-warm-gray)]">{help}</p>}
      <ul className="mt-3 space-y-2">
        {q.options.map((o) => (
          <li key={o.value}>
            <button
              type="button"
              onClick={() => onPick(o.value)}
              aria-pressed={value === o.value}
              className={`flex w-full items-center justify-between rounded-[14px] border px-4 py-3 text-left text-sm ${
                value === o.value
                  ? "border-[color:var(--color-bold-yellow)] bg-[color:var(--color-bold-yellow)]/15"
                  : "border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)]"
              }`}
            >
              <span>{t({ en: o.en, es: o.es })}</span>
              {value === o.value && (
                <span aria-hidden className="text-[color:var(--color-bold-yellow)]">
                  ●
                </span>
              )}
            </button>
          </li>
        ))}
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

// ── pantalla final: drops, tier y la propuesta de cadencia ───────────────────

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
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<Subscription | null>(null);
  const [failed, setFailed] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const offer = result.cadenceOffer;
  const toGo = Math.max(0, TIER_THRESHOLD - result.balance);

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
      <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-[color:var(--color-warm-gray)]">
        {result.dropsAwarded > 0 ? `+${result.dropsAwarded} drops` : <T en="Saved" es="Guardado" />}
      </div>
      <h1 className="mt-2 font-display text-4xl font-black uppercase leading-[1.1] text-[color:var(--color-lit-grey)]">
        {result.tierCrossed ? (
          <T en="Welcome to the inner circle" es="Bienvenido al inner circle" />
        ) : (
          <T en="Thank you" es="Gracias" />
        )}
      </h1>

      <p className="mt-3 text-sm text-[color:var(--color-warm-gray)]">
        {result.tierCrossed ? (
          <T
            en={`These 50 put you at ${result.balance}. You've just crossed 300.`}
            es={`Estos 50 te han puesto en ${result.balance}. Acabas de cruzar los 300.`}
          />
        ) : toGo > 0 ? (
          <T
            en={`You've got ${result.balance} drops. ${toGo} to go for the inner circle.`}
            es={`Ya tienes ${result.balance} drops. Te faltan ${toGo} para el inner circle.`}
          />
        ) : (
          <T
            en={`You've got ${result.balance} drops.`}
            es={`Ya tienes ${result.balance} drops.`}
          />
        )}
      </p>
      {/* Un reenvío no vuelve a pagar: el importe se mide, no se asume, así que
          aquí dirá 0 y el texto tiene que ser coherente con eso. */}
      {result.dropsAwarded === 0 && (
        <p className="mt-2 text-[12px] text-[color:var(--color-warm-gray)] opacity-70">
          <T
            en="We'd already added them the first time you answered."
            es="Ya te los habíamos dado la primera vez que contestaste."
          />
        </p>
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
      className="rounded-full bg-[color:var(--color-bold-yellow)] px-6 py-3 text-[11px] font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)] disabled:opacity-30"
    >
      {children}
    </button>
  );
}
