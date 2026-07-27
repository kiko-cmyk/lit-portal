/**
 * Spanish province derived from the postal code.
 *
 * Why (incident 2026-07-27): `AddressOverlay` only collects name, address, apt,
 * postal code and city — there is no province or country field. So `province` /
 * `provinceCode` ride along UNCHANGED from whatever the previous address had.
 * A subscriber moving her deliveries to a summer house in another province
 * (Madrid → Asturias) would have shipped with `province: "Madrid", code: "M"`
 * against an Asturian postal code: a shipping label that contradicts itself.
 *
 * In Spain the province IS the first two digits of the postal code (01–52), so
 * there is nothing to ask the customer — we derive it and overwrite whatever the
 * client sent. Codes are the ISO 3166-2:ES subdivision letters Shopify expects
 * as `provinceCode` (verified against live data: 28xxx → "M" Madrid,
 * 33xxx → "O" Asturias).
 *
 * The `name` is what we hand to Seal, which stores `s_province` free-form.
 * Shopify gets only the `provinceCode` and canonicalises the display name
 * itself, so we never have to match its localised province list exactly.
 */

export interface EsProvince {
  code: string;
  name: string;
}

const BY_POSTAL_PREFIX: Record<string, EsProvince> = {
  "01": { code: "VI", name: "Álava" },
  "02": { code: "AB", name: "Albacete" },
  "03": { code: "A", name: "Alicante" },
  "04": { code: "AL", name: "Almería" },
  "05": { code: "AV", name: "Ávila" },
  "06": { code: "BA", name: "Badajoz" },
  "07": { code: "PM", name: "Baleares" },
  "08": { code: "B", name: "Barcelona" },
  "09": { code: "BU", name: "Burgos" },
  "10": { code: "CC", name: "Cáceres" },
  "11": { code: "CA", name: "Cádiz" },
  "12": { code: "CS", name: "Castellón" },
  "13": { code: "CR", name: "Ciudad Real" },
  "14": { code: "CO", name: "Córdoba" },
  "15": { code: "C", name: "A Coruña" },
  "16": { code: "CU", name: "Cuenca" },
  "17": { code: "GI", name: "Girona" },
  "18": { code: "GR", name: "Granada" },
  "19": { code: "GU", name: "Guadalajara" },
  "20": { code: "SS", name: "Gipuzkoa" },
  "21": { code: "H", name: "Huelva" },
  "22": { code: "HU", name: "Huesca" },
  "23": { code: "J", name: "Jaén" },
  "24": { code: "LE", name: "León" },
  "25": { code: "L", name: "Lleida" },
  "26": { code: "LO", name: "La Rioja" },
  "27": { code: "LU", name: "Lugo" },
  "28": { code: "M", name: "Madrid" },
  "29": { code: "MA", name: "Málaga" },
  "30": { code: "MU", name: "Murcia" },
  "31": { code: "NA", name: "Navarra" },
  "32": { code: "OR", name: "Ourense" },
  "33": { code: "O", name: "Asturias" },
  "34": { code: "P", name: "Palencia" },
  "35": { code: "GC", name: "Las Palmas" },
  "36": { code: "PO", name: "Pontevedra" },
  "37": { code: "SA", name: "Salamanca" },
  "38": { code: "TF", name: "Santa Cruz de Tenerife" },
  "39": { code: "S", name: "Cantabria" },
  "40": { code: "SG", name: "Segovia" },
  "41": { code: "SE", name: "Sevilla" },
  "42": { code: "SO", name: "Soria" },
  "43": { code: "T", name: "Tarragona" },
  "44": { code: "TE", name: "Teruel" },
  "45": { code: "TO", name: "Toledo" },
  "46": { code: "V", name: "Valencia" },
  "47": { code: "VA", name: "Valladolid" },
  "48": { code: "BI", name: "Bizkaia" },
  "49": { code: "ZA", name: "Zamora" },
  "50": { code: "Z", name: "Zaragoza" },
  "51": { code: "CE", name: "Ceuta" },
  "52": { code: "ML", name: "Melilla" },
};

/**
 * Province for a Spanish postal code, or null when the code isn't a valid ES
 * one (00xxx, 53xxx+, letters, wrong length). Callers keep whatever province
 * they already had on null — deriving is an improvement, never a regression.
 */
export function provinceFromEsPostalCode(postalCode: string): EsProvince | null {
  const digits = postalCode.replace(/\D/g, "");
  if (digits.length !== 5) return null;
  return BY_POSTAL_PREFIX[digits.slice(0, 2)] ?? null;
}

/** All 52 provinces, for tests and admin tooling. */
export function allEsProvinces(): EsProvince[] {
  return Object.values(BY_POSTAL_PREFIX);
}
