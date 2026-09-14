/**
 * Tests del enrutado de idioma del portal (src/proxy.ts). Sin framework,
 * aserciones a mano, igual que el resto de los scripts del repo.
 *
 *   npm test
 *   npx tsx scripts/test-proxy-redirect.ts
 *
 * Qué protege, y por qué merece un test propio.
 *
 * Los parámetros de este portal NO son decoración: son la acción. `?action=skip`
 * viene del aviso T-2 antes del cobro, `?action=survey` del formulario de
 * perfilado y `?action=plan&frequency=` de la propuesta de cadencia. Cada uno es
 * un email ya enviado a miles de personas.
 *
 * `browserRelativeRedirect` construía el destino solo desde `pathname`, así que
 * las dos ramas que redirigen (ruta sin idioma, y slug legacy `tu-lit`/
 * `your-lit`) se comían la query. El cliente pulsaba el enlace, aterrizaba en el
 * Hub con un 308 limpio y una página que carga perfectamente, y no pasaba nada.
 * Sin error en ningún sitio. Desde fuera se lee como "nadie hace clic".
 *
 * Y son justo las dos ramas de los enlaces VIEJOS, sobre los que no tenemos
 * ningún control: ya están en la bandeja de entrada de quien los recibió.
 *
 * LO QUE ESTE TEST NO CUBRE, dicho para que nadie lo dé por cubierto: el prefijo
 * del App Proxy (`/apps/portal`) sale de `NEXT_PUBLIC_PORTAL_BASE_PATH`, que se
 * lee al cargar el módulo y aquí está vacía. Así que estas aserciones fijan la
 * QUERY y la forma de la ruta, no el prefijo. El prefijo se comprueba contra
 * producción con un curl después de desplegar:
 *
 *   curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" \
 *     "https://litsalt.com/apps/portal/my-lit?action=survey"
 *
 * y tiene que devolver 308 hacia /apps/portal/es/mi-lit?action=survey.
 */

import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

let failures = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

/** Simula lo que ve el proxy detrás del App Proxy de Shopify. */
function pedir(url: string): NextRequest {
  return new NextRequest(new URL(url, "https://lit-portal-drab.vercel.app"), {
    headers: { "x-forwarded-host": "litsalt.com", "x-forwarded-proto": "https" },
  });
}

function destino(url: string): string | null {
  const res = proxy(pedir(url));
  if (!res) return null;
  const loc = res.headers.get("location");
  return loc;
}

// ── La query sobrevive al redirect ───────────────────────────────────────────

console.log("\n── ruta sin idioma ──");

const sinIdioma = destino("/my-lit?action=survey");
check("redirige al idioma por defecto", !!sinIdioma && sinIdioma.includes("/es/mi-lit"), sinIdioma ?? "sin redirect");
check("y CONSERVA el parámetro", !!sinIdioma && sinIdioma.includes("action=survey"), sinIdioma ?? "");

const multiParam = destino("/my-lit?action=plan&frequency=3mo");
check(
  "conserva varios parámetros",
  !!multiParam && multiParam.includes("action=plan") && multiParam.includes("frequency=3mo"),
  multiParam ?? "",
);

const sinQuery = destino("/my-lit");
check("sin query no inventa una '?'", !!sinQuery && !sinQuery.includes("?"), sinQuery ?? "");

console.log("\n── slug legacy (enlaces vivos en emails ya enviados) ──");

const legacyEs = destino("/es/tu-lit?action=skip");
check("tu-lit → mi-lit", !!legacyEs && legacyEs.includes("/es/mi-lit"), legacyEs ?? "");
check("y conserva el ?action=skip del aviso T-2", !!legacyEs && legacyEs.includes("action=skip"), legacyEs ?? "");

const legacyEn = destino("/en/your-lit?action=survey");
check("your-lit → my-lit", !!legacyEn && legacyEn.includes("/en/my-lit"), legacyEn ?? "");
check("y conserva su parámetro", !!legacyEn && legacyEn.includes("action=survey"), legacyEn ?? "");

console.log("\n── lo que NO debe redirigir ──");

check("la ruta con idioma no redirige (se sirve tal cual)", destino("/es/mi-lit?action=survey") === null);
check("las rutas de API se saltan enteras", destino("/api/hub/dashboard?x=1") === null);
check("los estáticos se saltan", destino("/favicon.ico") === null);

console.log("\n── el host ──");

const host = destino("/my-lit?action=survey");
check(
  "el redirect apunta a litsalt.com, no al host de Vercel",
  !!host && host.includes("litsalt.com") && !host.includes("vercel.app"),
  host ?? "",
);

console.log("");
if (failures > 0) {
  console.error(`${failures} fallo(s)`);
  process.exit(1);
}
console.log("Todo en verde.");
