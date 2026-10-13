"use client";

import { CardTitle, Figure, Lp2Card } from "@/components/Lp2";
import { flavorVisual, unknownFlavorName } from "@/lib/flavor-visuals";
import { formatEuro } from "@/lib/format-price";
import { frequencyBetweenLabel, frequencyParts } from "@/lib/frequency-label";
import { T, useLang, useLangValue } from "@/lib/i18n";
import { shortLabel } from "@/lib/mix";
import { FLAVORS, type FlavorKey } from "@/lib/seal-plans";
import type { Frequency } from "@/lib/types";

export type NextBoxHeroVariant = "default" | "skipped" | "locked" | "new";

interface NextBoxHeroProps {
  shipDate: Date | null;
  flavor: string;
  /** Boxes per flavor. One entry = a single flavor; 2+ = a mix. */
  composition?: Array<{ flavor: string; boxes: number }>;
  variant: NextBoxHeroVariant;
  cutoffEndsAt?: Date | null;
  onUndoSkip?: () => void;
  boxCount: number;
  frequency: Frequency;
  /** Lo que se cobra por envío, en céntimos (`Subscription.chargeTotalCents`). */
  chargeTotalCents?: number;
}

/** Sobres por caja: todas las cajas de suscripción son de 30. */
const SACHETS_PER_BOX = 30;

/**
 * Hero del Hub, rediseño lp2 (Juan 2026-10-13, aprobado en el lienzo PRE tras
 * tres rondas: «el hero es feísimo» → «no está mal, la fecha muy grande» → OK).
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ TU PRÓXIMO LIT                        ┌─ panel ─┐ ┌─ panel ─┐    │
 *   │ 20 ENE  MIÉRCOLES                     │  caja   │ │  caja   │    │
 *   │         2027                          │ 2× LEMON│ │ 2× WATER│    │
 *   │ 20 ago ── hoy ● ─ ─ ─ ─ ● 20 ene      └─────────┘ └─────────┘    │
 *   │ 4 · CAJAS | 120 · SOBRES | 5 · MESES | 85,05€ · POR ENVÍO         │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Cada sabor va en un panel con su degradado (la receta de «Tres sabores» de la
 * landing). Con 3 sabores van en fila y con 4 en rejilla de 2×2, para que el
 * hero no cambie de forma. En móvil todo va apilado: título, fecha, paneles,
 * línea de tiempo y cifras.
 *
 * Sin foto ni sello: la foto de fondo y el sello STAY LIT eran el hero anterior.
 */
