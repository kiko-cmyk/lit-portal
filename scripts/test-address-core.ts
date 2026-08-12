/**
 * Tests de src/lib/address-core.ts. Sin framework, igual que el resto de los
 * scripts de test del repo: aserciones a mano y dobles a medida.
 *
 *   npm test          (encadena los scripts de test del repo)
 *   npx tsx scripts/test-address-core.ts
 *
 * Qué protege. Este módulo se extrajo el 2026-08-04 para que la ruta del cliente
 * y la nueva entrada máquina a máquina (el bot de WhatsApp que cambia la
 * dirección) compartan una sola implementación. Duplicarlo sería repetir la
 * regresión de mayo, cuando se reescribió el flujo a Shopify-only creyendo que
 * Seal ignoraba los campos `s_*` y hubo que revertirlo nueve días después.
 *
 * Los casos que no se pueden romper:
 *   - la provincia derivada del código postal GANA sobre la que llegue, que es
 *     lo que arregló la incidencia del 2026-07-27 (Madrid → Asturias con
 *     `province: Madrid` contra un CP 33xxx);
 *   - los campos que Seal exige en toda edición se rellenan desde la suscripción
 *     cuando no vienen, o el edit falla entero;
 *   - con `verify`, un no-op silencioso de Seal se detecta y NO se reporta como
 *     éxito. Es el modo de fallo que importa en la entrada del bot: le dice al
 *     cliente "hecho" y no hay ninguna pantalla donde se note que no;
 *   - sin `verify`, la relectura sigue siendo tolerante. Endurecer la ruta del
 *     cliente convertiría guardados buenos en errores cuando Seal va lento.
 */

import {
  currentAddress,
  formatAddress,
  normalizeAddress,
  validateAddressInput,
  writeAddress,
  type AddressInput,
} from "@/lib/address-core";
import { seal, type SealSubscription } from "@/lib/seal";

let failures = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function throws(name: string, fn: () => unknown, code: string) {
  try {
    fn();
    failures++;
    console.error(`✗ ${name} — no lanzó nada, se esperaba ${code}`);
  } catch (err) {
    const actual = (err as { code?: string }).code;
    check(name, actual === code, `lanzó ${actual}`);
  }
}

function sub(over: Partial<SealSubscription> = {}): SealSubscription {
  return {
    id: 14030060,
    s_first_name: "Francisco",
    s_last_name: "González León",
    s_address1: "Calle de San Andrés 16",
    s_address2: "3B",
    s_city: "Madrid",
    s_zip: "28004",
    s_province: "Madrid",
    s_province_code: "M",
    s_country: "España",
    s_country_code: "ES",
    s_phone: "+34636547497",
    status: "ACTIVE",
    billing_attempts: [],
    ...over,
  } as unknown as SealSubscription;
}

const asturias: AddressInput = {
  address1: "Calle Uría 12",
  city: "Oviedo",
  postalCode: "33003",
  country: "España",
  countryCode: "ES",
  // Lo que arrastraría el formulario del portal desde la dirección anterior:
  province: "Madrid",
  provinceCode: "M",
};

// ── validación ────────────────────────────────────────────────────────────
throws("sin address1 no se valida", () => validateAddressInput({ ...asturias, address1: "" }), "invalid_address");
throws("sin CP no se valida", () => validateAddressInput({ ...asturias, postalCode: "" }), "invalid_address");
throws(
  "un país que no es ISO-2 se rechaza",
  () => validateAddressInput({ ...asturias, countryCode: "ESP" }),
  "invalid_country_code",
);
throws(
  "un CP de 2 caracteres se rechaza",
  () => validateAddressInput({ ...asturias, postalCode: "28" }),
  "invalid_postal_code",
);
check("una dirección completa pasa", (() => {
  try {
    validateAddressInput(asturias);
    return true;
  } catch {
    return false;
  }
})());

// ── normalización ─────────────────────────────────────────────────────────
{
  const n = normalizeAddress(asturias, sub());
  check(
    "la provincia sale del CP y pisa la que llegó (incidencia 2026-07-27)",
    n.province === "Asturias" && n.provinceCode === "O",
    `${n.provinceCode} ${n.province} (llegaba M Madrid)`,
  );
  check(
    "nombre, apellido y país se heredan de la suscripción",
    n.firstName === "Francisco" && n.lastName === "González León" && n.country === "España",
    `${n.firstName} ${n.lastName} / ${n.country}`,
  );
}
{
  const n = normalizeAddress({ ...asturias, countryCode: "PT", postalCode: "1000-001" }, sub());
  check(
    "fuera de España se conserva lo que llegó, nunca peor",
    n.province === "Madrid" && n.provinceCode === "M",
    `${n.provinceCode} ${n.province}`,
  );
}
throws(
  "sin apellido ni en el payload ni en la sub, no se escribe",
  () => normalizeAddress(asturias, sub({ s_last_name: "" })),
  "invalid_address",
);

