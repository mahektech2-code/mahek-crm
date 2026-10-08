import type { ReactNode } from "react";
import { cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * Hire's charts — inline SVG and plain HTML, no chart library.
 *
 * Every chart here is ONE series, so it carries no categorical colour at all:
 * marks are drawn in the body ink, reference lines in the faint neutral, and
 * the only colour that appears is a STATUS (the amber of "below the line"),
 * always beside a word that says the same thing. Colour carries meaning in
 * this product or it carries nothing (design brief §4.1). Every mark has a
 * native hover tooltip through <title>, and every chart sits beside a table
 * with the same numbers.
 * ------------------------------------------------------------------------- */

const INK = "#3D4453";
const FAINT = "#9BA3B2";
const RULE = "#DDE1E8";
const WARN = "#B77B08";

export type Bar = { label: string; value: number; display: string; sub?: string; warn?: boolean; title?: string };

/** Horizontal bars on a shared scale — a funnel, a rate per group. */
export function HBars({ bars, max, line, lineLabel, labelWidth = 180 }: { bars: Bar[]; max?: number; line?: number; lineLabel?: string; labelWidth?: number }) {
  const top = max ?? Math.max(1, ...bars.map((b) => b.value));
  return (
    <div className="flex flex-col gap-1.5" role="list">
      {bars.map((b) => (
        <div key={b.label} role="listitem" className="flex items-center gap-3 text-[13px]" title={b.title ?? `${b.label}: ${b.display}`}>
          <span className="flex-none truncate text-body" style={{ width: labelWidth }}>
            {b.label}
          </span>
          <span className="relative h-5 flex-1">
            <span className="absolute inset-y-0 left-0 rounded-r-[4px]" style={{ width: `${Math.max(0.5, (b.value / top) * 100)}%`, background: INK, opacity: b.warn ? 0.35 : 0.72 }} />
            {line != null ? (
              <span className="absolute inset-y-[-3px] w-0 border-l border-dashed" style={{ left: `${(line / top) * 100}%`, borderColor: FAINT }} title={lineLabel} />
            ) : null}
          </span>
          <span className={cx("w-[132px] flex-none text-right tabular-nums", b.warn ? "font-medium text-warn-ink" : "text-heading")}>
            {b.warn ? "▲ " : ""}
            {b.display}
            {b.sub ? <span className="font-normal text-muted"> · {b.sub}</span> : null}
          </span>
        </div>
      ))}
      {line != null && lineLabel ? <div className="mt-1 text-xs text-muted">Dashed line: {lineLabel}</div> : null}
    </div>
  );
}

/** A scatter with a dashed least-squares line. */
export function Scatter({
  points,
  xLabel,
  yLabel,
  fit,
  xDomain = [0, 100],
  yDomain = [0, 100],
}: {
  points: { x: number; y: number; title: string }[];
  xLabel: string;
  yLabel: string;
  fit?: { a: number; b: number } | null;
  xDomain?: [number, number];
  yDomain?: [number, number];
}) {
  const W = 640;
  const H = 240;
  const L = 44;
  const B = 32;
  const sx = (x: number) => L + ((x - xDomain[0]) / (xDomain[1] - xDomain[0])) * (W - L - 12);
  const sy = (y: number) => H - B - ((y - yDomain[0]) / (yDomain[1] - yDomain[0])) * (H - B - 12);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`${yLabel} against ${xLabel}`}>
      {ticks.map((t) => {
        const y = yDomain[0] + t * (yDomain[1] - yDomain[0]);
        const x = xDomain[0] + t * (xDomain[1] - xDomain[0]);
        return (
          <g key={t}>
            <line x1={L} x2={W - 12} y1={sy(y)} y2={sy(y)} stroke={t === 0 ? RULE : "#F1F2F5"} />
            <text x={L - 6} y={sy(y) + 4} fontSize="11" fill="#6B7385" textAnchor="end" className="tabular-nums">
              {Math.round(y)}
            </text>
            <text x={sx(x)} y={H - B + 16} fontSize="11" fill="#6B7385" textAnchor="middle">
              {Math.round(x)}
            </text>
          </g>
        );
      })}
      <text x={L} y={10} fontSize="11" fill="#6B7385">
        {yLabel}
      </text>
      <text x={W - 12} y={H - 2} fontSize="11" fill="#6B7385" textAnchor="end">
        {xLabel}
      </text>
      {fit ? (
        <line x1={sx(xDomain[0])} y1={sy(fit.a + fit.b * xDomain[0])} x2={sx(xDomain[1])} y2={sy(fit.a + fit.b * xDomain[1])} stroke={FAINT} strokeDasharray="5 4" strokeWidth={2} />
      ) : null}
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={sx(p.x)} cy={sy(p.y)} r={4} fill={INK} fillOpacity={0.6} stroke="#FFFFFF" strokeWidth={2} />
          <circle cx={sx(p.x)} cy={sy(p.y)} r={10} fill="transparent">
            <title>{p.title}</title>
          </circle>
        </g>
      ))}
    </svg>
  );
}

