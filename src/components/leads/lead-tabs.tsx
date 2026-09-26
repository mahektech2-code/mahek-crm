"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import { usePathname } from "next/navigation";
import { NavLink } from "@/components/shell/nav-link";
import { cx } from "@/components/ui/primitives";
import { sectionForPath, tabsFor, type LeadSection } from "@/lib/lead-workspace";

/* ---------------------------------------------------------------------------
 * The second level of the Lead Management workspace.
 *
 * The sidebar carries ten rows and this carries what is inside whichever one
 * you are standing in. Tabs rather than ten more sidebar rows because they are
 * one question asked of several populations — "what is waiting on a manager's
 * call" and "what is waiting on a decision about a Suspect" are the same job,
 * and a sidebar that listed both would put four near-identical rows in front
 * of somebody scanning for one.
 *
 * A COUNT IS DRAWN ONLY WHERE SOMETHING IS WAITING, red past five and amber
 * below — the console's own rule, kept, because a zero beside a heading reads
 * as a problem rather than as an empty queue. The counts come from the server
 * component that renders this; nothing here asks for them, so a tab strip
 * costs no query of its own.
 *
 * Tabs are NOT separately grantable, and that is the whole reason there are
 * ten modules rather than twenty-three. Somebody holding Qualification holds
 * all four of its tabs. See the note in `lib/modules.ts` for what that buys
 * and what it costs.
 * ------------------------------------------------------------------------- */

export function LeadTabs({
  workspace,
  /**
   * Keyed by href. Only what is waiting — a zero is not drawn, and a missing
   * key is not a zero, it is a tab that counts nothing.
   */
  counts,
  /**
   * Overrides the section resolved from the path. The record screens sit under
   * `<app>/leads/[id]`, which is inside All Leads by path and belongs to no
   * tab, so they pass their own section rather than drawing the wrong strip.
   */
  section,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  counts?: Partial<Record<string, number>>;
  section?: LeadSection;
}) {
  const pathname = usePathname();
  const current = section ?? sectionForPath(workspace, pathname);

  // A section with one tab is a section with no tabs: drawing a strip of one
  // is a control that cannot be used, which reads as a broken screen. Counted
  // AFTER narrowing to this workspace, so a tab only the other app draws
  // cannot prop a strip up here.
  const tabs = current ? tabsFor(current, workspace) : [];
  if (!current || tabs.length < 2) return null;

  return (
    <nav
      aria-label={`${current.label} sections`}
      className="mb-5 flex flex-wrap items-center gap-1 border-b border-divider"
    >
      {tabs.map((tab) => {
        /* The tab knows its path and the workspace turns it into a route, so
         * one strip serves both apps and neither spells the other's segment. */
        const href = leadHref(workspace, tab.path);
        const active = tab.exact
          ? pathname === href
          : pathname === href || pathname.startsWith(href + "/");
        const count = counts?.[href] ?? 0;
        return (
          <NavLink
            key={href}
            href={href}
            title={tab.hint}
            aria-current={active ? "page" : undefined}
            className={cx(
              "-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm whitespace-nowrap no-underline hover:no-underline",
              active
                ? "border-b-brand font-medium text-[#5223E0]"
                : "border-b-transparent text-muted hover:text-body",
            )}
          >
            <span>{tab.label}</span>
            {count > 0 ? (
              <span
                className={cx(
                  "h-[18px] min-w-5 rounded-[9px] px-1.5 text-center text-[11px] leading-[18px] font-medium tabular-nums",
                  count >= 5
                    ? "bg-danger-soft text-danger"
                    : "bg-warn-line text-warn-ink",
                )}
              >
                {count}
              </span>
            ) : null}
          </NavLink>
        );
      })}
    </nav>
  );
}
