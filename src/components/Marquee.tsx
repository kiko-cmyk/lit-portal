"use client";

/**
 * Slow horizontal marquee of brand claims. The track is one logical block
 * of [word · word · word · ...] duplicated twice so a translateX(-50%) lands
 * exactly on the start of the duplicate — seam-perfect loop.
 *
 * Round 7 (Juan 2026-05-19): the previous implementation used a parent flex
 * `gap` PLUS inner dots with their own margins, which produced one
 * noticeably wider gap at the join. Now every gap (word→dot, dot→word,
 * sequence→sequence) is the same `--marquee-gap`, controlled by a single
 * flex container.
 */
const CLAIMS = ["LIT", "PERFORM", "REPEAT"] as const;

// Build one base sequence (word · word · word ·), then repeat the whole
// sequence ×4 inside the track. translateX(-50%) jumps two copies forward
// → the seam is invisible AND the track is wide enough that the viewport
// always has content on the right edge even on desktop.
const SEQUENCE = CLAIMS;
const COPIES = 4;

export function Marquee() {
  // Each "atom" is a word OR a dot — keeps the gap uniform end-to-end.
  const items: { kind: "word" | "dot"; value: string }[] = [];
  for (let copy = 0; copy < COPIES; copy++) {
    for (const word of SEQUENCE) {
      items.push({ kind: "word", value: word });
      items.push({ kind: "dot", value: "·" });
    }
  }

  return (
    <div className="relative my-12 overflow-hidden border-y border-[color:var(--color-lit-grey)]/15 py-5">
      <div
        className="flex w-max shrink-0 items-center whitespace-nowrap"
        style={{
          gap: "36px",
          animation: "marquee 32s linear infinite",
          willChange: "transform",
        }}
      >
        {items.map((it, i) =>
          it.kind === "word" ? (
            <span
              key={i}
              className="text-[color:var(--color-lit-grey)]"
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 600,
                fontSize: "clamp(1.4rem, 5vw, 2rem)",
                letterSpacing: "-0.015em",
                textTransform: "uppercase",
              }}
            >
              {it.value}
            </span>
          ) : (
            <span
              key={i}
              aria-hidden
              className="text-[color:var(--color-lit-grey)]/60"
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "clamp(1.4rem, 5vw, 2rem)",
              }}
            >
              {it.value}
            </span>
          ),
        )}
      </div>
    </div>
  );
}
