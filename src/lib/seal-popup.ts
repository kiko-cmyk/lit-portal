/**
 * Opens the Customer Account UI Extension as a small popup, waits for the
 * extension to postMessage the result, then closes the popup automatically.
 *
 * The popup briefly shows tracking.litsalt.com chrome (it's the only way
 * to obtain a Shopify-signed customer JWT). Width/height are kept minimal
 * and the customer is back on the LIT portal within <2 s on the happy path.
 */

const EXTENSION_BASE = "https://tracking.litsalt.com/account/pages/lit-customer-account";
const POPUP_WIDTH = 420;
const POPUP_HEIGHT = 360;
const TIMEOUT_MS = 30_000;

export type SealAction = "add_remove_products" | "change_interval" | "edit_address";

export interface SealMutationResult {
  ok: boolean;
  response?: unknown;
  error?: string;
}

export async function runSealMutation(
  action: SealAction,
  payload: Record<string, unknown>,
): Promise<SealMutationResult> {
  // Center the popup relative to the current window so it's predictable.
  const left = window.screenX + (window.outerWidth - POPUP_WIDTH) / 2;
  const top = window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2;

  const url = new URL(EXTENSION_BASE);
  url.searchParams.set("action", action);
  url.searchParams.set("payload", JSON.stringify(payload));

  const popup = window.open(
    url.toString(),
    "lit-seal-mutate",
    `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top},popup=yes,scrollbars=yes,noopener=no,noreferrer=no`,
  );
  if (!popup) {
    return { ok: false, error: "popup_blocked" };
  }

  return new Promise<SealMutationResult>((resolve) => {
    let settled = false;
    const settle = (result: SealMutationResult) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(closedCheck);
      clearTimeout(timeoutTimer);
      try {
        popup.close();
      } catch {
        // Popup may already be closed by the extension itself.
      }
      resolve(result);
    };

    const onMessage = (ev: MessageEvent) => {
      if (!ev.data || typeof ev.data !== "object") return;
      if ((ev.data as { source?: string }).source !== "lit-customer-account-extension") return;
      const data = ev.data as {
        source: string;
        ok: boolean;
        action: string;
        response?: unknown;
        error?: string;
      };
      if (data.action !== action) return;
      settle({ ok: data.ok, response: data.response, error: data.error });
    };

    window.addEventListener("message", onMessage);

    // If the customer closes the popup themselves, treat as cancellation.
    const closedCheck = setInterval(() => {
      if (popup.closed) settle({ ok: false, error: "popup_closed_by_user" });
    }, 400);

    // Safety net: if the extension never posts a message (network issue,
    // JWT failure, etc.), don't leave the caller hanging forever.
    const timeoutTimer = setTimeout(
      () => settle({ ok: false, error: "timeout" }),
      TIMEOUT_MS,
    );
  });
}
