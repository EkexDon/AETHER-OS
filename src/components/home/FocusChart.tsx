import { useLayoutEffect, useRef, useState } from "react";
import type { FocusDay } from "../../types";
import { formatMinutes } from "../../lib/home/focusStats";
import { weekdayShort } from "../../lib/home/format";

export interface FocusChartProps {
  days: FocusDay[];
  /** `YYYY-MM-DD` of today (highlighted). */
  today: string;
}

/** Width used before the first measurement (and in environments without layout). */
const FALLBACK_WIDTH = 280;
const HEIGHT = 104;
const LABEL_H = 16;
const TOP_PAD = 14;
const MAX_BAR_W = 28;

/**
 * Minutes of focus per day as a small inline SVG bar chart with a fixed
 * height; bars spread over the measured width so text never scales. Bars
 * scale to the busiest day (min. one hour so a light week does not look
 * full); today is drawn in the accent color, other days in a neutral fill.
 */
export function FocusChart({ days, today }: FocusChartProps) {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const max = Math.max(60, ...days.map((d) => d.minutes));
  const slot = width / Math.max(1, days.length);
  const barW = Math.min(MAX_BAR_W, slot * 0.56);
  const plotH = HEIGHT - LABEL_H - TOP_PAD;
  const summary = days.map((d) => `${weekdayShort(d.date)} ${formatMinutes(d.minutes)}`).join(", ");

  return (
    <figure className="home-focus-chart" ref={ref}>
      <svg
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label={`Focus minutes, last ${days.length} days: ${summary}`}
      >
        <line className="home-focus-chart-base" x1={0} x2={width} y1={TOP_PAD + plotH + 0.5} y2={TOP_PAD + plotH + 0.5} />
        {days.map((d, i) => {
          const h = d.minutes > 0 ? Math.max(3, (d.minutes / max) * plotH) : 2;
          const x = i * slot + (slot - barW) / 2;
          const y = TOP_PAD + plotH - h;
          const isToday = d.date === today;
          return (
            <g key={d.date} className={isToday ? "is-today" : undefined}>
              <title>{`${weekdayShort(d.date)} ${d.date}: ${formatMinutes(d.minutes)} (${d.sessions} session${d.sessions === 1 ? "" : "s"})`}</title>
              <rect className={d.minutes > 0 ? "home-focus-bar" : "home-focus-bar is-empty"} x={x} y={y} width={barW} height={h} rx={3} />
              {d.minutes > 0 && (
                <text className="home-focus-bar-value" x={x + barW / 2} y={y - 4} textAnchor="middle">
                  {d.minutes}
                </text>
              )}
              <text className="home-focus-bar-label" x={i * slot + slot / 2} y={HEIGHT - 3} textAnchor="middle">
                {weekdayShort(d.date)}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
