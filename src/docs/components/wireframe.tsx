import * as React from "react";
import { cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * WIREFRAMES, built from the same tokens the screens are.
 *
 * Not screenshots. A screenshot of the real Call Log would carry real
 * customers' names and balances into a page every grantee can read, and goes
 * stale the first time a column moves with nobody noticing. A wireframe says
 * what is WHERE and what it is FOR, which is what a guide needs, and numbered
 * <Hotspot>s tie a place on the screen to the step that explains it.
 *
 *   <Wireframe url="/crm/call-log" nav={["Dashboard", "Call Log", …]} active="Call Log">
 *     <WfBar> <WfTitle>Call Log</WfTitle> <WfSpacer/> <WfButton>…</WfButton> </WfBar>
 *     <WfTable columns={[…]} rows={[[…], …]} />
 *   </Wireframe>
 *   <Hotspots items={["What 1 is", "What 2 is"]} />
 * ------------------------------------------------------------------------- */

export function Wireframe({
  url,
  nav,
  active,
  caption,
  children,
}: {
  url: string;
  /** The sidebar, as labels. Omit for a dialog or a drawer drawn on its own. */
  nav?: string[];
  active?: string;
  caption?: string;
  children: React.ReactNode;
}) {
  /* A `url` that is not a web path is a HANDSET screen's title ("MBOS · Pay"),
     drawn in a phone's frame — a browser bar reading "one.mahekindia.comMBOS"
     would be a screen that does not exist. */
  if (!url.startsWith("/")) {
    return (
      <figure className="my-6">
        <div className="mx-auto w-[340px] max-w-full rounded-[28px] border-[6px] border-ink bg-ink p-0 shadow-[0_12px_32px_-14px_rgba(22,22,22,0.45)]">
          <div className="overflow-hidden rounded-[22px] bg-canvas">
            <div className="flex items-center justify-between bg-surface px-4 pt-2 pb-1 text-[10px] font-medium text-ink">
              <span>9:41</span>
              <span className="h-1.5 w-12 rounded-full bg-ink/80" />
              <span>▮▮▮ 4G</span>
            </div>
            <div className="border-b border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink">{url}</div>
            <div className="space-y-3 p-3 [&_.max-w-\[300px\]]:max-w-none">{children}</div>
          </div>
        </div>
        {caption ? <figcaption className="mt-2 text-center text-[12px] text-muted">{caption}</figcaption> : null}
      </figure>
    );
  }
  return (
    <figure className="my-6">
      <div className="overflow-hidden rounded-[8px] border border-line-strong bg-canvas shadow-[0_8px_24px_-12px_rgba(22,22,22,0.18)]">
        <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2">
          <span className="flex gap-1">
            <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
            <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
            <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
          </span>
          <span className="ml-2 flex-1 truncate rounded-[4px] bg-canvas px-2 py-0.5 font-mono text-[11px] text-muted">
            one.mahekindia.com{url}
          </span>
        </div>
        <div className="flex">
          {nav ? (
            <div className="w-[150px] flex-none border-r border-line bg-surface px-1.5 py-2">
              {nav.map((label) =>
                label.startsWith("#") ? (
                  <div key={label} className="px-2 pt-2.5 pb-1 text-[9px] font-semibold tracking-[0.06em] text-faint uppercase">
                    {label.slice(1)}
                  </div>
                ) : (
                  <div
                    key={label}
                    className={cx(
                      "mb-px flex h-6 items-center gap-1.5 rounded-[3px] border-l-2 px-2 text-[11px]",
                      label === active ? "border-l-brand bg-brand-soft font-medium text-brand-hover" : "border-l-transparent text-body",
                    )}
                  >
                    <span className={cx("h-2.5 w-2.5 flex-none rounded-[2px]", label === active ? "bg-brand/40" : "bg-line")} />
                    <span className="truncate">{label}</span>
                  </div>
                ),
              )}
            </div>
          ) : null}
          <div className="min-w-0 flex-1 space-y-3 p-4">{children}</div>
        </div>
      </div>
      {caption ? <figcaption className="mt-2 text-center text-[12px] text-muted">{caption}</figcaption> : null}
    </figure>
  );
}

/** A numbered marker. Put it next to the thing it points at. */
export function Hotspot({ n }: { n: number }) {
  return (
    <span className="relative z-10 inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full bg-brand text-[10px] leading-none font-bold text-white ring-2 ring-brand-softer">
      {n}
    </span>
  );
}

/** The key under a wireframe: what each number is. */
export function Hotspots({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="my-4 grid list-none grid-cols-1 gap-x-6 gap-y-2 pl-0 desk:grid-cols-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5 text-[13px] leading-[19px] text-body">
          <Hotspot n={i + 1} />
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

export function WfBar({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx("flex flex-wrap items-center gap-2", className)}>{children}</div>;
}

export function WfSpacer() {
  return <span className="flex-1" />;
}

export function WfTitle({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div>
      <div className="text-[16px] font-semibold text-ink">{children}</div>
      {sub ? <div className="text-[11px] text-muted">{sub}</div> : null}
    </div>
  );
}

export function WfText({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return <span className={cx("text-[11px]", muted ? "text-muted" : "text-body")}>{children}</span>;
}

export function WfButton({ children, primary }: { children: React.ReactNode; primary?: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex h-6 items-center gap-1 rounded-[3px] border px-2 text-[11px] font-medium whitespace-nowrap",
        primary ? "border-brand bg-brand text-white" : "border-line-strong bg-surface text-body",
      )}
    >
      {children}
    </span>
  );
}

export function WfInput({ placeholder, wide }: { placeholder: string; wide?: boolean }) {
  return (
    <span className={cx("inline-flex h-6 items-center rounded-[3px] border border-line bg-surface px-2 text-[11px] text-faint", wide ? "min-w-[200px] flex-1" : "min-w-[110px]")}>
      {placeholder}
    </span>
  );
}

export function WfTabs({ items, active }: { items: string[]; active: string }) {
  return (
    <div className="flex gap-3 border-b border-line">
      {items.map((t) => (
        <span
          key={t}
          className={cx("-mb-px border-b-2 pb-1.5 text-[11px]", t === active ? "border-brand font-medium text-ink" : "border-transparent text-muted")}
        >
          {t}
        </span>
      ))}
    </div>
  );
}

export function WfPill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "brand" | "success" | "warn" | "danger" | "info";
  children: React.ReactNode;
}) {
  const t = {
    neutral: "bg-canvas text-body",
    brand: "bg-brand-soft text-brand-hover",
    success: "bg-success-soft text-success",
    warn: "bg-warn-soft text-warn-ink",
    danger: "bg-danger-soft text-danger",
    info: "bg-info-soft text-info",
  }[tone];
  return <span className={cx("inline-flex h-4 items-center rounded-[2px] px-1 text-[10px] font-medium whitespace-nowrap", t)}>{children}</span>;
}

