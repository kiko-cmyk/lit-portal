"use client";

/**
 * Slow horizontal marquee of brand claims. The track is duplicated so when
 * the first half scrolls off, the second half is already in place. Animated
 * via the `marquee` keyframe in globals.css.
 *
 * Per Juan 2026-05-18 round 4: include "GET LIT · SUPERIOR HYDRATION" at
 * minimum, decorate with a few extra brand voice lines.
 */
const CLAIMS = [
  "GET LIT",
  "SUPERIOR HYDRATION",
  "STAY LIT",
  "CHOOSE YOUR ADDICTIONS WISELY",
  "ZERO COMPROMISE",
];

export function Marquee() {
  // Half × 2 → seamless loop. The wider the track, the slower it perceives.
  const text = CLAIMS.join("  ·  ");
  return (
    <div className="relative my-12 overflow-hidden border-y border-[color:var(--color-lit-grey)]/15 py-5">
      <div
        className="flex shrink-0 whitespace-nowrap"
        style={{
          gap: "40px",
          animation: "marquee 32s linear infinite",
          willChange: "transform",
        }}
      >
        {[0, 1].map((i) => (
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
            {text}
            <span style={{ margin: "0 28px" }}>·</span>
            {text}
            <span style={{ margin: "0 28px" }}>·</span>
          </span>
        ))}
      </div>
    </div>
  );
}
