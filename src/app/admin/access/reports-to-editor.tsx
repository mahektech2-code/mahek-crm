"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, CardHeader, Field, Input, Select } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { ADMIN } from "@/lib/admin-routes";
import { setReportsTo } from "@/lib/actions/reports-to";
import { reportsToRefusal, type ReportsToPerson } from "@/lib/reports-to";

/* ---------------------------------------------------------------------------
 * "Reports to", editable — the one place `users.reports_to_id` is written.
 *
 * Everybody active is offered, not only managers: the handset tells this
 * person's manager about their day whatever level that manager holds. But
 * the CRM's team scope is drawn only for somebody who manages an app, so the
 * managers come first under their own heading and the hint says why the rest
 * are there.
 *
 * A choice that would close a loop is listed and disabled with the reason,
 * the same sentence `setReportsTo` refuses with — a name missing from the
 * list reads as a broken list. The server checks again; this only saves the
 * round trip.
 *
 * Remounted by its parent (keyed on the stored manager) after a save, so the
 * picker starts from what was written rather than resetting in an effect.
 * ------------------------------------------------------------------------- */

export type PickPerson = ReportsToPerson & { role: "associate" | "manager" | "admin" };

export function ReportsToEditor({
  userId,
  name,
  current,
  people,
}: {
  userId: string;
  name: string;
  current: string | null;
  people: PickPerson[];
}) {
  const router = useRouter();
  const notify = useToast().push;
  const [picked, setPicked] = React.useState<string>(current ?? "");
  const [filter, setFilter] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const byId = new Map(people.map((p) => [p.id, p]));
  const currentPerson = current ? (byId.get(current) ?? null) : null;
  const reports = people.filter((p) => p.reportsToId === userId).sort((a, b) => a.name.localeCompare(b.name));

  const needle = filter.trim().toLowerCase();
  /* The picked one stays in the list whatever is typed, or the select would
     show a different name from the one about to be saved. */
  const offered = people
    .filter((p) => p.id !== userId && p.active)
    .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.id === picked)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ ...p, refusal: reportsToRefusal(userId, p.id, people) }));
  const managers = offered.filter((p) => p.role !== "associate");
  const others = offered.filter((p) => p.role === "associate");

  const next = picked || null;
  const refusal = reportsToRefusal(userId, next, people);
  const changed = next !== (current ?? null);

  async function save(to: string | null) {
    setBusy(true);
    try {
      const r = await setReportsTo(userId, to);
      notify(r.ok ? (r.message ?? "Saved.") : r.error);
      if (r.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const option = (p: (typeof offered)[number]) => (
    <option key={p.id} value={p.id} disabled={!!p.refusal}>
      {p.name}
      {p.refusal ? " — reports up to them already" : ""}
    </option>
  );

  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <CardHeader
        title="Reporting line"
        hint="Who this account reports to. It decides a CRM manager's team, a sales manager's salesmen, and who the handset tells about their day — with nobody set, the handset tells every manager. The HRMS org chart is HR's own answer and is kept separately (see Set elsewhere on the Apps tab)."
      />
      <div className="grid gap-5 px-5 py-4 md:grid-cols-2">
        <div>
          <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Reports to now</div>
          <div className="mt-0.5 text-sm text-ink">
            {currentPerson ? (
              <>
                <Link href={ADMIN.person(currentPerson.id)}>{currentPerson.name}</Link>
                {currentPerson.active ? null : <span className="ml-2 text-[13px] text-warn-ink">deactivated</span>}
              </>
            ) : current ? (
              "An account that no longer exists"
            ) : (
              "Nobody"
            )}
          </div>

          <div className="mt-4 grid gap-2">
            <Field label="Find a person" optional>
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Type a name"
                aria-label="Filter the people listed"
              />
            </Field>
            <Field label="Reports to" hint="Managers and administrators first: only they see a CRM team." hintShown>
              <Select value={picked} onChange={(e) => setPicked(e.target.value)} disabled={busy}>
                <option value="">Nobody</option>
                {managers.length ? <optgroup label="Managers and administrators">{managers.map(option)}</optgroup> : null}
                {others.length ? <optgroup label="Everyone else">{others.map(option)}</optgroup> : null}
              </Select>
            </Field>
            {changed && refusal ? <div className="text-[13px] text-danger">{refusal}</div> : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={busy || !changed || !!refusal}
                title={!changed ? "Pick somebody different first" : refusal ?? undefined}
                onClick={() => void save(next)}
              >
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !current}
                title={current ? `${name} will report to nobody` : "They already report to nobody"}
                onClick={() => void save(null)}
              >
                Clear
              </Button>
            </div>
          </div>
        </div>

        <div>
          <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            {reports.length === 0
              ? "Manages nobody"
              : `Manages ${reports.length} ${reports.length === 1 ? "person" : "people"}`}
          </div>
          {reports.length === 0 ? (
            <div className="mt-0.5 text-[13px] text-muted">No account names {name} as the person they report to.</div>
          ) : (
            <ul className="mt-1 grid gap-1">
              {reports.map((r) => (
                <li key={r.id} className="text-sm">
                  <Link href={ADMIN.person(r.id)}>{r.name}</Link>
                  {r.active ? null : <span className="ml-2 text-[13px] text-muted">deactivated</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}