/** Each interviewer's scores as dots on 0–100, against the panel mean. */
export function Strips({ rows, mean, pass }: { rows: { label: string; values: number[]; note?: string }[]; mean: number | null; pass?: number }) {
  const W = 640;
  const row = 28;
  const L = 170;
  const H = rows.length * row + 26;
  const sx = (v: number) => L + (Math.max(0, Math.min(100, v)) / 100) * (W - L - 16);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Score distribution per interviewer against the panel mean">
      {[0, 25, 50, 75, 100].map((t) => (
        <g key={t}>
          <line x1={sx(t)} x2={sx(t)} y1={4} y2={H - 20} stroke="#F1F2F5" />
          <text x={sx(t)} y={H - 6} fontSize="11" fill="#6B7385" textAnchor="middle">
            {t}
          </text>
        </g>
      ))}
      {pass != null ? <line x1={sx(pass)} x2={sx(pass)} y1={4} y2={H - 20} stroke={RULE} strokeDasharray="2 3" /> : null}
      {mean != null ? (
        <g>
          <line x1={sx(mean)} x2={sx(mean)} y1={4} y2={H - 20} stroke={FAINT} strokeDasharray="5 4" strokeWidth={2} />
          <title>{`Panel mean ${mean}`}</title>
        </g>
      ) : null}
      {rows.map((r, i) => {
        const y = 4 + i * row + row / 2;
        return (
          <g key={r.label}>
            <text x={0} y={y + 4} fontSize="12" fill="#3D4453">
              {r.label.length > 24 ? `${r.label.slice(0, 23)}…` : r.label}
            </text>
            {r.values.map((v, j) => (
              <circle key={j} cx={sx(v)} cy={y + ((j % 3) - 1) * 4} r={3.5} fill={INK} fillOpacity={0.45}>
                <title>{`${r.label}: ${Math.round(v)}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

/** A plain, dense table for the numbers behind a chart. */
export function DataTable({ cols, rows, align, empty }: { cols: string[]; rows: ReactNode[][]; align?: ("l" | "r")[]; empty?: string }) {
  if (!rows.length) return <div className="px-5 py-8 text-center text-sm text-muted">{empty ?? "Nothing to show yet."}</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-divider">
            {cols.map((c, i) => (
              <th key={c} className={cx("px-5 py-2.5 text-xs font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase", align?.[i] === "r" ? "text-right" : "text-left")}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="hire-row border-b border-divider last:border-0">
              {r.map((cell, j) => (
                <td key={j} className={cx("px-5 py-2 align-middle tabular-nums", align?.[j] === "r" ? "text-right" : "text-left", j === 0 ? "font-medium text-heading" : "text-body")}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const pct = (v: number | null | undefined, digits = 0) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);
export const hrs = (h: number | null | undefined) => (h == null ? "—" : h < 24 ? `${Math.max(1, Math.round(h))}h` : `${(h / 24).toFixed(h < 240 ? 1 : 0)}d`);

export { WARN };