export function NextBoxHero({
  shipDate,
  flavor,
  composition,
  variant,
  cutoffEndsAt,
  onUndoSkip,
  boxCount,
  frequency,
  chargeTotalCents,
}: NextBoxHeroProps) {
  const t = useLang();
  const lang = useLangValue();
  const dateLocale = lang === "es" ? "es-ES" : "en-US";

  const skipped = variant === "skipped";
  const locked = variant === "locked";

  const day = shipDate ? String(shipDate.getDate()) : "—";
  const month = shipDate ? monthShort(shipDate, dateLocale) : "";
  const weekday = shipDate ? shipDate.toLocaleDateString(dateLocale, { weekday: "long" }) : "";
  const year = shipDate ? String(shipDate.getFullYear()) : "";

  // Una entrada por sabor. Si la suscripción aún no trae `composition` (clientes
  // viejos), se pinta un único panel con la etiqueta de siempre.
  const items =
    composition && composition.length > 0
      ? composition.slice(0, 4).map((c) => ({
          key: c.flavor,
          boxes: c.boxes,
          name: isFlavorKey(c.flavor) ? shortLabel(c.flavor) : unknownFlavorName(c.flavor),
        }))
      : [{ key: "", boxes: boxCount, name: flavor.replace(/^Salty\s+/i, "") }];

  const freq = frequencyParts(frequency);
  const price = chargeTotalCents && chargeTotalCents > 0 ? formatEuro(chargeTotalCents, lang) : null;

  const figures = [
    { value: String(boxCount), label: t({ en: "Boxes per delivery", es: "Cajas por envío" }) },
    { value: String(boxCount * SACHETS_PER_BOX), label: t({ en: "Sachets", es: "Sobres" }) },
    { value: String(freq.n), label: frequencyBetweenLabel(frequency, lang) },
    ...(price
      ? [
          {
            value: price,
            label: t({ en: "Per delivery · free shipping", es: "Por envío · envío gratis" }),
            labelShort: t({ en: "Per delivery", es: "Por envío" }),
          },
        ]
      : []),
  ] as Array<{ value: string; label: string; labelShort?: string }>;

  return (
    <div className="cover-rise mx-6 md:mx-0">
      <Lp2Card as="article" className="md:p-9">
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-12">
          <div className="flex flex-col lg:justify-end">
            <CardTitle as="h1" thin={t({ en: "Your next", es: "Tu próximo" })} bold="LIT" />
            <div className="mt-2.5 flex flex-wrap items-end gap-x-[18px] gap-y-2.5 lg:mt-3.5">
              <p className="m-0 whitespace-nowrap font-display text-[72px] font-semibold uppercase leading-[0.88] tracking-[0.005em] md:text-[88px]">
                {day} {month}
              </p>
              {shipDate && (
                <p className="m-0 font-bold uppercase leading-[1.7] tracking-[0.22em] text-[11px] text-[#5E6168] lg:mb-1">
                  <span className="lg:block">{weekday}</span>
                  <span className="lg:hidden"> · </span>
                  <span className="lg:block">{year}</span>
                </p>
              )}
            </div>
            <div className="hidden lg:block">
              <CycleTimeline shipDate={shipDate} frequency={frequency} dateLocale={dateLocale} lang={lang} />
            </div>
          </div>

          <div className="mt-5 lg:mt-0">
            <FlavorShelf items={items} />
          </div>
        </div>

        <div className="lg:hidden">
          <CycleTimeline shipDate={shipDate} frequency={frequency} dateLocale={dateLocale} lang={lang} />
        </div>

        {/* Cifras: 2×2 en móvil, una fila en escritorio. */}
        <div
          className={`mt-4 grid grid-cols-2 border-t border-[#2F343D]/12 md:mt-8 md:pt-[22px] ${
            figures.length === 4 ? "md:grid-cols-4" : "md:grid-cols-3"
          }`}
        >
          {figures.map((f, i) => (
            <Figure
              key={f.label}
              value={f.value}
              label={
                f.labelShort ? (
                  <>
                    <span className="md:hidden">{f.labelShort}</span>
                    <span className="hidden md:inline">{f.label}</span>
                  </>
                ) : (
                  f.label
                )
              }
              className={figureCellClass(i, figures.length)}
            />
          ))}
        </div>

        {skipped && (
          <div className="mt-5 flex items-center justify-between gap-3 rounded-[14px] border-l-[3px] border-[color:var(--color-bold-yellow)] bg-[color:var(--color-bold-yellow)]/20 px-4 py-3">
            <span className="text-[12.5px] leading-[1.45] text-[#2F343D]">
              <T
                en="You skipped the previous order. This is your next one."
                es="Saltaste el pedido anterior. Este es el próximo."
              />
            </span>
            {onUndoSkip && (
              <button
                type="button"
                onClick={onUndoSkip}
                className="shrink-0 cursor-pointer text-[10.5px] font-bold uppercase tracking-[0.16em] text-[#2F343D] underline underline-offset-4"
              >
                <T en="Undo" es="Deshacer" />
              </button>
            )}
          </div>
        )}

        {locked && cutoffEndsAt && (
          <div className="mt-5 rounded-[14px] bg-[#2F343D]/[0.05] px-4 py-3 text-center text-[12px] leading-[1.45] text-[#5E6168]">
            <strong className="font-bold text-[#2F343D]">
              <T
                en={`Locked in ${formatHM(cutoffEndsAt)}`}
                es={`Bloqueado en ${formatHM(cutoffEndsAt)}`}
              />
            </strong>
            <span>
              <T en=" · Changes apply to the box after." es=" · Los cambios aplican a la siguiente." />
            </span>
          </div>
        )}
      </Lp2Card>
    </div>
  );
}

