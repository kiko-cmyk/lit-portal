/**
 * Qué decir cuando falla un salto (14-oct-2026). El servidor salta el envío que se le
 * enseñó al cliente y, si ya estaba saltado, no salta otro: por eso, ante un resultado
 * desconocido, volver a pulsar es seguro y se le puede decir.
 */
export function skipErrorMessage(
  code: string | undefined,
  status: number | undefined,
  t: (m: { en: string; es: string }) => string,
): string {
  if (code === "already_charged" || code === "no_pending_attempt")
    return t({
      en: "This order is already being processed and can't be skipped.",
      es: "Este pedido ya se está procesando y no se puede saltar.",
    });
  if (code === "subscription_changed")
    return t({
      en: "Your delivery dates changed since you opened this. Reload the page to see your next delivery.",
      es: "Tus fechas de envío han cambiado desde que abriste esto. Recarga la página para ver tu próximo envío.",
    });
  if (code === "skip_unconfirmed" || code === "gateway_timeout" || status === 504)
    return t({
      en: "We couldn't confirm the skip. Tap again: if it had already gone through, no other delivery will be skipped.",
      es: "No hemos podido confirmar el salto. Vuelve a pulsar: si ya había entrado, no se saltará ningún otro envío.",
    });
  if (code === "change_applying")
    return t({
      en: "Your plan change is still being applied. You can skip in a few minutes.",
      es: "Tu cambio de plan se está terminando de aplicar. Podrás saltar el envío en unos minutos.",
    });
  if (code === "skip_failed")
    return t({
      en: "Couldn't skip and nothing was changed. Try again in a moment.",
      es: "No se pudo saltar y no se ha cambiado nada. Inténtalo de nuevo en un momento.",
    });
  return t({
    en: "Couldn't skip. Try again or contact us.",
    es: "No se pudo saltar. Inténtalo de nuevo o escríbenos.",
  });
}
