"use client";

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
  disabled,
}: {
  /** Total boxes to distribute. Fixed by the plan. */
  boxCount: number;
  value: FlavorComposition[];
  onChange: (next: FlavorComposition[]) => void;
  disabled?: boolean;
}) {
  const t = useLang();
  const boxesOf = (f: FlavorKey) => value.find((c) => c.flavor === f)?.boxes ?? 0;
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
    const n = ALL_FLAVORS.length;
    const base = Math.floor(boxCount / n);
    const map = Object.fromEntries(ALL_FLAVORS.map((f) => [f.key, base])) as Record<string, number>;
    let rest = boxCount - base * n;
    for (const f of ALL_FLAVORS) {
      if (rest <= 0) break;
      map[f.key] += 1;
      rest -= 1;
    }
    commit(map);
  };

  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between">
        <div
          className="font-semibold uppercase tracking-[0.18em] opacity-60"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
          aria-live="polite"
        >
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
        {boxCount >= ALL_FLAVORS.length && (
          <button
            type="button"
            onClick={splitEvenly}
            disabled={disabled}
            className="text-[10px] uppercase tracking-[0.18em] underline opacity-50 disabled:opacity-30"
          >
            <T en="Split evenly" es="Repartir igual" />
          </button>
        )}
      </div>

      <div className="mt-3 space-y-2.5">
        {ALL_FLAVORS.map((f) => {
          const n = boxesOf(f.key);
          const active = n > 0;
          return (
            <div
              key={f.key}
              className={`flex items-center justify-between rounded-2xl border px-5 py-3.5 transition ${
                active
                  ? "border-[color:var(--color-lit-grey)]/30 bg-[color:var(--color-sharp-white)]"
                  : "border-[color:var(--color-lit-grey)]/12 bg-[color:var(--color-sharp-white)]/50"
              }`}
            >
              <span
                className={`font-display text-lg font-black uppercase leading-tight ${
                  active ? "" : "opacity-40"
                }`}
              >
                {shortLabel(f.key)}
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => dec(f.key)}
                  disabled={disabled || n === 0}
                  aria-label={t({ en: `One less ${shortLabel(f.key)}`, es: `Una menos de ${shortLabel(f.key)}` })}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-[color:var(--color-lit-grey)]/25 text-lg leading-none disabled:opacity-25"
                >
                  −
                </button>
                <span
                  className="w-6 text-center font-display text-xl font-black"
                  aria-live="polite"
                >
                  {n}
                </span>
                <button
                  type="button"
                  onClick={() => inc(f.key)}
                  disabled={disabled}
                  aria-label={t({ en: `One more ${shortLabel(f.key)}`, es: `Una más de ${shortLabel(f.key)}` })}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-[color:var(--color-lit-grey)]/25 text-lg leading-none disabled:opacity-25"
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