/* ─── Paneles de sabor ─────────────────────────────────────────────────────── */

interface ShelfItem {
  key: string;
  boxes: number;
  name: string;
}

/**
 * Los paneles, en dos versiones: la de móvil (`lg:hidden`) y la de escritorio,
 * que ocupa una columna fija de 514 px a la derecha del hero. Cada una reparte
 * los sabores según cuántos haya (1, 2, 3 o 4).
 */
function FlavorShelf({ items }: { items: ShelfItem[] }) {
  const n = items.length;
  return (
    <>
      <div
        className={`grid lg:hidden ${
          n === 1 ? "grid-cols-1" : n === 3 ? "grid-cols-3 gap-2" : "grid-cols-2 gap-2.5"
        }`}
      >
        {items.map((it) =>
          n === 3 ? (
            <Panel key={it.key || it.name} item={it} height={150} box={84} top={12} radius={14} caption="stacked" />
          ) : n >= 4 ? (
            <Panel key={it.key || it.name} item={it} height={150} box={96} top={12} radius={16} caption="corner" small />
          ) : (
            <Panel key={it.key || it.name} item={it} height={188} box={n === 1 ? 140 : 118} top={n === 1 ? 18 : 22} radius={16} caption="corner" small />
          ),
        )}
      </div>
      <div
        className={`hidden w-[514px] gap-3.5 lg:grid ${
          n === 1 ? "grid-cols-1" : n === 3 ? "grid-cols-3" : "grid-cols-2"
        }`}
      >
        {items.map((it) =>
          n >= 4 ? (
            <Panel key={it.key || it.name} item={it} height={143} box={120} top={14} radius={20} caption="side" />
          ) : (
            <Panel
              key={it.key || it.name}
              item={it}
              height={300}
              box={n === 1 ? 230 : n === 2 ? 196 : 140}
              top={n === 1 ? 34 : n === 2 ? 38 : 62}
              radius={22}
              caption="corner"
            />
          ),
        )}
      </div>
    </>
  );
}

/** Proporción alto/ancho de los recortes de caja (480×438). */
const BOX_RATIO = 438 / 480;

