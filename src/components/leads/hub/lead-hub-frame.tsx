"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import {
  hubHref,
  hubPlace,
  linkMatches,
  type HubArea,
  type HubCountKey,
  type HubDesk,
  type HubLink,
} from "@/lib/lead-hub";
import { LeadHubChrome } from "./hub-context";

type Counts = Partial<Record<HubCountKey, number>>;

function deskCount(desk: HubDesk, counts: Counts): number {
  return desk.links.reduce((n, l) => n + (l.count ? (counts[l.count] ?? 0) : 0), 0);
}

function Count({ n, tone }: { n: number; tone: "red" | "grey" | "inverse" }) {
  if (n <= 0) return null;
  return (
    <span
      className={cx(
        "h-[18px] min-w-5 rounded-[9px] px-1.5 text-center text-[11px] leading-[18px] font-semibold tabular-nums",
        tone === "red" && "bg-danger-soft text-danger",
        tone === "grey" && "bg-divider text-body",
        tone === "inverse" && "bg-body text-white",
      )}
    >
      {n}
    </span>
  );
}

/** The first link of a desk — where pressing the desk lands. */
const deskHref = (desk: HubDesk) => hubHref(desk.links[0].path);

export function LeadHubFrame({
  areas,
  counts,
  overdue,
  canSearch,
  canAdd,
  children,
}: {
  areas: HubArea[];
  counts: Counts;
  overdue: number;
  canSearch: boolean;
  canAdd: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const place = hubPlace(areas, pathname);
  const [q, setQ] = React.useState("");

  const area = place?.area ?? null;
  const desk = place?.desk ?? null;

  function search(e: React.FormEvent) {
    e.preventDefault();
    const term = q.trim();
    router.push(term ? `${hubHref("leads")}?q=${encodeURIComponent(term)}` : hubHref("leads"));
  }

  /* A record (a lead, a sample, an appointment) is inside a desk and is none
     of its tabs: it gets the area and nothing under it. */
  const onRecord = place !== null && place.link === null;
  const subTabs = !onRecord && desk && !desk.pageTabs && desk.links.length > 1 ? desk.links : null;
  const strip = area && !onRecord ? area.desks.filter((d) => !d.hidden || d.key === desk?.key) : [];

  return (
    <div className="min-h-full">
      <header className="border-b border-line bg-surface px-6 print:hidden">
        <div className="flex min-h-[60px] flex-wrap items-center gap-3 py-2">
          <h1 className="m-0 flex-1 text-xl leading-7 font-semibold text-ink">Leads</h1>
          {canSearch ? (
            <form onSubmit={search} role="search" className="w-[300px] max-w-full">
              <label className="flex h-9 items-center gap-2 rounded-[6px] border border-line bg-surface px-3 text-muted focus-within:border-brand">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  aria-label="Search leads"
                  placeholder="Shop, town, phone, owner"
                  className="min-w-0 flex-1 border-0 bg-transparent text-sm text-ink outline-none placeholder:text-faint"
                />
              </label>
            </form>
          ) : null}
          {canAdd ? (
            <Link
              href={hubHref("leads/intake")}
              className="inline-flex h-9 items-center rounded-[6px] bg-brand px-4 text-sm font-medium text-white no-underline hover:bg-brand-hover hover:text-white hover:no-underline"
            >
              + New lead
            </Link>
          ) : null}
        </div>
        {areas.length > 1 ? (
          <nav aria-label="Lead management" className="flex gap-6 overflow-x-auto">
            {areas.map((a) => {
              const on = a.key === area?.key;
              const n = a.key === "today" ? (counts.attention ?? 0) : 0;
              return (
                <Link
                  key={a.key}
                  href={deskHref(a.desks[0])}
                  aria-current={on ? "page" : undefined}
                  className={cx(
                    "-mb-px inline-flex h-11 items-center gap-1.5 border-b-2 px-1 text-sm whitespace-nowrap no-underline hover:no-underline",
                    on
                      ? "border-b-brand font-semibold text-ink hover:text-ink"
                      : "border-b-transparent font-medium text-muted hover:text-ink",
                  )}
                >
                  {a.label}
                  <Count n={n} tone={overdue > 0 ? "red" : "grey"} />
                </Link>
              );
            })}
          </nav>
        ) : null}
      </header>

      <LeadHubChrome>
        {area?.key === "insights" ? (
          <div className="flex flex-wrap items-start gap-6 px-6 pt-5">
            <InsightsNav area={area} pathname={pathname} />
            <div className="min-w-0 flex-[999_1_560px] [&>div]:!p-0">{children}</div>
          </div>
        ) : (
          <>
            {area && (strip.length > 1 || subTabs) ? (
              <div className="flex flex-col gap-3 px-6 pt-5 print:hidden">
                {strip.length > 1 ? (
                  <DeskStrip area={area} desks={strip} active={desk} counts={counts} />
                ) : null}
                {subTabs ? <SubTabs links={subTabs} pathname={pathname} counts={counts} /> : null}
              </div>
            ) : null}
            <div className="[&>div:first-child]:!pt-5">{children}</div>
          </>
        )}
      </LeadHubChrome>
    </div>
  );
}

function DeskStrip({
  area,
  desks,
  active,
  counts,
}: {
  area: HubArea;
  desks: HubDesk[];
  active: HubDesk | null;
  counts: Counts;
}) {
  const cards = area.key === "pipeline";
  return (
    <nav aria-label={`${area.label} desks`} className="flex gap-2.5 overflow-x-auto pb-0.5">
      {desks.map((d) => {
        const on = d.key === active?.key;
        const n = deskCount(d, counts);
        return cards ? (
          <Link
            key={d.key}
            href={deskHref(d)}
            aria-current={on ? "page" : undefined}
            className={cx(
              "flex min-w-[150px] flex-col gap-0.5 rounded-[10px] border bg-surface px-3.5 py-3 text-ink no-underline hover:border-line-strong hover:text-ink hover:no-underline",
              on ? "border-brand shadow-[inset_0_0_0_1px_var(--color-brand)]" : "border-line",
            )}
          >
            <strong className="text-sm font-semibold">{d.label}</strong>
            <span className="text-xs text-muted">{n > 0 ? `${n} waiting` : "Nothing waiting"}</span>
          </Link>
        ) : (
          <Link
            key={d.key}
            href={deskHref(d)}
            aria-current={on ? "page" : undefined}
            className={cx(
              "inline-flex h-9 items-center gap-2 rounded-full border px-4 text-sm font-medium whitespace-nowrap no-underline hover:no-underline",
              on
                ? "border-brand bg-brand-soft text-brand-deep hover:text-brand-deep"
                : "border-line bg-surface text-body hover:text-ink",
            )}
          >
            {d.label}
            <Count n={n} tone={on ? "inverse" : "grey"} />
          </Link>
        );
      })}
    </nav>
  );
}

function SubTabs({
  links,
  pathname,
  counts,
}: {
  links: HubLink[];
  pathname: string;
  counts: Counts;
}) {
  return (
    <nav aria-label="Views" className="flex flex-wrap items-center gap-1.5">
      {links.map((l) => {
        const on = linkMatches(l, pathname);
        const n = l.count ? (counts[l.count] ?? 0) : 0;
        return (
          <Link
            key={l.path}
            href={hubHref(l.path)}
            aria-current={on ? "page" : undefined}
            className={cx(
              "inline-flex h-8 items-center gap-1.5 rounded-[6px] px-3 text-[13px] font-medium whitespace-nowrap no-underline hover:no-underline",
              on
                ? "bg-ink text-white hover:text-white"
                : "text-body hover:bg-canvas hover:text-ink",
            )}
          >
            {l.label}
            <Count
              n={n}
              tone={
                on ? "inverse" : l.count === "overdue" || l.count === "slipped" ? "red" : "grey"
              }
            />
          </Link>
        );
      })}
    </nav>
  );
}

function InsightsNav({ area, pathname }: { area: HubArea; pathname: string }) {
  return (
    <nav aria-label="Insights" className="max-w-[220px] flex-[1_1_200px] print:hidden">
      {area.desks.map((d) => (
        <div key={d.key}>
          <p className="mx-3 mt-3.5 mb-1 text-[11px] font-semibold tracking-[0.04em] text-muted uppercase first:mt-0">
            {d.label}
          </p>
          {d.links.map((l) => {
            const on = linkMatches(l, pathname);
            return (
              <Link
                key={l.path}
                href={hubHref(l.path)}
                aria-current={on ? "page" : undefined}
                className={cx(
                  "flex h-9 items-center rounded-[6px] px-3 text-sm font-medium no-underline hover:no-underline",
                  on
                    ? "bg-brand-soft text-brand-deep hover:text-brand-deep"
                    : "text-body hover:bg-canvas hover:text-ink",
                )}
              >
                {l.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
