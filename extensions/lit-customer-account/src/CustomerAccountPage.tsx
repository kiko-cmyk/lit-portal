import {
  reactExtension,
  useApi,
  Page,
  BlockStack,
  Text,
  Banner,
  Spinner,
  Heading,
} from "@shopify/ui-extensions-react/customer-account";
import { useEffect, useRef, useState } from "react";

/**
 * SPIKE E.3 — validates that Seal's hidden edit-subscription-v04.php endpoint
 * accepts JWTs minted for our app's audience (vs the Seal-only audience their
 * own portal uses).
 *
 * Customer Account UI Extensions run in a Web Worker, so we CANNOT use
 * window.location, window.opener, or window.close. The mutation params are
 * hardcoded for the spike (no-op deletion of a non-existent item). Once we
 * confirm Seal accepts our JWT, we'll wire up real params via Shopify's
 * navigation API.
 */

export default reactExtension("customer-account.page.render", () => <App />);

const BACKEND_ENDPOINT =
  "https://lit-portal-drab.vercel.app/api/extension/seal-mutate";

// Hardcoded harmless test: try to delete item 999999999 (doesn't exist) on
// juan's sub 12635109. Seal should respond with success=false but at least
// it'll PROVE whether our JWT is being accepted as auth.
const SPIKE_ACTION = "add_remove_products";
const SPIKE_PAYLOAD = {
  subscriptionId: 12635109,
  deleted_items: "999999999",
};

type State =
  | { phase: "init" }
  | { phase: "running" }
  | { phase: "done"; status: number; sealResponse: unknown; rawBody?: string };

function App() {
  const { sessionToken } = useApi();
  const ranRef = useRef(false);
  const [state, setState] = useState<State>({ phase: "init" });

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    (async () => {
      setState({ phase: "running" });
      try {
        const jwt = await sessionToken.get();
        const res = await fetch(BACKEND_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({ action: SPIKE_ACTION, payload: SPIKE_PAYLOAD }),
        });
        let parsed: unknown = null;
        const raw = await res.text();
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        setState({
          phase: "done",
          status: res.status,
          sealResponse: parsed,
          rawBody: parsed === null ? raw : undefined,
        });
      } catch (e) {
        setState({
          phase: "done",
          status: 0,
          sealResponse: { fetchError: e instanceof Error ? e.message : String(e) },
        });
      }
    })();
  }, [sessionToken]);

  return (
    <Page title="LIT — JWT spike">
      <BlockStack spacing="loose">
        <Heading>Probing Seal's hidden API</Heading>
        <Text>
          Fires a no-op mutation through our backend bridge to see whether
          Seal accepts a JWT minted for our app instead of theirs. Result
          appears below within a couple seconds.
        </Text>

        {state.phase === "running" || state.phase === "init" ? (
          <BlockStack inlineAlignment="center" spacing="tight">
            <Spinner size="large" />
            <Text>Calling backend…</Text>
          </BlockStack>
        ) : (
          <>
            <Banner status={state.status >= 200 && state.status < 300 ? "success" : "critical"}>
              HTTP {state.status}
            </Banner>
            <Text>Seal response (parsed JSON):</Text>
            <Text>
              {JSON.stringify(state.sealResponse, null, 2)}
            </Text>
            {state.rawBody && (
              <>
                <Text>Raw body (unparseable):</Text>
                <Text>{state.rawBody}</Text>
              </>
            )}
          </>
        )}
      </BlockStack>
    </Page>
  );
}