function Panel({
  item,
  height,
  box,
  top,
  radius,
  caption,
  small = false,
}: {
  item: ShelfItem;
  height: number;
  box: number;
  top: number;
  radius: number;
  /** corner = cifra y nombre abajo a la izquierda; stacked = centrado y solo el
   *  nombre corto (3 sabores en móvil); side = caja a la izquierda y texto a la
   *  derecha (4 sabores en escritorio). */
  caption: "corner" | "stacked" | "side";
  small?: boolean;
}) {
  const visual = flavorVisual(item.key);
  const boxH = Math.round(box * BOX_RATIO);
  const side = caption === "side";
  const shadowW = Math.round(box * 0.86);
  const label = `${item.boxes}× Salty ${item.name}`;
  return (
    <figure
      className="lp2-grain relative m-0 overflow-hidden"
      style={{ height, borderRadius: radius, background: visual.panel }}
      aria-label={label}
    >
      <span
        aria-hidden
        className="absolute rounded-[50%]"
        style={{
          left: side ? 22 : "50%",
          marginLeft: side ? 0 : -shadowW / 2,
          top: top + boxH - (small ? 6 : 8),
          width: shadowW,
          height: small ? 14 : 20,
          background: "radial-gradient(closest-side, rgba(26,28,34,0.3), rgba(26,28,34,0))",
        }}
      />
      {visual.box && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={visual.box}
          alt=""
          width={box}
          height={boxH}
          className="absolute h-auto max-w-none"
          style={{
            width: box,
            top,
            left: side ? 18 : "50%",
            marginLeft: side ? 0 : -box / 2,
            filter: `drop-shadow(0 ${small ? 12 : 18}px ${small ? 14 : 20}px rgba(26,28,34,0.22))`,
          }}
        />
      )}
      {caption === "stacked" ? (
        <figcaption aria-hidden className="absolute inset-x-1 bottom-2.5 text-center text-[#2F343D]">
          <span className="block font-display text-[18px] font-semibold leading-none">{item.boxes}×</span>
          <span className="mt-1 block text-[8.5px] font-bold uppercase tracking-[0.12em]">{item.name}</span>
        </figcaption>
      ) : side ? (
        <figcaption aria-hidden className="absolute top-1/2 right-3 left-[152px] -translate-y-1/2 text-[#2F343D]">
          <span className="block font-display text-[28px] font-semibold leading-none">{item.boxes}×</span>
          <span className="mt-1.5 block text-[9.5px] font-bold uppercase leading-[1.3] tracking-[0.14em]">
            Salty
            <br />
            {item.name}
          </span>
        </figcaption>
      ) : (
        <figcaption
          aria-hidden
          className={`absolute flex items-center text-[#2F343D] ${small ? "inset-x-3 bottom-3 gap-[7px]" : "inset-x-[18px] bottom-4 gap-2.5"}`}
        >
          <span className={`font-display font-semibold leading-none ${small ? "text-[20px]" : "text-[28px]"}`}>
            {item.boxes}×
          </span>
          <span
            className={`font-bold uppercase leading-[1.25] tracking-[0.14em] ${small ? "text-[9px]" : "text-[10px]"}`}
          >
            Salty
            <br />
            {item.name}
          </span>
        </figcaption>
      )}
    </figure>
  );
}

/* ─── Línea de tiempo del ciclo ───────────────────────────────────────────── */

/**
 * «20 ago ── hoy ● ─ ─ ─ ● 20 ene» con «Faltan 99 días» debajo, como el gráfico
 * de puntos de la landing. El inicio es la fecha del envío MENOS un ciclo, no el
 * último pedido real: con un salto o un adelanto el pedido anterior no cae ahí,
 * así que la etiqueta es solo una fecha (no dice «último envío»).
 */
function CycleTimeline({
  shipDate,
  frequency,
  dateLocale,
  lang,
}: {
  shipDate: Date | null;
  frequency: Frequency;
  dateLocale: string;
  lang: "en" | "es";
}) {
  if (!shipDate) return null;
  const start = cycleStart(shipDate, frequency);
  // Instantánea de presentación: si el cliente deja la pestaña abierta un día,
  // el punto «hoy» se queda donde estaba hasta el siguiente render.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const span = shipDate.getTime() - start.getTime();
  const raw = span > 0 ? (now - start.getTime()) / span : 1;
  const p = Math.min(0.96, Math.max(0.04, raw));
  const pct = `${(p * 100).toFixed(2)}%`;
  const remainMid = `${(((p + 1) / 2) * 100).toFixed(2)}%`;
  const showTodayLabel = p > 0.16 && p < 0.84;
  const left = remaining(shipDate, now, lang);
  const startLabel = `${start.getDate()} ${monthShort(start, dateLocale)}`;
  const endLabel = `${shipDate.getDate()} ${monthShort(shipDate, dateLocale)}`;

  return (
    <figure className="m-0 mt-6 lg:mt-[34px]" aria-label={left.aria}>
      <div aria-hidden className="relative h-[62px] text-[12px] font-bold text-[#2F343D] md:h-16 md:text-[13px]">
        <span className="absolute top-0 left-0 text-[#8C8E87]">{startLabel}</span>
        {showTodayLabel && (
          <span className="absolute top-0 -translate-x-1/2" style={{ left: pct }}>
            {lang === "es" ? "Hoy" : "Today"}
          </span>
        )}
        <span className="absolute top-0 right-0">{endLabel}</span>
        <span className="absolute inset-x-0 top-[30px] h-px bg-[#2F343D]/14 md:top-[31px]" />
        <span
          className="absolute top-[29px] left-0 h-[3px] rounded-[2px] bg-[#2F343D]/30 md:top-[30px]"
          style={{ width: pct }}
        />
        <span
          className="absolute top-[29px] right-0 h-[3px] rounded-[2px] md:top-[30px]"
          style={{
            left: pct,
            background: "repeating-linear-gradient(90deg, #2F343D 0 7px, rgba(47,52,61,0) 7px 13px)",
          }}
        />
        <span className="absolute top-[25px] left-0 h-[11px] w-[11px] rounded-full bg-[color:var(--color-sharp-white)] shadow-[inset_0_0_0_2px_#8C8E87] md:top-[26px]" />
        <span
          className="absolute top-[24px] -ml-[6.5px] h-[13px] w-[13px] rounded-full bg-[#2F343D] shadow-[0_0_0_3px_var(--color-sharp-white)] md:top-[25px]"
          style={{ left: pct }}
        />
        <span className="absolute top-[21px] right-0 h-[19px] w-[19px] rounded-full bg-[color:var(--color-bold-yellow)] shadow-[inset_0_0_0_2px_#2F343D,0_0_0_3px_var(--color-sharp-white)] md:top-[22px]" />
        <span
          className="absolute top-[45px] -translate-x-1/2 whitespace-nowrap text-[10px] tracking-[0.2em] uppercase md:top-[46px]"
          style={{ left: remainMid }}
        >
          {left.label}
        </span>
      </div>
    </figure>
  );
}

