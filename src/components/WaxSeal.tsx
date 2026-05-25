"use client";

/**
 * Wax-seal style brand badge — a yellow disc with rotating text around the
 * rim and a static centre label. Inspired by the v2 INNER CIRCLE proposal
 * but adapted as a generic brand element so it can be reused on the Hub
 * hero (decorative weight, not a real tier).
 *
 * The outer rim text rotates 360° over 28 s (CSS keyframe `seal-spin` in
 * globals.css). The centre label stays still.
 *
 * Defaults are tuned for the Hub hero — pass `centerTop` + `centerBottom`
 * + `rim` to override for other contexts.
 */
export function WaxSeal({
  rim = "LIT · PERFORM · REPEAT · LIT · PERFORM · REPEAT · LIT · PERFORM · REPEAT · ",
  centerTop = "STAY",
  centerBottom = "LIT.",
  size = 180,
  className,
}: {
  rim?: string;
  centerTop?: string;
  centerBottom?: string;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      aria-hidden
      className={className}
      style={{
        filter: "drop-shadow(0 14px 26px rgba(50, 40, 30, 0.28))",
      }}
    >
      <defs>
        {/* A full circle path the text rides on. Slightly inset from the
            outer rim so the type doesn't kiss the edge. */}
        <path
          id="wax-seal-arc"
          d="M 100,100 m -78,0 a 78,78 0 1,1 156,0 a 78,78 0 1,1 -156,0"
          fill="none"
        />
      </defs>

      {/* Disc */}
      <circle
        cx="100"
        cy="100"
        r="92"
        fill="#EBEE62"
        stroke="rgba(50, 55, 67, 0.12)"
        strokeWidth="1"
      />

      {/* Subtle inner ring — adds the printed-stamp feel. */}
      <circle
        cx="100"
        cy="100"
        r="62"
        fill="none"
        stroke="rgba(50, 55, 67, 0.18)"
        strokeWidth="0.75"
      />

      {/* Rotating rim text */}
      <g
        style={{
          transformOrigin: "100px 100px",
          animation: "seal-spin 28s linear infinite",
        }}
      >
        <text
          fill="#323743"
          style={{
            fontFamily: "var(--font-cond)",
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
          }}
        >
          <textPath href="#wax-seal-arc" startOffset="0%">
            {rim}
          </textPath>
        </text>
      </g>

      {/* Centre label — stacked, static. */}
      <text
        x="100"
        y="93"
        textAnchor="middle"
        fill="#323743"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 24,
          fontWeight: 700,
          letterSpacing: "-0.025em",
        }}
      >
        {centerTop}
      </text>
      <text
        x="100"
        y="120"
        textAnchor="middle"
        fill="#323743"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 24,
          fontWeight: 700,
          letterSpacing: "-0.025em",
        }}
      >
        {centerBottom}
      </text>

      {/* Tiny dash under the centre — printed stamp detail. */}
      <line
        x1="78"
        y1="135"
        x2="122"
        y2="135"
        stroke="#323743"
        strokeOpacity="0.35"
        strokeWidth="1"
      />
    </svg>
  );
}
