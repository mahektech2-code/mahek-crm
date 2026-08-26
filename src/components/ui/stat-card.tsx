import * as React from "react";
import Link from "next/link";
import { Icon } from "@/components/shell/icons";
import { Progress, SectionLabel, cx } from "./primitives";

/* ---------------------------------------------------------------------------
 * The CRM dashboard's headline tile, lifted out so other apps can draw the
 * same shape rather than re-typing it. It started as a local function on
 * `crm/dashboard/page.tsx` — the founder dashboard needed the identical look
 * and a second copy is how two screens quietly drift apart.
 * ------------------------------------------------------------------------- */

export function StatCard({
  href,
  label,
  value,
  suffix,
  foot,
  foot2,
  foot3,
  progress,
  tone,
  delta,
}: {
  href: string;
  label: string;
  value: string;
  suffix?: string;
  foot?: string;
  foot2?: string;
  /** A comparison figure, shown in muted type beside foot2. */
  foot3?: string;
  progress?: number;
  tone?: "danger";
  delta?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="rounded-[6px] border border-line bg-surface p-5 no-underline transition-colors duration-100 hover:border-line-strong hover:no-underline"
    >
      <div className="flex items-center justify-between">
        <SectionLabel>{label}</SectionLabel>
        <Icon name="chevron" size={16} className="text-line-strong" />
      </div>
      <div
        className={cx(
          "mt-2 text-[32px] leading-9 font-semibold",
          tone === "danger" ? "text-danger" : "text-ink",
        )}
      >
        {value}
        {suffix ? <span className="text-xl text-muted">{suffix}</span> : null}
      </div>
      {progress !== undefined ? <Progress value={progress} className="mt-3" /> : null}
      {foot || delta ? (
        <div className="mt-2 flex flex-wrap items-baseline gap-2">
          {foot ? <span className="text-[13px] text-muted">{foot}</span> : null}
          {delta}
        </div>
      ) : null}
      {foot2 ? (
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-success">{foot2}</span>
          {foot3 ? <span className="text-[13px] text-muted">{foot3}</span> : null}
        </div>
      ) : null}
    </Link>
  );
}
