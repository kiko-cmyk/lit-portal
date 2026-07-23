/**
 * Detect known in-app browsers (embedded webviews inside native apps like
 * Outlook, Gmail, Instagram, Facebook…).
 *
 * Why this exists: the portal login redirects to Shopify's Customer Account
 * API OAuth on tracking.litsalt.com. Embedded webviews routinely fail to
 * complete that flow (blocked cross-domain navigation, third-party cookie
 * partitioning, no persistent localStorage for the token handoff). The
 * customer just lands on the webview's native "could not load" page and reads
 * it as the portal being broken — real support case: a subscriber who thought
 * it was "blocked so he couldn't cancel", opened from the Outlook mail app
 * (Jose Luis, 2026-07-23).
 *
 * We can't fix OAuth inside every webview, so LoginScreen uses this to show an
 * interstitial telling the customer to open the page in Safari/Chrome, where
 * the flow works, instead of firing a redirect the webview can't finish.
 *
 * This is a best-effort UA heuristic, so it's paired with a "continue anyway"
 * escape hatch in the UI: a false positive costs one extra tap, a false
 * negative just keeps today's behaviour.
 */

// Apps that ship their own webview and expose a recognisable UA token. First
// match wins, so the customer gets a named app when we can identify it.
const NAMED_IN_APP: Array<[RegExp, string]> = [
  [/FBAN|FBAV|FB_IAB|FBIOS/i, "Facebook"],
  [/Instagram/i, "Instagram"],
  [/\bLine\/[\d.]+/i, "LINE"],
  [/LinkedInApp/i, "LinkedIn"],
  [/Snapchat/i, "Snapchat"],
  [/musical_ly|Bytedance|TikTok/i, "TikTok"],
  [/WhatsApp/i, "WhatsApp"],
  [/Pinterest/i, "Pinterest"],
  [/OutlookMobile|Outlook-(iOS|Android)|\bOLK\b|office\.outlook/i, "Outlook"],
  [/GSA\//i, "Google"],
];

export interface InAppBrowserInfo {
  /** True when the UA looks like an embedded webview, not a real browser. */
  inApp: boolean;
  /** Human-friendly app name when we can identify it, else null. */
  app: string | null;
}

export function detectInAppBrowser(ua: string | undefined | null): InAppBrowserInfo {
  if (!ua) return { inApp: false, app: null };

  for (const [re, app] of NAMED_IN_APP) {
    if (re.test(ua)) return { inApp: true, app };
  }

  // Generic Android WebView: the UA carries a "; wv)" marker.
  if (/Android/i.test(ua) && /;\s*wv[)\s;]/i.test(ua)) {
    return { inApp: true, app: null };
  }

  // Generic iOS WKWebView — catches custom in-app browsers (such as Outlook's)
  // that don't advertise a token. A real iOS browser UA always carries a
  // "Safari/" token (Safari, plus Chrome=CriOS, Firefox=FxiOS, Edge=EdgiOS all
  // append it); an embedded WKWebView omits "Safari/". iPadOS Safari reports a
  // desktop Mac UA, so we scope this to the iPhone/iPod family to avoid
  // misfiring on real iPad browsers.
  const isIOSPhone = /iPhone|iPod/i.test(ua);
  if (isIOSPhone && !/Safari\//i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua)) {
    return { inApp: true, app: null };
  }

  return { inApp: false, app: null };
}
