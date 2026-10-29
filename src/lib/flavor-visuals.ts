import lemonBox from "@/assets/cajas/lemon.webp";
import peachBox from "@/assets/cajas/peach.webp";
import rawBox from "@/assets/cajas/raw.webp";
import watermelonBox from "@/assets/cajas/watermelon.webp";
import type { FlavorKey } from "@/lib/seal-plans";

/**
 * Lo que necesita el rediseño lp2 (Juan 2026-10-13) para pintar un sabor: su caja
 * recortada y sus colores.
 *
 * Las cajas son los recortes sin fondo de la landing «No es cansancio»
 * (`nw-lp2-caja-*.webp` del tema), recortados al contenido y a 480 px, unos 25 KB
 * cada uno. Van como import estático y NO desde el CDN del tema: allí pesan
 * ~190 KB cada una y dependen de un tema concreto (t/37). El import las deja en
 * /_next/static/media, que sale del origen de Vercel por `assetPrefix` (el App
 * Proxy no sirve /public), y ese origen está en el img-src de la CSP.
 *
 * Raw (2026-10-29) sale de `nw-lp2-caja-raw-560.webp`, la del «Incluye» de la ficha:
 * la caja de Lemon recoloreada al azul de Raw con «SALTY RAW» en el lateral, no una
 * foto propia. A los tamaños del portal (hasta 176 px) no se nota; cuando haya foto
 * de la caja de verdad, se cambia el fichero con el mismo recorte (480 px de ancho).
 *
 * Colores: `panel` es el degradado de «Tres sabores» suavizado, para que la caja,
 * que ya lleva el color fuerte en el lateral, se recorte contra él. `disc` es el
 * círculo de las versiones pequeñas (tarjeta «Tu plan» de Cuenta).
 */
export interface FlavorVisual {
  box: string;
  panel: string;
  disc: string;
}

export const FLAVOR_VISUALS: Record<FlavorKey, FlavorVisual> = {
  "salty-lemon": {
    box: lemonBox.src,
    panel: "radial-gradient(110% 90% at 70% 22%, #FAFBC8 0%, #EEF08A 45%, #E1E46A 100%)",
    disc: "#EBEE62",
  },
  "salty-watermelon": {
    box: watermelonBox.src,
    panel: "radial-gradient(110% 90% at 70% 22%, #FFE6E2 0%, #FBC2BA 45%, #F4A096 100%)",
    disc: "#F8B9B2",
  },
  "salty-peach": {
    box: peachBox.src,
    panel: "radial-gradient(110% 90% at 70% 22%, #FFF1E3 0%, #FDD5AB 45%, #F7B77D 100%)",
    disc: "#FBD3A9",
  },
  // El azul de Raw del tema (--raw: #9DBCDF, medido en el sobre), suavizado como los
  // otros: su lateral ya es claro y la caja tiene que seguir recortándose contra él.
  "salty-raw": {
    box: rawBox.src,
    panel: "radial-gradient(110% 90% at 70% 22%, #F0F5FB 0%, #CFDFF1 45%, #A9C5E5 100%)",
    disc: "#C7DAEF",
  },
};

/** Para un sabor que el portal aún no conozca: panel neutro y sin caja. */
export const FALLBACK_VISUAL: FlavorVisual = {
  box: "",
  panel: "radial-gradient(110% 90% at 70% 22%, #FFFFFF 0%, #F1F0E8 50%, #E4E2D8 100%)",
  disc: "#E4E2D8",
};

export function flavorVisual(flavor: string | null | undefined): FlavorVisual {
  return (flavor && FLAVOR_VISUALS[flavor as FlavorKey]) || FALLBACK_VISUAL;
}

/**
 * Nombre corto de un sabor que el portal aún no tiene en su catálogo (p. ej.
 * «salty-mango» → «mango»), para que el panel no diga «SALTY SALTY-MANGO».
 * Así se leía Raw hasta que entró en el registro (2026-10-29).
 */
export function unknownFlavorName(flavor: string): string {
  return flavor.replace(/^salty[-\s]+/i, "").replace(/-/g, " ");
}
