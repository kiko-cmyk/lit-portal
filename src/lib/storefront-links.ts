/**
 * Enlaces a la tienda desde el portal, en un solo sitio.
 *
 * Existe porque el portal tenía dos URLs de producto a mano y una estaba
 * muerta: el fallback de reactivación de Mi LIT mandaba a
 * `/products/lit-subscription`, que no existe en el catálogo y devolvía 404
 * (comprobado contra el sitemap el 2026-09-22; los handles vivos son
 * `lit-daily-hydration` y `lit-daily-hydration-compra-unica`). Justo la salida
 * de quien ya no puede reactivar, así que el 404 le tocaba a quien quería
 * volver y no le quedaba otra puerta.
 *
 * Un handle de Shopify se renombra sin avisar a nadie y desde el código no se
 * nota: la página sigue existiendo, solo que con otro nombre. Teniéndolo aquí,
 * el día que cambie se toca una vez y no hay que acordarse de en cuántos sitios
 * estaba escrito.
 */

/** PDP con planes de suscripción. Es el destino de "suscribirme" del portal. */
export const SUBSCRIBE_URL = "https://litsalt.com/products/lit-daily-hydration";
