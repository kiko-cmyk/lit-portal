"use client";

import { flavorVisual } from "@/lib/flavor-visuals";
import { T, useLang } from "@/lib/i18n";
import {
  type FlavorComposition,
  mixBoxCount,
  shortLabel,
} from "@/lib/mix";
import { ALL_FLAVORS, type FlavorKey } from "@/lib/seal-plans";

/**
 * Mix builder — split a fixed number of boxes across flavors.
 *
 * Pure and fetch-free so it can live inside FlavorOverlay and PlanOverlay without
 * either owning the other's state. The total is FIXED by the plan: the customer is
 * distributing boxes, not adding them, which is why "+" reallocates from the largest
 * other flavor once the budget is full instead of dead-ending.
 */
export function MixBuilder({
  boxCount,
  value,
  onChange,
  flavors,
  disabled,
}: {
  /** Total boxes to distribute. Fixed by the plan. */
  boxCount: number;
  value: FlavorComposition[];
  onChange: (next: FlavorComposition[]) => void;
  /** Los sabores que se ofrecen (`flavorChoices`); sin él, todos los del registro. */
  flavors?: readonly FlavorKey[];
  disabled?: boolean;
}) {
  const t = useLang();
  const boxesOf = (f: FlavorKey) => value.find((c) => c.flavor === f)?.boxes ?? 0;
  // Las filas: lo que se ofrece más lo que ya está en la mezcla, que nunca desaparece
  // del constructor (Raw no sale como fila nueva antes de su lanzamiento, 29-oct-2026).
  const rows = ALL_FLAVORS.filter((f) => !flavors || flavors.includes(f.key) || boxesOf(f.key) > 0);
  const assigned = mixBoxCount(value);
  const left = boxCount - assigned;

  /** Rebuild the composition from a flavor→boxes map, dropping zeros so the shape
   *  matches what the API validates (a zero entry means "not in the mix"). */
  const commit = (next: Record<string, number>) => {
    onChange(
      ALL_FLAVORS.filter((f) => (next[f.key] ?? 0) > 0).map((f) => ({
        flavor: f.key,
        boxes: next[f.key],
      })),
    );
  };

  const asMap = () =>
    Object.fromEntries(ALL_FLAVORS.map((f) => [f.key, boxesOf(f.key)])) as Record<string, number>;

  const inc = (flavor: FlavorKey) => {
    const map = asMap();
    if (left > 0) {
      map[flavor] += 1;
    } else {
      // Budget full: take one from the largest OTHER flavor so the control keeps
      // responding instead of looking broken.
      const donor = ALL_FLAVORS.filter((f) => f.key !== flavor && map[f.key] > 0).sort(
        (a, b) => map[b.key] - map[a.key],
      )[0];
      if (!donor) return;
      map[donor.key] -= 1;
      map[flavor] += 1;
    }
    commit(map);
  };

  const dec = (flavor: FlavorKey) => {
    const map = asMap();
    if (map[flavor] <= 0) return;
    map[flavor] -= 1;
    commit(map);
  };

  const splitEvenly = () => {
    const n = rows.length;
    const base = Math.floor(boxCount / n);
    const map = Object.fromEntries(rows.map((f) => [f.key, base])) as Record<string, number>;
    let rest = boxCount - base * n;
    for (const f of rows) {
      if (rest <= 0) break;
      map[f.key] += 1;
      rest -= 1;
    }
    commit(map);
  };

  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#8C8E87]" aria-live="polite">
          {left === 0 ? (
            <T
              en={`${assigned} of ${boxCount} boxes assigned`}
              es={`${assigned} de ${boxCount} cajas asignadas`}
            />
          ) : left > 0 ? (
            <T
              en={`${left} box${left > 1 ? "es" : ""} left to assign`}
              es={`${left} caja${left > 1 ? "s" : ""} por asignar`}
            />
          ) : (
            <T
              en={`${-left} box${-left > 1 ? "es" : ""} too many`}
              es={`${-left} caja${-left > 1 ? "s" : ""} de más`}
            />
          )}
        </div>
        {boxCount >= rows.length && (
          <button
            type="button"
            onClick={splitEvenly}
            disabled={disabled}
            className="cursor-pointer text-[10px] font-bold uppercase tracking-[0.16em] text-[#5E6168] underline underline-offset-4 disabled:opacity-30"
          >
            <T en="Split evenly" es="Repartir igual" />
          </button>
        )}
      </div>

      <div className="mt-3 space-y-2.5">
        {rows.map((f) => {
          const n = boxesOf(f.key);
          const active = n > 0;
          return (
            <div
              key={f.key}
              className={`flex items-center justify-between gap-3 rounded-[16px] border px-3.5 py-2.5 transition ${
                active
                  ? "border-[#2F343D] bg-white shadow-[0_10px_22px_-16px_rgba(40,34,20,0.45)]"
                  : "border-[#2F343D]/12 bg-white/60"
              }`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <FlavorThumb flavor={f.key} dim={!active} />
                {/* 14px por debajo de 380px de ancho: a 17 «WATERMELON» se
                    montaba sobre el botón de restar en un móvil de 360. */}
                <span
                  className={`font-display text-[14px] font-semibold uppercase leading-tight min-[380px]:text-[17px] ${
                    active ? "text-[#2F343D]" : "text-[#8C8E87]"
                  }`}
                >
                  {shortLabel(f.key)}
                </span>
              </span>
              <div className="flex items-center gap-2 min-[380px]:gap-3">
                <button
                  type="button"
                  onClick={() => dec(f.key)}
                  disabled={disabled || n === 0}
                  aria-label={t({ en: `One less ${shortLabel(f.key)}`, es: `Una menos de ${shortLabel(f.key)}` })}
                  className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-[#2F343D]/20 bg-white text-[18px] leading-none text-[#2F343D] transition-colors hover:border-[#2F343D]/50 disabled:cursor-not-allowed disabled:opacity-25"
                >
                  −
                </button>
                <span
                  className="w-6 text-center font-display text-[22px] font-semibold"
                  aria-live="polite"
                >
                  {n}
                </span>
                <button
                  type="button"
                  onClick={() => inc(f.key)}
                  disabled={disabled}
                  aria-label={t({ en: `One more ${shortLabel(f.key)}`, es: `Una más de ${shortLabel(f.key)}` })}
                  className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-[#2F343D]/20 bg-white text-[18px] leading-none text-[#2F343D] transition-colors hover:border-[#2F343D]/50 disabled:cursor-not-allowed disabled:opacity-25"
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** True when this composition can be saved: the boxes add up and at least two
 *  flavors are in play (a single flavor is the plain flavor change, not a mix). */
export function isMixSavable(value: FlavorComposition[], boxCount: number): boolean {
  return mixBoxCount(value) === boxCount && value.filter((c) => c.boxes > 0).length >= 2;
}

/**
 * La caja del sabor en miniatura sobre su círculo de color, como en «Tu plan»
 * (rediseño lp2). La usan el mezclador y la lista de sabores del popup.
 */
export function FlavorThumb({ flavor, dim = false }: { flavor: string; dim?: boolean }) {
  const v = flavorVisual(flavor);
  return (
    <span aria-hidden className={`relative h-[46px] w-[52px] flex-none transition-opacity ${dim ? "opacity-50" : ""}`}>
      <span className="absolute bottom-0 left-1 h-10 w-10 rounded-full" style={{ background: v.disc }} />
      {v.box && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={v.box}
          alt=""
          className="absolute bottom-0.5 left-0 h-auto w-[50px] max-w-none"
          style={{ filter: "drop-shadow(0 6px 6px rgba(26,28,34,0.2))" }}
        />
      )}
    </span>
  );
}
