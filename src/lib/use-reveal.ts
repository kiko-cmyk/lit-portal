"use client";

import { useEffect, useRef } from "react";

/**
 * Scroll-triggered reveal hook. Watches a single element and adds the
 * `is-in` class the first time it intersects the viewport. Pairs with the
 * `.reveal` CSS class in `globals.css` to fade and translate the section
 * into view.
 *
 * Used by Hub + Account to stagger the entrance of ImpactStats /
 * SciencePanel / DeliveryCalendar without re-implementing the observer in
 * every component.
 */
export function useReveal<T extends HTMLElement>(opts?: {
  rootMargin?: string;
  threshold?: number;
  once?: boolean;
}) {
  const ref = useRef<T>(null);
  const fired = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (
      typeof window === "undefined" ||
      typeof IntersectionObserver === "undefined"
    ) {
      // SSR or very old browser — just show.
      el.classList.add("is-in");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.classList.add("is-in");
            if (opts?.once !== false) {
              io.disconnect();
              fired.current = true;
              break;
            }
          } else if (opts?.once === false) {
            el.classList.remove("is-in");
          }
        }
      },
      {
        rootMargin: opts?.rootMargin ?? "0px 0px -10% 0px",
        threshold: opts?.threshold ?? 0.2,
      },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [opts?.rootMargin, opts?.threshold, opts?.once]);

  return ref;
}

/**
 * Animated count-up that starts when the element scrolls into view.
 * Eases out cubic over `durationMs`. SSR-safe: renders the final value
 * during server render, only animates client-side.
 */
export function useCounterUp(target: number, durationMs = 1400) {
  const ref = useRef<HTMLSpanElement>(null);
  const animated = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || animated.current) return;
    if (
      typeof window === "undefined" ||
      typeof IntersectionObserver === "undefined"
    ) {
      el.textContent = target.toLocaleString();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.find((e) => e.isIntersecting);
        if (!hit) return;
        animated.current = true;
        const start = performance.now();
        const step = (now: number) => {
          const p = Math.min(1, (now - start) / durationMs);
          const eased = 1 - Math.pow(1 - p, 3);
          el.textContent = Math.floor(target * eased).toLocaleString();
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        io.disconnect();
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [target, durationMs]);

  return ref;
}
