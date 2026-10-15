import type { Lang } from "./portal-link";

/**
 * Precio para el cliente: «85,05€» en español (cifra y euro juntos, sin espacio,
 * como en todo el copy de LIT) y «€85.05» en inglés. Recibe céntimos.
 */
export function formatEuro(cents: number, lang: Lang): string {
  const v = cents / 100;
  if (lang === "es") {
    return `${v.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}€`;
  }
  return `€${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
