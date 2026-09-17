"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import { SalesmanLink } from "@/components/leads/salesman-link";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { shortDate } from "@/lib/format";
import { salesTypeLabel, stageLabel } from "@/lib/lead-labels";
import { setLeadNextAction } from "@/lib/actions/leads";
import type {
  ActionOwnerCandidate,
  NextActionRow,
  OwnerTally,
} from "@/lib/services/lead-actions-service";
import {
  Banner,
  Button,
  Cell,
  Empty,
  FilterChips,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "@/components/console/parts";
import { plural } from "@/components/console/words";

/* ---------------------------------------------------------------------------
 * §24 — what is owed on a lead TODAY, and by whom.
 *
 * **FOUR ANSWERS AND NOT A DATE.** The action, the day, the person, and what
 * that person is expected to come back with. A date alone is how a lead sits
 * for six weeks with everybody assuming somebody else is holding it — so the
 * four are four columns rather than one sentence, and a row missing any of
 * them says which one it is missing rather than drawing a tidy blank.
 *
 * **Grouped by owner, because the screen is read by a person looking for their
 * own name.** A flat list sorted by lead is a list a manager reads and nobody
 * else does; the group heading is what makes it a morning's work rather than a
 * report. The chips filter to one person for the same reason, and their counts
 * come from SQL over the WHOLE window rather than off the rows on the page —
 * a chip counted from what is drawn can only ever offer the view you are
 * already looking at.
 *
 * Nothing here works out what day it is. `today()` is the working day in
 * Asia/Kolkata with the configured boundary applied, read in the server
 * component and passed down: the React Compiler rules forbid reading the clock
 * during a render, and a browser's idea of the date is not this business's.
 * ------------------------------------------------------------------------- */

export function DueScreen({
  workspace,
  day,
  rows,
  total,
  incomplete,
  owners,
  ownerId,
  overdueTotal,
  candidates,
  canWork,
  requireNextAction,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  /** The working day, from the server. Never derived in the browser. */
  day: string;
  rows: NextActionRow[];
  total: number;
  incomplete: number;
  owners: OwnerTally[];
  ownerId?: string;
  /** For the banner: what fell off the back of this list and never came back. */
  overdueTotal: number;
  candidates: ActionOwnerCandidate[];
  canWork: boolean;
  /** `leads.requireNextAction`. Whether all four answers are mandatory. */
  requireNextAction: boolean;
}) {
  const [editing, setEditing] = React.useState<NextActionRow | null>(null);

  const chips = [
    {
      key: "all",
      label: "Everybody",
      href: leadHref(workspace, "leads/actions"),
      count: owners.reduce((n, o) => n + o.count, 0),
    },
    ...owners.map((o) => ({
      key: o.ownerId ?? "nobody",
      label: o.ownerName ?? "Nobody",
      href: o.ownerId
        ? leadHref(workspace, `leads/actions?owner=${encodeURIComponent(o.ownerId)}`)
        : leadHref(workspace, "leads/actions"),
      count: o.count,
    })),
  ];

  /* Grouped in the browser over rows the server already ordered, which is
     grouping and not filtering — the counts and the ordering are both SQL's,
     and this only decides where a heading goes. */
  const groups: { ownerId: string | null; ownerName: string | null; rows: NextActionRow[] }[] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.ownerId === r.ownerId) last.rows.push(r);
    else groups.push({ ownerId: r.ownerId, ownerName: r.ownerName, rows: [r] });
  }

  return (
    <>
      <ScreenHeader
        title="Owed today"
        subtitle="Every active lead whose next action falls today. Four answers and not a date — what is being done, on which day, by whom, and what they are expected to come back with. A date with nobody against it is how a lead sits for six weeks with everybody assuming somebody else is holding it."
        actions={
          <Link
            href={leadHref(workspace, "leads")}
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ← All leads
          </Link>
        }
      />

      {incomplete ? (
        <Banner
          tone="danger"
          title={`${plural(incomplete, "lead")} owed something today with an answer missing`}
          body="The day is set and one of the other three is not — no action written down, nobody named, or nothing said about what they should come back with. These are also on the Nothing scheduled tab; they are kept here because a lead owed something this morning is more urgent than one owed nothing at all."
        />
      ) : null}

      {overdueTotal ? (
        <Banner
          tone="warn"
          title={`${plural(overdueTotal, "lead")} already past its day`}
          body="Yesterday's version of this list, with nobody having recorded an outcome since. Nothing on it should stay on it."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Owed today", value: String(total), tone: total ? "warn" : undefined },
          {
            label: "Missing an answer",
            value: String(incomplete),
            tone: incomplete ? "danger" : undefined,
          },
          { label: "People holding one", value: String(owners.filter((o) => o.ownerId).length) },
          { label: "The day", value: shortDate(day) },
        ]}
      />

      {chips.length > 1 ? <FilterChips options={chips} current={ownerId ?? "all"} /> : null}

      {rows.length === 0 ? (
        <Empty
          title={ownerId ? "Nothing owed by them today" : "Nothing falls today"}
          body="Which is a real answer rather than an empty screen: no active lead has its next action dated today. What is worth checking beside it is the Overdue tab, and Nothing scheduled — a book with nothing due and a hundred leads nobody has promised anything about is the state §24 exists to catch."
        />
      ) : (
        <>
          {rows.length < total ? (
            <p className="mb-2 text-[12px] text-muted">
              Showing the first {rows.length} of {total}, worst first.
            </p>
          ) : null}
          {groups.map((g) => (
            <OwnerGroup workspace={workspace}
              key={g.ownerId ?? "nobody"}
              ownerName={g.ownerName}
              ownerId={g.ownerId}
              rows={g.rows}
              canWork={canWork}
              onEdit={setEditing}
            />
          ))}
        </>
      )}

      <NextActionModal
        row={editing}
        day={day}
        candidates={candidates}
        requireNextAction={requireNextAction}
        onClose={() => setEditing(null)}
      />
    </>
  );
}