/* ─── Utilidades ───────────────────────────────────────────────────────────── */

function isFlavorKey(v: string): v is FlavorKey {
  return Object.prototype.hasOwnProperty.call(FLAVORS, v);
}

function monthShort(d: Date, locale: string): string {
  return d.toLocaleDateString(locale, { month: "short" }).replace(".", "");
}

function cycleStart(ship: Date, f: Frequency): Date {
  const { n, unit } = frequencyParts(f);
  const d = new Date(ship.getTime());
  if (unit === "days") d.setDate(d.getDate() - n);
  else d.setMonth(d.getMonth() - n);
  return d;
}

function remaining(ship: Date, now: number, lang: "en" | "es"): { label: string; aria: string } {
  const ms = ship.getTime() - now;
  const days = Math.ceil(ms / 86_400_000);
  const hours = Math.max(0, Math.ceil(ms / 3_600_000));
  if (ms <= 0) {
    const l = lang === "es" ? "Sale hoy" : "Ships today";
    return { label: l, aria: l };
  }
  if (hours < 48) {
    return lang === "es"
      ? { label: `Sale en ${hours} h`, aria: `Tu próximo envío sale en ${hours} horas` }
      : { label: `Ships in ${hours} h`, aria: `Your next delivery ships in ${hours} hours` };
  }
  return lang === "es"
    ? { label: `Faltan ${days} días`, aria: `Faltan ${days} días para tu próximo envío` }
    : { label: `${days} days to go`, aria: `${days} days until your next delivery` };
}

/** Bordes de la rejilla de cifras: 2×2 en móvil, fila en escritorio. */
function figureCellClass(i: number, total: number): string {
  const mobile = [
    "py-4 pr-3 border-b border-[#2F343D]/12",
    "py-4 pl-4 border-b border-l border-[#2F343D]/12",
    "pt-4 pr-3",
    "pt-4 pl-4 border-l border-[#2F343D]/12",
  ][i] ?? "pt-4";
  const desktop =
    i === 0
      ? "md:py-0 md:pl-0 md:pr-5 md:border-b-0"
      : `md:py-0 md:px-5 md:border-b-0 md:border-l md:border-[#2F343D]/12 ${i === total - 1 ? "md:pr-0" : ""}`;
  return `${mobile} ${desktop}`;
}

function formatHM(date: Date): string {
  const ms = Math.max(0, date.getTime() - Date.now());
  const totalMin = Math.floor(ms / (1000 * 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

