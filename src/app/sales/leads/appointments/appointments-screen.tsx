"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { money, parseRupees, stamp } from "@/lib/format";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { stageLabel } from "@/lib/lead-labels";
import type { AppointmentRow } from "@/lib/services/lead-console-service";
import {
  agreeCommercialTerms,
  decideDistributorAppointment,
} from "@/lib/actions/distributor-appointment";
import {
  Banner,
  Button,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "../../parts";
import { plural, waitingWords } from "../../words";

type Acting =
  | { kind: "decide"; row: AppointmentRow; approve: boolean }
  | { kind: "terms"; row: AppointmentRow };

/**
 * The appointment queue, by step.
 *
 * **One row per approval, not per candidate.** The two steps are two decisions
 * with two people and two dates; rolling them together makes it impossible to
 * say whether the thing waiting is a sales manager who has not looked or a
 * director who has not been asked yet.
 *
 * **A manager cannot decide step 1, and the button says so rather than
 * vanishing.** A control that is simply absent teaches nothing — the manager
 * concludes the screen is broken, or that the appointment is stuck, and rings
 * somebody about it. Disabled with a `title` naming the reason sends them to
 * the right person. The refusal itself is in the action, because a server
 * action is a URL and a hidden button is not a permission.
 *
 * **Step 1 is also refused where step 0 has not answered.** Nothing stops the
 * escalation row being created early, and offering management a decision on
 * something their own sales manager has not seen is offering them somebody
 * else's job.
 */
export function AppointmentsScreen({
  rows,
  canApproveManagement,
  discountThreshold,
  creditLimitThresholdPaise,
  staleHours,
  nowMs,
}: {
  rows: AppointmentRow[];
  canApproveManagement: boolean;
  /** Above this, §12 says a second signature is required. */
  discountThreshold: number;
  creditLimitThresholdPaise: number;
  staleHours: number;
  /** The clock, read once on the server — a client may not read it in render. */
  nowMs: number;
}) {
  const router = useRouter();
  const toast = useToast();

  const [acting, setActing] = React.useState<Acting | null>(null);
  const [note, setNote] = React.useState("");
  const [discount, setDiscount] = React.useState("");
  const [creditLimit, setCreditLimit] = React.useState("");
  const [exclusivity, setExclusivity] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function begin(next: Acting) {
    setActing(next);
    setNote("");
    setError(null);
    if (next.kind === "terms") {
      setDiscount(next.row.discountPercent != null ? String(next.row.discountPercent) : "");
      setCreditLimit(
        next.row.creditLimitPaise != null
          ? String(Math.round(next.row.creditLimitPaise / 100))
          : "",
      );
      setExclusivity(Boolean(next.row.exclusivityGranted));
    }
  }

  async function submit() {
    if (!acting) return;
    setBusy(true);
    setError(null);
    let result;
    try {
      result =
        acting.kind === "decide"
          ? await decideDistributorAppointment(acting.row.approvalId, {
              approve: acting.approve,
              note: note.trim(),
            })
          : await agreeCommercialTerms(acting.row.customerId, {
              discountPercent: Number(discount) || 0,
              creditLimitPaise: parseRupees(creditLimit) ?? 0,
              exclusivity,
              note: note.trim(),
            });
    } finally {
      /* Cleared whatever happened: an action that rejects rather than
         returning a Result would otherwise leave the button dead. */
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setActing(null);
    toast.push(result.message ?? "Answered.");
    router.refresh();
  }

  const managerStep = rows.filter((r) => r.stepIndex === 0);
  const managementStep = rows.filter((r) => r.stepIndex >= 1);
  const oldest = rows.reduce((n, r) => Math.max(n, r.waitingHours), 0);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Distributor appointments"
        subtitle="Thirty answers, then two signatures. A sales manager may recommend an appointment and may not make one — a discount, a credit limit or exclusivity is a decision with a cost, and the person carrying the target should not be the one allowing it."
        actions={
          <Link
            href="/sales/leads"
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ← All leads
          </Link>
        }
      />

      {rows.length && oldest >= staleHours ? (
        <Banner
          tone="warn"
          title={`The oldest appointment has been waiting ${waitingWords(oldest)}`}
          body="A candidate distributor is sitting on a signature, and until it is answered nobody can bill them or send them stock."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Sales manager", value: String(managerStep.length) },
          { label: "Management", value: String(managementStep.length) },
          { label: "Oldest", value: rows.length ? waitingWords(oldest) : "—" },
          {
            label: "Over the threshold",
            value: String(rows.filter((r) => r.routeReason).length),
            sub: `>${discountThreshold}% or >${money(creditLimitThresholdPaise)}`,
          },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title="No appointment waiting"
          body="A candidate reaches this queue when a sales manager puts them up for appointment, which they can only do once the thirty conditions are answered."
        />
      ) : (
        <>
          <StepTable
            title="Waiting on the sales manager"
            note="Step 0. The person who knows whether that territory already has somebody in it."
            rows={managerStep}
            canDecide
            disabledReason={undefined}
            onDecide={(row, approve) => begin({ kind: "decide", row, approve })}
            onTerms={(row) => begin({ kind: "terms", row })}
            nowMs={nowMs}
          />
          <StepTable
            title="Waiting on management"
            note="Step 1, and it exists because of the three numbers below. Appointed here, and billable from here."
            rows={managementStep}
            canDecide={canApproveManagement}
            disabledReason={
              canApproveManagement
                ? undefined
                : "Appointing a distributor is management's. A sales manager may recommend one and may not make one — that is the whole reason there are two steps."
            }
            onDecide={(row, approve) => begin({ kind: "decide", row, approve })}
            onTerms={(row) => begin({ kind: "terms", row })}
            nowMs={nowMs}
          />
        </>
      )}

      {/* ------------------------------------------------------- decide */}

      <Modal
        open={acting?.kind === "decide"}
        onClose={() => setActing(null)}
        title={acting?.kind === "decide" && acting.approve ? "Approve this appointment" : "Refuse it"}
        width={520}
      >
        {acting?.kind === "decide" ? (
          <>
            <Subject row={acting.row} />
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink">
                {acting.approve ? "Anything to add (optional)" : "Why · required"}
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder={
                  acting.approve
                    ? "Goes on the record with the decision"
                    : "The salesman has to be able to go back with something"
                }
                className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
              />
            </label>
            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button tone="quiet" onClick={() => setActing(null)}>
                Cancel
              </Button>
              <Button
                tone={acting.approve ? "primary" : "danger"}
                disabled={busy || (!acting.approve && !note.trim())}
                title={
                  !acting.approve && !note.trim()
                    ? "Say why. A refusal with no reason is a decision nobody can act on."
                    : undefined
                }
                onClick={() => void submit()}
              >
                {busy ? "Saving…" : acting.approve ? "Approve" : "Refuse"}
              </Button>
            </div>
            {acting.approve && acting.row.stepIndex >= 1 ? (
              <p className="mt-3 text-[12px] text-muted">
                They become billable from this decision. Everything from the agreement onwards is
                paperwork against an account we invoice.
              </p>
            ) : null}
          </>
        ) : null}
      </Modal>

      {/* -------------------------------------------------- commercial terms */}

      <Modal
        open={acting?.kind === "terms"}
        onClose={() => setActing(null)}
        title="Commercial terms"
        width={520}
      >
        {acting?.kind === "terms" ? (
          <>
            <Subject row={acting.row} />
            <p className="mb-3 text-[13px] text-body">
              These three are what decide whether a sales manager&rsquo;s signature is enough. Over{" "}
              {discountThreshold}% discount, over {money(creditLimitThresholdPaise)} of credit
              limit, or any exclusivity, and it goes to management.
            </p>

            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink">Discount %</span>
                <input
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                  inputMode="numeric"
                  className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink">
                  Credit limit (₹)
                </span>
                <input
                  value={creditLimit}
                  onChange={(e) => setCreditLimit(e.target.value)}
                  inputMode="numeric"
                  className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
                />
                <span className="mt-1 block text-[12px] text-muted">
                  In rupees. Stored in paise, like every figure here.
                </span>
              </label>
            </div>

            <label className="mt-3 flex items-start gap-2">
              <input
                type="checkbox"
                checked={exclusivity}
                onChange={(e) => setExclusivity(e.target.checked)}
                className="mt-[3px]"
              />
              <span className="text-[13px]">
                <span className="block text-ink">Territory exclusivity</span>
                <span className="block text-[12px] text-muted">
                  Granting this closes the territory to anybody else, so it always goes to
                  management whatever the numbers say.
                </span>
              </span>
            </label>

            <label className="mt-3 block">
              <span className="mb-1 block text-[13px] font-medium text-ink">
                What was agreed · required
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
              />
            </label>

            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

            <div className="mt-4 flex justify-end gap-2">
              <Button tone="quiet" onClick={() => setActing(null)}>
                Cancel
              </Button>
              <Button
                tone="primary"
                disabled={busy || !note.trim()}
                title={
                  !note.trim()
                    ? "Say what was agreed. The numbers alone do not say what the conversation settled."
                    : undefined
                }
                onClick={() => void submit()}
              >
                {busy ? "Saving…" : "Record the terms"}
              </Button>
            </div>
          </>
        ) : null}
      </Modal>
    </div>
  );
}

function Subject({ row }: { row: AppointmentRow }) {
  return (
    <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
      <div className="font-medium text-ink">{row.name}</div>
      <div className="text-muted">
        {[row.companyName, row.city].filter(Boolean).join(" · ") || "—"} ·{" "}
        {stageLabel(row.stage)}
      </div>
      <div className="mt-1 text-[12px] text-muted">
        {row.proposedTerritory ? `Asking for ${row.proposedTerritory}` : "No territory named"}
        {row.territoryConflict ? " · clashes with an existing distributor" : ""}
        {row.monthlyPotentialPaise
          ? ` · ${money(row.monthlyPotentialPaise)} a month claimed`
          : ""}
      </div>
    </div>
  );
}

function StepTable({
  title,
  note,
  rows,
  canDecide,
  disabledReason,
  onDecide,
  onTerms,
  nowMs,
}: {
  title: string;
  note: string;
  rows: AppointmentRow[];
  canDecide: boolean;
  disabledReason?: string;
  onDecide: (row: AppointmentRow, approve: boolean) => void;
  onTerms: (row: AppointmentRow) => void;
  nowMs: number;
}) {
  if (!rows.length) return null;
  return (
    <section className="mb-5">
      <div className="mb-1.5">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        <p className="text-[12px] text-muted">{note}</p>
      </div>
      <Table
        minWidth={1240}
        head={
          <>
            <HeadCell width={230}>Candidate</HeadCell>
            <HeadCell width={180}>Territory</HeadCell>
            <HeadCell width={200}>Terms</HeadCell>
            <HeadCell width={170}>Why this step</HeadCell>
            <HeadCell width={140}>Waiting</HeadCell>
            <HeadCell align="right" width={250} />
          </>
        }
      >
        {rows.map((r, i) => {
          const blockedByStep = r.stepIndex >= 1 && !r.managerStepDone;
          const off = !canDecide || blockedByStep;
          const why = blockedByStep
            ? "The sales manager has not answered step 0 yet. Deciding ahead of them is deciding somebody else's half."
            : disabledReason;
          return (
            <Row key={r.approvalId} striped={i % 2 === 1}>
              <Cell truncate={230}>
                <Link href={`/sales/leads/${r.customerId}`} className="no-underline">
                  {r.name}
                </Link>
                <span className="block truncate text-[12px] text-muted">
                  {[r.companyName, r.city].filter(Boolean).join(" · ") || "—"}
                </span>
              </Cell>
              <Cell truncate={180}>
                {r.proposedTerritory ?? <span className="text-muted">Not named</span>}
                {r.territoryConflict ? (
                  <span className="block text-[12px] text-danger">Clashes</span>
                ) : null}
              </Cell>
              <Cell truncate={200}>
                {r.commercialTermsAgreedAt ? (
                  <>
                    <span className="block text-[13px] text-body">
                      {r.discountPercent ?? 0}% ·{" "}
                      {r.creditLimitPaise ? money(r.creditLimitPaise) : "no limit"}
                    </span>
                    <span className="block text-[12px] text-muted">
                      {r.exclusivityGranted ? "exclusive" : "not exclusive"} · agreed{" "}
                      {stamp(r.commercialTermsAgreedAt)}
                    </span>
                  </>
                ) : (
                  <span className="text-warn-ink">Not agreed</span>
                )}
              </Cell>
              <Cell truncate={170}>
                {r.routeReason ? (
                  <Pill tone="warn">{r.routeReason.replace(/_/g, " ")}</Pill>
                ) : (
                  <span className="text-muted">Ordinary</span>
                )}
              </Cell>
              <Cell title={`Asked ${stamp(r.requestedAt)}${r.requestedByName ? ` by ${r.requestedByName}` : ""}`}>
                {waitingWords(
                  /* Measured from the server's clock, passed in — the row's own
                     hours were computed in SQL, and this only fills in for a
                     row that arrived a moment ago. */
                  Math.max(r.waitingHours, Math.floor((nowMs - r.requestedAt.valueOf()) / 3_600_000)),
                )}
                {r.requestedByName ? (
                  <span className="block truncate text-[12px] text-muted">
                    from {r.requestedByName}
                  </span>
                ) : null}
              </Cell>
              <Cell align="right">
                <span className="flex justify-end gap-1.5">
                  <Button size="sm" onClick={() => onTerms(r)}>
                    Terms
                  </Button>
                  <Button
                    size="sm"
                    tone="primary"
                    disabled={off}
                    title={off ? why : undefined}
                    onClick={() => onDecide(r, true)}
                  >
                    Appoint
                  </Button>
                  <Button
                    size="sm"
                    tone="danger"
                    disabled={off}
                    title={off ? why : undefined}
                    onClick={() => onDecide(r, false)}
                  >
                    Refuse
                  </Button>
                </span>
              </Cell>
            </Row>
          );
        })}
      </Table>
      <p className="mt-1.5 text-[12px] text-muted">
        {plural(rows.length, "candidate")} at this step.
      </p>
    </section>
  );
}