function OwnerGroup({
  workspace,
  ownerId,
  ownerName,
  rows,
  canWork,
  onEdit,
}: {
  workspace: LeadWorkspace;
  ownerId: string | null;
  ownerName: string | null;
  rows: NextActionRow[];
  canWork: boolean;
  onEdit: (row: NextActionRow) => void;
}) {
  return (
    <section className="mb-5">
      <div className="mb-1.5">
        <h2 className="text-[15px] font-semibold text-ink">
          {ownerId ? (
            ownerName
          ) : (
            /* Said in words, never left blank. A next action nobody owns is the
               one a manager most needs to see, and an empty heading reads as a
               rendering fault rather than as the finding it is. */
            <span className="text-danger">Nobody is holding these</span>
          )}{" "}
          <span className="font-normal text-muted">· {rows.length}</span>
        </h2>
        {ownerId ? null : (
          <p className="text-[12px] text-muted">
            The day was written down and the person was not. Somebody has to be named before any of
            this is work.
          </p>
        )}
      </div>
      <Table
        minWidth={1260}
        head={
          <>
            <HeadCell width={230}>Lead</HeadCell>
            <HeadCell width={130}>Stage</HeadCell>
            <HeadCell width={230}>The action</HeadCell>
            <HeadCell width={250}>What they come back with</HeadCell>
            <HeadCell width={150}>Salesman</HeadCell>
            <HeadCell width={110}>Quiet</HeadCell>
            <HeadCell width={140}>&nbsp;</HeadCell>
          </>
        }
      >
        {rows.map((r, i) => (
          <Row key={r.customerId} striped={i % 2 === 1}>
            <Cell truncate={230}>
              <Link href={leadHref(workspace, `leads/${r.customerId}`)} className="no-underline">
                {r.name}
              </Link>
              <span className="block truncate text-[12px] text-muted">
                {[r.companyName, r.city].filter(Boolean).join(" · ") || "—"}
              </span>
            </Cell>
            <Cell>
              {stageLabel(r.stage)}
              <span className="block text-[12px] text-muted">{salesTypeLabel(r.salesType)}</span>
            </Cell>
            <Cell truncate={230}>
              {r.action ? (
                <>
                  <span className="text-body">{r.action}</span>
                  <span className="block truncate text-[12px] text-muted">
                    due {r.actionDate ? shortDate(r.actionDate) : "—"}
                  </span>
                </>
              ) : (
                <Pill tone="danger">No action written</Pill>
              )}
            </Cell>
            <Cell truncate={250}>
              {r.outcome ? (
                <span className="text-body">{r.outcome}</span>
              ) : (
                <span
                  className="text-warn-ink"
                  title="Nobody said what this call is supposed to produce, so there is nothing to check it against afterwards."
                >
                  Nothing expected
                </span>
              )}
            </Cell>
            <Cell truncate={150}>
              {r.salesmanId ? (
                <SalesmanLink
                  workspace={workspace}
                  id={r.salesmanId}
                  name={r.salesmanName}
                  className="no-underline"
                />
              ) : (
                <span className="text-warn-ink">Nobody</span>
              )}
            </Cell>
            <Cell>{plural(r.quietDays, "day")}</Cell>
            <Cell>
              <Button
                size="sm"
                disabled={!canWork}
                title={
                  canWork
                    ? "Change the action, the day, the person or what they come back with."
                    : "Setting a next action needs lead.work, which this account does not hold."
                }
                onClick={() => onEdit(r)}
              >
                Set next action
              </Button>
            </Cell>
          </Row>
        ))}
      </Table>
    </section>
  );
}

