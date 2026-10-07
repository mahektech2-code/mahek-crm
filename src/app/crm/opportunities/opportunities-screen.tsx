"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  MetricStrip,
  PageHeader,
  Textarea,
  type Tone,
} from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { Tabs } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { setOpportunityStatusAction } from "@/lib/actions/crm";
import { CALLER_ROLE_LABEL, CALL_REASON_LABEL } from "@/lib/call-reasons";
import { money, shortDate } from "@/lib/format";
import type { OpportunityRow as Row } from "@/lib/services/opportunity-service";

/**
 * WHAT A CALL TURNED UP, as a list somebody works.
 *
 * It used to be a line on the customer's timeline. This is the same record —
 * `call_opportunities`, with the call it came out of one click away — given an
 * owner, a status and somewhere to say what came of it. It is not the lead
 * desk: where the account is a lead it is already there, and an opportunity
 * here names what a particular call turned up on any account, new or old.
 */

type Tab = "working" | "overdue" | "won" | "lost" | "all";

const STATUS_LABEL: Record<Row["status"], string> = {
  open: "Open",
  in_progress: "Being worked",
  won: "Won",
  lost: "Lost",
};
const STATUS_TONE: Record<Row["status"], Tone> = {
  open: "brand",
  in_progress: "warn",
  won: "success",
  lost: "neutral",
};

export function OpportunitiesScreen({
  scopeLabel,
  isTeamView,
  userId,
  rows,
}: {
  scopeLabel: string;
  isTeamView: boolean;
  userId: string;
  rows: Row[];
}) {
  const router = useRouter();
  const { run } = useToast();
  const [tab, setTab] = React.useState<Tab>("working");
  const [closing, setClosing] = React.useState<{ row: Row; status: "won" | "lost" } | null>(null);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const buckets = React.useMemo(() => {
    const working = rows.filter((r) => r.status === "open" || r.status === "in_progress");
    return {
      working,
      overdue: working.filter((r) => r.overdue),
      won: rows.filter((r) => r.status === "won"),
      lost: rows.filter((r) => r.status === "lost"),
      all: rows,
    };
  }, [rows]);

  const openValue = buckets.working.reduce((s, r) => s + (r.estimatedValuePaise ?? 0), 0);
  const visible = buckets[tab];

  async function move(row: Row, status: Row["status"], noteText?: string) {
    setBusy(true);
    try {
      const res = await run(setOpportunityStatusAction({ id: row.id, status, note: noteText }));
      if (res.ok) {
        setClosing(null);
        setNote("");
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Opportunities"
        subtitle={`${scopeLabel} — what customers' calls turned up that somebody may buy.`}
      />
      <MetricStrip
        metrics={[
          { label: "Being worked", value: String(buckets.working.length) },
          {
            label: "Past their expected day",
            value: String(buckets.overdue.length),
            tone: buckets.overdue.length ? "danger" : "ink",
          },
          /* Only what somebody ESTIMATED. A figure nobody put a number on is
             left out of the sum, and the sentence says so rather than
             presenting a total that looks complete. */
          {
            label: "Estimated value open",
            value: money(openValue),
            sub: "only where a figure was given",
          },
          { label: "Won", value: String(buckets.won.length) },
        ]}
      />
      <Card>
        <Tabs
          tabs={[
            { key: "working" as Tab, label: "Being worked", count: buckets.working.length },
            { key: "overdue" as Tab, label: "Past due", count: buckets.overdue.length },
            { key: "won" as Tab, label: "Won", count: buckets.won.length },
            { key: "lost" as Tab, label: "Lost", count: buckets.lost.length },
            { key: "all" as Tab, label: "All", count: buckets.all.length },
          ]}
          value={tab}
          onChange={setTab}
        />
        {visible.length ? (
          <ul className="divide-y divide-divider">
            {visible.map((r) => {
              const mine = r.assignedUserId === userId;
              return (
                <li key={r.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/crm/customers/${r.customerId}`}
                      className="text-[15px] font-semibold text-ink hover:text-brand"
                    >
                      {r.customerName}
                    </Link>
                    <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                    {r.overdue ? <Badge tone="danger">Past its expected day</Badge> : null}
                  </div>
                  <div className="mt-1 text-sm text-ink">
                    {[
                      r.product,
                      r.estimatedQuantity,
                      r.estimatedValuePaise != null ? money(r.estimatedValuePaise) : null,
                      r.expectedOrderDate ? `expected ${shortDate(r.expectedOrderDate)}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  <div className="mt-0.5 text-[13px] text-muted">
                    {r.callReason ? `They rang about ${CALL_REASON_LABEL[r.callReason] ?? r.callReason}` : "From a call"}
                    {r.callerRole
                      ? ` · ${CALLER_ROLE_LABEL[r.callerRole] ?? r.callerRole}${r.callerName ? ` (${r.callerName})` : ""}`
                      : ""}
                    {` · logged by ${r.loggedByName} on ${shortDate(r.createdAt)}`}
                    {isTeamView || !mine ? ` · for ${r.assignedUserName}` : ""}
                  </div>
                  {r.workedNote ? (
                    <div className="mt-1 text-[13px] text-body">“{r.workedNote}”</div>
                  ) : null}
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    {r.status === "open" ? (
                      <Button size="sm" disabled={busy} onClick={() => move(r, "in_progress")}>
                        Start working it
                      </Button>
                    ) : null}
                    {r.status === "open" || r.status === "in_progress" ? (
                      <>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busy}
                          onClick={() => setClosing({ row: r, status: "won" })}
                        >
                          Won
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => setClosing({ row: r, status: "lost" })}
                        >
                          Lost
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" disabled={busy} onClick={() => move(r, "open")}>
                        Reopen
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            title="Nothing here"
            body="An opportunity appears when somebody answers Yes to “Did this call turn up a sales opportunity?” on a call."
          />
        )}
      </Card>

      <Modal
        open={closing !== null}
        onClose={() => {
          setClosing(null);
          setNote("");
        }}
        title={closing?.status === "won" ? "Mark as won" : "Mark as lost"}
        footer={
          <>
            <Button onClick={() => setClosing(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={busy || (closing?.status === "lost" && !note.trim())}
              onClick={() => closing && move(closing.row, closing.status, note)}
            >
              Save
            </Button>
          </>
        }
      >
        {closing ? (
          <Field
            label={closing.status === "lost" ? "Why was it lost?" : "What came of it? (optional)"}
            hint={
              closing.status === "won"
                ? `${closing.row.customerName} — this is you saying it turned into business; nothing here is worked out from their orders.`
                : `${closing.row.customerName} — what the next call to them needs to know.`
            }
          >
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
          </Field>
        ) : null}
      </Modal>
    </div>
  );
}
