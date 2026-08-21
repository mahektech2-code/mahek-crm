"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { setManager, clearManager } from "@/lib/actions/org";
import type { OrgChart, OrgPerson } from "@/lib/services/org-service";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  MetricStrip,
  PageHeader,
  cx,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { OrgTree } from "./org-tree";

/* ---------------------------------------------------------------------------
 * The org chart.
 *
 * TWO VIEWS, because they are good at opposite things and the argument between
 * them has no winner.
 *
 * The CHART is what everybody pictures when they say org chart: cards, drawn
 * top-down, joined by lines. It shows shape — who sits under whom, which layer
 * is wide, where a manager has eleven reports — and it is the view somebody
 * wants when they are explaining the company to a person.
 *
 * The LIST is an indented outline. It reads on a phone, it takes one screen for
 * a whole department, and it is the view somebody wants when they are working
 * through twenty-six unplaced people. The chart is bad at exactly that: at this
 * size, before anybody is placed, it is twenty-six cards in a row.
 *
 * Either way a person is one click, because the thing done most on this screen
 * is fixing a line that is wrong, and an edit mode would put a step in front of
 * it.
 * ------------------------------------------------------------------------- */

export function OrgScreen({
  chart,
  includeLeavers,
  view,
  company,
}: {
  chart: OrgChart;
  includeLeavers: boolean;
  view: "tree" | "list";
  company: string;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [editing, setEditing] = React.useState<OrgPerson | null>(null);
  const [busy, setBusy] = React.useState(false);

  const { roots, all, totals } = chart;

  /*
   * NOBODY-YET IS NOT A BRANCH OF THE COMPANY.
   *
   * Everybody starts with no manager, so every unplaced person is technically a
   * root — and drawing them as one put fifteen lone cards in the top row beside
   * the actual company, which made the chart four screens wide and buried the
   * one tree that meant anything. They are the same fact the strip already
   * counts: work not done yet, not a reporting line.
   *
   * A root WITH reports is a real top. A root with none is somebody waiting to
   * be placed, and belongs in its own strip underneath where it reads as a
   * to-do list.
   */
  const trees = roots.filter((r) => r.reports.length > 0);
  const unplaced = roots.filter((r) => r.reports.length === 0);

  return (
    <div className="max-w-[1440px] px-6 pt-6 pb-10">
      <PageHeader
        title="Org chart"
        subtitle="Who reports to whom. Maintained here, not in the employee sheet — the sheet records a job title to report to, never a person."
      />

      <MetricStrip
        metrics={[
          { label: "People", value: String(totals.people) },
          { label: "With a manager", value: String(totals.withManager) },
          { label: "At the top", value: String(totals.tops) },
          {
            label: "Not placed yet",
            value: String(totals.unassigned),
            tone: totals.unassigned ? "danger" : undefined,
          },
          { label: "Deepest chain", value: totals.depth ? `${totals.depth} levels` : "—" },
        ]}
      />

      {/*
        Only ever shown when it is true, and it should never be true: a person
        in a reporting loop cannot be drawn, and silently leaving them off an
        org chart is the one failure this screen must not have.
      */}
      {totals.unreachable > 0 ? (
        <Card className="mb-4 border-danger-soft bg-danger-soft px-5 py-3.5">
          <p className="text-sm text-pretty text-danger">
            {totals.unreachable} {totals.unreachable === 1 ? "person is" : "people are"} in a
            reporting loop and cannot be placed on the chart. Clear one of their managers to
            break it.
          </p>
        </Card>
      ) : null}

      <Card className="overflow-auto">
        <CardHeader
          title={includeLeavers ? "Everybody on record" : "Current staff"}
          hint={
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1 rounded-[4px] border border-line p-0.5">
                {(["tree", "list"] as const).map((v) => (
                  <Link
                    key={v}
                    href={`/hrms/org?view=${v}${includeLeavers ? "&leavers=1" : ""}`}
                    className={cx(
                      "rounded-[3px] px-2 py-0.5 text-[12px] font-medium no-underline",
                      view === v
                        ? "bg-brand text-white"
                        : "text-body hover:bg-canvas",
                    )}
                  >
                    {v === "tree" ? "Chart" : "List"}
                  </Link>
                ))}
              </span>
              <Link
                href={`/hrms/org?view=${view}${includeLeavers ? "" : "&leavers=1"}`}
                className="text-[13px] font-medium text-brand hover:underline"
              >
                {includeLeavers ? "Hide people who have left" : "Include people who have left"}
              </Link>
            </span>
          }
        />

        {roots.length === 0 ? (
          <EmptyState
            title="No employees to show"
            body="The employee master is empty, or everybody on it has left."
          />
        ) : view === "tree" ? (
          trees.length ? (
            <OrgTree roots={trees} company={company} onEdit={setEditing} busy={busy} />
          ) : (
            <EmptyState
              title="Nobody is placed yet"
              body="Start with whoever sits at the top, then their heads. Every person you place leaves the list below."
            />
          )
        ) : (
          <div className="px-2 py-2">
            {roots.map((person) => (
              <Branch
                key={person.id}
                person={person}
                level={0}
                onEdit={setEditing}
                busy={busy}
              />
            ))}
          </div>
        )}
      </Card>

      {view === "tree" && unplaced.length ? (
        <Card className="mt-4">
          <CardHeader
            title="Not placed yet"
            hint={`${unplaced.length} ${unplaced.length === 1 ? "person" : "people"} with nobody recorded above them`}
          />
          <div className="flex flex-wrap gap-2 px-5 py-4">
            {unplaced.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={busy}
                onClick={() => setEditing(p)}
                title={`Set who ${p.name} reports to`}
                className="cursor-pointer rounded-[6px] border border-dashed border-line bg-surface px-2.5 py-1.5 text-left hover:border-brand hover:bg-canvas disabled:cursor-not-allowed"
              >
                <span className="block text-[13px] font-medium text-ink">{p.name}</span>
                <span className="mt-px block text-[12px] text-muted italic">
                  {p.position ?? "No position recorded"}
                </span>
              </button>
            ))}
          </div>
        </Card>
      ) : null}

      {/* Keyed on the person, so opening it for somebody else starts fresh. */}
      {editing ? (
        <ManagerDialog
          key={editing.id}
          person={editing}
          everybody={all}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={async (managerId) => {
            setBusy(true);
            const result = await run(
              managerId ? setManager(editing.id, managerId) : clearManager(editing.id),
            );
            setBusy(false);
            if (result.ok) {
              setEditing(null);
              router.refresh();
            }
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * One person and everybody under them.
 *
 * The indent is padding rather than nesting, so a deep branch cannot push the
 * row off the right-hand side — it caps, and the tree stays readable at any
 * depth instead of turning into a diagonal.
 */
function Branch({
  person,
  level,
  onEdit,
  busy,
}: {
  person: OrgPerson;
  level: number;
  onEdit: (p: OrgPerson) => void;
  busy: boolean;
}) {
  const indent = Math.min(level, 8) * 22;

  return (
    <>
      <div
        className="group flex items-center gap-3 rounded-[4px] px-2 py-1.5 hover:bg-canvas"
        style={{ paddingLeft: indent + 8 }}
      >
        <span
          aria-hidden
          className={cx(
            "flex-none text-muted",
            level === 0 ? "opacity-0" : "opacity-60",
          )}
        >
          └
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">{person.name}</span>
            {person.status === "inactive" ? <Badge tone="neutral">Left</Badge> : null}
            {person.reports.length ? (
              <span className="text-[11px] text-muted">
                {person.reports.length} direct
              </span>
            ) : null}
          </span>
          <span className="mt-px block truncate text-[13px] text-muted">
            {[person.position, person.department, person.officeName]
              .filter(Boolean)
              .join(" · ") || "No position recorded"}
            {/* The sheet's own answer, kept visible. It is a job title rather
                than a person, so it cannot build the tree — but it is the only
                reporting information HR has had until now, and hiding it would
                read as data lost rather than superseded. */}
            {person.sheetReportsTo ? (
              <span className="text-line-strong"> · sheet: {person.sheetReportsTo}</span>
            ) : null}
          </span>
        </span>

        <button
          type="button"
          disabled={busy}
          onClick={() => onEdit(person)}
          className="flex-none cursor-pointer rounded-[4px] border border-line bg-surface px-2.5 py-1 text-[12px] font-medium text-body opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-canvas disabled:cursor-not-allowed"
        >
          {person.managerId ? "Change manager" : "Set manager"}
        </button>
      </div>

      {person.reports.map((child) => (
        <Branch key={child.id} person={child} level={level + 1} onEdit={onEdit} busy={busy} />
      ))}
    </>
  );
}

/**
 * Choosing a manager.
 *
 * A searchable list rather than a dropdown, for the same reason the person
 * picker elsewhere is: seventy names is past where scrolling beats typing. It
 * is one component and always searchable, so nobody has to notice the day it
 * should have changed.
 */
function ManagerDialog({
  person,
  everybody,
  busy,
  onClose,
  onSave,
}: {
  person: OrgPerson;
  everybody: OrgPerson[];
  busy: boolean;
  onClose: () => void;
  onSave: (managerId: string | null) => void;
}) {
  const [query, setQuery] = React.useState("");

  // Themselves excluded — the only loop the screen can rule out without asking
  // the server. Everything else is the action's to refuse, because only it can
  // see the whole chain.
  const options = everybody
    .filter((p) => p.id !== person.id)
    .filter((p) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.position ?? "").toLowerCase().includes(q) ||
        (p.department ?? "").toLowerCase().includes(q)
      );
    })
    .slice(0, 60);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-6 pt-[10vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[520px] overflow-hidden rounded-[6px] border border-line bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-divider px-5 py-3.5">
          <div className="text-[15px] font-semibold text-ink">
            Who does {person.name} report to?
          </div>
          <div className="mt-0.5 text-[13px] text-muted">
            {person.position ?? "No position recorded"}
            {person.sheetReportsTo ? ` · the sheet says ${person.sheetReportsTo}` : ""}
          </div>
        </div>

        <div className="px-5 py-3">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, position or department…"
            className="h-9.5 w-full rounded-[4px] border border-line px-2.5 text-sm focus:border-brand focus:outline-none"
          />
        </div>

        <div className="max-h-[46vh] overflow-y-auto border-t border-divider">
          {options.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px] text-muted">
              Nobody matches that.
            </p>
          ) : (
            options.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={busy}
                onClick={() => onSave(p.id)}
                className={cx(
                  "flex w-full cursor-pointer items-center gap-3 border-none bg-transparent px-5 py-2 text-left hover:bg-canvas disabled:cursor-not-allowed",
                  p.id === person.managerId ? "bg-brand-soft" : "",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">{p.name}</span>
                  <span className="mt-px block truncate text-[13px] text-muted">
                    {[p.position, p.department].filter(Boolean).join(" · ") || "—"}
                  </span>
                </span>
                {p.id === person.managerId ? (
                  <span className="flex-none text-[12px] font-medium text-brand">current</span>
                ) : null}
              </button>
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-divider px-5 py-3">
          {person.managerId ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onSave(null)}
              className="cursor-pointer border-none bg-transparent p-0 text-[13px] font-medium text-danger hover:underline disabled:cursor-not-allowed"
            >
              Remove the reporting line
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={onClose}
            className="h-8 cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-[13px] font-medium text-body hover:bg-canvas"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
