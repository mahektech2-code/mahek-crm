"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import {
  hubHref,
  hubPlace,
  linkMatches,
  type HubCountKey,
  type HubDesk,
  type HubLink,
} from "@/lib/lead-hub";
import { LeadHubChrome } from "./hub-context";

type Counts = Partial<Record<HubCountKey, number>>;

function Count({ n, red }: { n: number; red: boolean }) {
  if (n <= 0) return null;
  return (
    <span
      className={cx(
        "h-[18px] min-w-5 rounded-[9px] px-1.5 text-center text-[11px] leading-[18px] font-semibold tabular-nums",
        red ? "bg-danger-soft text-danger" : "bg-divider text-body",
      )}
    >
      {n}
    </span>
  );
}

/**
 * The CRM's Leads frame, drawn the way every CRM page is drawn.
 *
 * The sidebar is the navigation: Leads is a group with a row per desk. What
 * the frame adds is the page header — the desk's title, the screen's buttons
 * beside it, "+ New lead" where a desk offers it — and, where a desk has more
 * than one screen, ONE row of tabs under it. A record (a lead, a sample) names
 * itself, so on a record the frame draws nothing at all.
 */
export function LeadHubFrame({
  desks,
  counts,
  canAdd,
  children,
}: {
  desks: HubDesk[];
  counts: Counts;
  canAdd: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const place = hubPlace(desks, pathname);
  const [slot, setSlot] = React.useState<HTMLElement | null>(null);

  const onRecord = place !== null && place.link === null;
  const desk = place && !onRecord ? place.desk : null;

  if (!desk) return <LeadHubChrome>{children}</LeadHubChrome>;

  return (
    <div className="min-h-full">
      <div className="flex flex-col gap-3 px-6 pt-5 print:hidden">
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
          <h1 className="m-0 text-2xl leading-[30px] font-semibold text-ink">{desk.label}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <div ref={setSlot} className="flex flex-wrap items-center gap-2 empty:hidden" />
            {desk.addButton && canAdd ? (
              <Link
                href={hubHref("leads/intake")}
                className="inline-flex h-9 items-center rounded-[6px] bg-brand px-4 text-sm font-medium text-white no-underline hover:bg-brand-hover hover:text-white hover:no-underline"
              >
                + New lead
              </Link>
            ) : null}
          </div>
        </div>
        {desk.links.length > 1 ? <Tabs links={desk.links} pathname={pathname} counts={counts} /> : null}
      </div>
      <LeadHubChrome slot={slot}>
        <div className="[&>div:first-child]:!pt-4">{children}</div>
      </LeadHubChrome>
    </div>
  );
}

/** The one tab style inside Lead Management: underlined, like the record's tabs. */
function Tabs({ links, pathname, counts }: { links: HubLink[]; pathname: string; counts: Counts }) {
  return (
    <nav aria-label="Views" className="flex gap-6 overflow-x-auto border-b border-line">
      {links.map((l) => {
        const on = linkMatches(l, pathname);
        const n = l.count ? (counts[l.count] ?? 0) : 0;
        return (
          <Link
            key={l.path}
            href={hubHref(l.path)}
            aria-current={on ? "page" : undefined}
            className={cx(
              "-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-0.5 text-sm whitespace-nowrap no-underline hover:no-underline",
              on
                ? "border-b-brand font-semibold text-ink hover:text-ink"
                : "border-b-transparent font-medium text-muted hover:text-ink",
            )}
          >
            {l.label}
            <Count n={n} red={l.count === "overdue" || l.count === "slipped"} />
          </Link>
        );
      })}
    </nav>
  );
}