/** A grey block standing for content the guide does not need to spell out. */
export function WfBlock({ label, h = 40, className }: { label?: string; h?: number; className?: string }) {
  return (
    <div
      style={{ height: h }}
      className={cx(
        "flex items-center justify-center rounded-[4px] border border-dashed border-line-strong bg-surface text-[10px] text-faint",
        className,
      )}
    >
      {label}
    </div>
  );
}

export function WfCard({ children, title, tone }: { children: React.ReactNode; title?: string; tone?: "warn" | "brand" }) {
  return (
    <div
      className={cx(
        "rounded-[4px] border bg-surface p-2.5",
        tone === "warn" ? "border-warn-line bg-warn-soft" : tone === "brand" ? "border-brand-softer bg-brand-soft" : "border-line",
      )}
    >
      {title ? <div className="mb-1.5 text-[11px] font-semibold text-ink">{title}</div> : null}
      {children}
    </div>
  );
}

export function WfTable({
  columns,
  rows,
  highlight,
}: {
  columns: React.ReactNode[];
  rows: React.ReactNode[][];
  /** Zero-based row drawn as selected. */
  highlight?: number;
}) {
  return (
    <div className="overflow-hidden rounded-[4px] border border-line bg-surface">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-line bg-canvas">
            {columns.map((c, i) => (
              <th key={i} className="px-2 py-1.5 text-[9px] font-semibold tracking-[0.05em] whitespace-nowrap text-muted uppercase">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cx("border-b border-divider last:border-0", i === highlight && "bg-brand-soft/60")}>
              {r.map((cell, j) => (
                <td key={j} className="px-2 py-1.5 align-middle text-[11px] text-body">
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

/** A drawer or dialog drawn over the screen, on its own. */
export function WfPanel({ title, children, side }: { title: string; children: React.ReactNode; side?: boolean }) {
  return (
    <div className={cx("rounded-[6px] border border-line-strong bg-surface shadow-[0_8px_24px_-12px_rgba(22,22,22,0.25)]", side && "mx-auto max-w-[520px]")}>
      <div className="border-b border-line px-3 py-2 text-[12px] font-semibold text-ink">{title}</div>
      <div className="space-y-2.5 p-3">{children}</div>
    </div>
  );
}

export function WfField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium text-muted">{label}</div>
      {children}
    </div>
  );
}
