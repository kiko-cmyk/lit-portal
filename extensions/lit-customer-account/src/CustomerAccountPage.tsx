import {
  reactExtension,
  useApi,
  Page,
  BlockStack,
  Text,
  Banner,
  Spinner,
} from "@shopify/ui-extensions-react/customer-account";
import { useEffect, useRef, useState } from "react";

/**
 * Invisible bridge popup used by the App-Proxy portal at
 * litsalt.com/apps/portal/* to perform Seal subscription mutations.
 *
 * Flow:
 *   1. Portal opens this page in a popup with action + payload in URL params.
 *   2. Page gets a Shopify-signed customer JWT via the session-token API.
 *   3. POSTs { jwt, action, payload } to our backend /api/extension/seal-mutate.
 *   4. Backend forwards to Seal's hidden edit-subscription-v04.php endpoint.
 *   5. On result, we postMessage back to window.opener and close.
 *
 * The page renders a brief status banner so the customer sees something
 * happening if the popup hangs, but the happy path closes within ~1 s.
 */

export default reactExtension("customer-account.page.render", () => <App />);

const BACKEND_ENDPOINT =
  "https://lit-portal-drab.vercel.app/api/extension/seal-mutate";

type State =
  | { phase: "init" }
  | { phase: "running" }
  | { phase: "done"; ok: boolean; detail?: string };

function App() {
  const { sessionToken } = useApi();
  const ranRef = useRef(false);
  const [state, setState] = useState<State>({ phase: "init" });

  useEffect(() => {
    // useEffect re-runs in dev; guard against double-firing the mutation.
    if (ranRef.current) return;
    ranRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const action = params.get("action");
    const payloadRaw = params.get("payload");
    if (!action || !payloadRaw) {
      setState({
        phase: "done",
        ok: false,
        detail: "Missing ?action= or ?payload= query params",
      });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(payloadRaw);
    } catch {
      setState({ phase: "done", ok: false, detail: "Invalid JSON in payload" });
      return;
    }

    setState({ phase: "running" });

    (async () => {
      try {
        const jwt = await sessionToken.get();
        const res = await fetch(BACKEND_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({ action, payload }),
        });
        const body = await res.json().catch(() => ({}));
        const ok = res.ok && body?.success === true;

        // postMessage back to the opener and close. Using "*" target is
        // safe-ish here because we send no secrets in the body; receiver
        // verifies action match.
        window.opener?.postMessage(
          {
            source: "lit-customer-account-extension",
            ok,
            action,
            response: body,
          },
          "*",
        );
        setState({ phase: "done", ok, detail: ok ? "Applied" : JSON.stringify(body) });
        // Auto-close after a short pause so user can see the success banner
        // in case they're watching, then control returns to the portal.
        setTimeout(() => window.close(), ok ? 600 : 4000);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        window.opener?.postMessage(
          {
            source: "lit-customer-account-extension",
            ok: false,
            action,
            error: detail,
          },
          "*",
        );
        setState({ phase: "done", ok: false, detail });
      }
    })();
  }, [sessionToken]);

  return (
    <Page title="LIT">
      <BlockStack spacing="loose">
        {state.phase === "init" || state.phase === "running" ? (
          <>
            <Spinner size="large" />
            <Text>Updating your subscription…</Text>
          </>
        ) : state.ok ? (
          <Banner status="success">Done. Returning to your portal…</Banner>
        ) : (
          <Banner status="critical">
            We couldn't update your subscription. {state.detail ?? ""}
          </Banner>
        )}
      </BlockStack>
    </Page>
  );
}