// ── formato y lectura ─────────────────────────────────────────────────────
check(
  "la dirección actual se lee de los campos s_*",
  currentAddress(sub()).address1 === "Calle de San Andrés 16" && currentAddress(sub()).postalCode === "28004",
);
check(
  "formatAddress arma una línea legible",
  formatAddress(currentAddress(sub())) === "Calle de San Andrés 16, 3B, 28004 Madrid, Madrid",
  formatAddress(currentAddress(sub())),
);
check(
  "y no deja comas colgando cuando faltan campos",
  formatAddress({ address1: "Calle Uría 12", postalCode: "33003", city: "Oviedo" }) ===
    "Calle Uría 12, 33003 Oviedo",
  formatAddress({ address1: "Calle Uría 12", postalCode: "33003", city: "Oviedo" }),
);

// ── escritura y verificación del no-op silencioso ─────────────────────────
async function withStubbedSeal<T>(
  readBack: SealSubscription | null,
  fn: () => Promise<T>,
): Promise<{ result?: T; error?: unknown; writes: number }> {
  const origUpdate = seal.updateShippingAddress;
  const origGet = seal.getSubscriptionById;
  let writes = 0;
  (seal as unknown as Record<string, unknown>).updateShippingAddress = async () => {
    writes++;
  };
  (seal as unknown as Record<string, unknown>).getSubscriptionById = async () => readBack;
  try {
    return { result: await fn(), writes };
  } catch (error) {
    return { error, writes };
  } finally {
    (seal as unknown as Record<string, unknown>).updateShippingAddress = origUpdate;
    (seal as unknown as Record<string, unknown>).getSubscriptionById = origGet;
  }
}

const nueva = normalizeAddress(asturias, sub());
const persisted = sub({
  s_address1: "Calle Uría 12",
  s_city: "Oviedo",
  s_zip: "33003",
  s_province: "Asturias",
  s_province_code: "O",
});
// El no-op silencioso: Seal contesta 200 y no cambia nada.
const noop = sub();

const run = async () => {
  {
    const { error, writes } = await withStubbedSeal(persisted, () =>
      writeAddress(sub(), nueva, { verify: true }),
    );
    check("con verify, una escritura que SÍ persiste pasa", !error && writes === 1, String(error ?? "sin error"));
  }
  {
    const { error } = await withStubbedSeal(noop, () => writeAddress(sub(), nueva, { verify: true }));
    check(
      "con verify, el no-op silencioso de Seal se detecta y NO se da por bueno",
      (error as { code?: string })?.code === "seal_address_not_persisted",
      (error as { code?: string })?.code ?? "no lanzó",
    );
  }
  {
    const { error } = await withStubbedSeal(noop, () => writeAddress(sub(), nueva));
    check(
      "sin verify, la relectura sigue siendo tolerante (ruta del cliente)",
      !error,
      String(error ?? "sin error"),
    );
  }
  {
    const { error } = await withStubbedSeal(null, () => writeAddress(sub(), nueva, { verify: true }));
    check(
      "no poder releer no es lo mismo que haber fallado: se reporta éxito",
      !error,
      String(error ?? "sin error"),
    );
  }

  // ── el piso se puede BORRAR ────────────────────────────────────────────
  //
  // El bug del 2026-08-12: un cambio de Madrid a Barcelona dejó puesto el "3B"
  // de Madrid porque `updateShippingAddress` sólo mandaba `s_address2` si era
  // truthy. La caja habría salido a la calle nueva con el piso viejo, y el
  // mensaje de confirmación que leyó el cliente no lo mencionaba.
  {
    const capturado: Array<Record<string, string>> = [];
    const orig = (seal as unknown as Record<string, unknown>).editSubscription;
    (seal as unknown as Record<string, unknown>).editSubscription = async (
      _id: number,
      edit: Record<string, string>,
    ) => {
      capturado.push(edit);
    };
    const base = {
      address1: "C/ de prueba 25",
      city: "Barcelona",
      postalCode: "08001",
      country: "Spain",
      countryCode: "ES",
    };
    try {
      await seal.updateShippingAddress(1, { ...base, address2: "" });
      check(
        'address2 vacío se manda como "" para que Seal lo borre',
        capturado[0]?.s_address2 === "",
        JSON.stringify(capturado[0]?.s_address2),
      );

      await seal.updateShippingAddress(1, { ...base, address2: "1-1" });
      check(
        "un piso de verdad se manda tal cual",
        capturado[1]?.s_address2 === "1-1",
        JSON.stringify(capturado[1]?.s_address2),
      );

      await seal.updateShippingAddress(1, base);
      check(
        "sin la clave, se sigue interpretando como 'no lo toques'",
        !("s_address2" in (capturado[2] ?? {})),
        JSON.stringify(capturado[2]),
      );
    } finally {
      (seal as unknown as Record<string, unknown>).editSubscription = orig;
    }
  }

  console.log(failures === 0 ? "\nTodos OK" : `\n${failures} fallo(s)`);
  process.exit(failures === 0 ? 0 : 1);
};

void run();