/* ------------------------------------------------------- M-12 set next action */

/**
 * The four answers, asked as four fields.
 *
 * ONE COPY, imported by the overdue screen beside it, because the two screens
 * ask the same question of two populations and a second modal typed into the
 * other file would be the half that drifts — and it would drift in the
 * direction of dropping the outcome, which is the field people forget and the
 * one §24 was written about.
 *
 * `requireNextAction` decides whether the outcome may be left empty. It is
 * `leads.requireNextAction`, read from configuration on the server and passed
 * down — and it is drawn here rather than enforced here: `setLeadNextAction`
 * refuses on the same rule, because a form is not a rule and a server action is
 * a URL.
 *
 * State is reset by REMOUNTING rather than in an effect — the modal body is
 * keyed on the lead, which is what the React Compiler rules ask for and what
 * every other dialog in this app already does.
 */
export function NextActionModal({
  row,
  day,
  candidates,
  requireNextAction,
  onClose,
}: {
  row: NextActionRow | null;
  day: string;
  candidates: ActionOwnerCandidate[];
  requireNextAction: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      open={Boolean(row)}
      onClose={onClose}
      title={row ? `Next action — ${row.name}` : ""}
      width={520}
    >
      {row ? (
        <NextActionForm
          key={row.customerId}
          row={row}
          day={day}
          candidates={candidates}
          requireNextAction={requireNextAction}
          onClose={onClose}
        />
      ) : null}
    </Modal>
  );
}

function NextActionForm({
  row,
  day,
  candidates,
  requireNextAction,
  onClose,
}: {
  row: NextActionRow;
  day: string;
  candidates: ActionOwnerCandidate[];
  requireNextAction: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();

  const [action, setAction] = React.useState(row.action ?? "");
  /* The stored day where there is one, and today where there is not. Never a
     day worked out in the browser: `day` is the business's own working date,
     read on the server with the configured boundary applied. */
  const [date, setDate] = React.useState(row.actionDate ?? day);
  const [owner, setOwner] = React.useState(row.ownerId ?? "");
  const [outcome, setOutcome] = React.useState(row.outcome ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const missing = [
    action.trim() ? null : "the action",
    date ? null : "a day",
    owner ? null : "a person",
    requireNextAction && !outcome.trim() ? "what they come back with" : null,
  ].filter(Boolean) as string[];

  async function submit() {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await setLeadNextAction(row.customerId, {
        action: action.trim(),
        date,
        ownerId: owner,
        outcome: outcome.trim() || undefined,
      });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
    toast.push(result.message ?? "Next action set.");
    router.refresh();
  }

  /* The owner already on the lead may not be in the candidate list — a person
     who has left the funnel, or one past the cap. Dropping them from the select
     would silently reassign the lead on the next save, so they are carried. */
  const people = candidates.some((c) => c.id === row.ownerId)
    ? candidates
    : row.ownerId && row.ownerName
      ? [{ id: row.ownerId, name: row.ownerName, leads: 0 }, ...candidates]
      : candidates;

  return (
    <>
      <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
        <div className="font-medium text-ink">{row.name}</div>
        <div className="text-muted">
          {stageLabel(row.stage)} · {salesTypeLabel(row.salesType)} ·{" "}
          {plural(row.quietDays, "day")} since anything happened
        </div>
      </div>

      <label className="block">
        <span className="mb-1 block text-[13px] font-medium text-ink">What is being done</span>
        <input
          value={action}
          onChange={(e) => setAction(e.target.value)}
          autoFocus
          placeholder="Ring the works manager about the trial"
          className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
        />
      </label>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">On which day</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">By whom</span>
          <select
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
          >
            <option value="">Nobody yet</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="mt-3 block">
        <span className="mb-1 block text-[13px] font-medium text-ink">
          What they come back with
          {requireNextAction ? null : <span className="font-normal text-muted"> (optional)</span>}
        </span>
        <textarea
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          rows={2}
          placeholder="Whether they will take a 20 L trial pack, and when"
          className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
        />
        <span className="mt-1 block text-[12px] text-muted">
          This is the half that makes the other three checkable. &ldquo;Call him&rdquo; on a Tuesday
          with nothing expected back is a lead nobody can say was worked.
        </span>
      </label>

      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button tone="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button
          tone="primary"
          disabled={busy || missing.length > 0}
          title={
            missing.length
              ? `Still missing ${missing.join(", ")}. An active lead may not sit with nothing owed by anybody.`
              : undefined
          }
          onClick={() => void submit()}
        >
          {busy ? "Saving…" : "Set it"}
        </Button>
      </div>
    </>
  );
}
