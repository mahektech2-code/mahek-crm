"use client";

import * as React from "react";
import Link from "next/link";
import { money, shortDate, stamp } from "@/lib/format";
import type { SalesmanRecord } from "@/lib/services/sales-service";
import {
  Cell,
  Empty,
  HeadCell,
  LEAVE_LABEL,
  Pill,
  Row,
  ScreenHeader,
  Table,
  VISIT_OUTCOME_LABEL,
  label,
  plural,
} from "../../parts";

/**
 * Everything MBOS has recorded for one person.
 *
 * Nine lists behind one set of tabs rather than nine screens, because the
 * question a manager actually asks is about the PERSON — "what has Mahesh been
 * doing" — and answering it across nine navigations is how nobody ever asks it.
 *
 * The money columns say what they are. An order here was captured in the field
 * and waits on accounts; a receipt is what the salesman says he collected. Both
 * are shown with their status beside them rather than as a total, because a
 * total invites reading them as banked.
 */
const TABS = [
  "Visits",
  "Orders",
  "Money",
  "Attendance",
  "Leave",
  "Expenses",
  "Samples",
  "Leads",
  "Tasks",
] as const;

type Tab = (typeof TABS)[number];

export function SalesmanScreen({ record }: { record: SalesmanRecord }) {
  const [tab, setTab] = React.useState<Tab>("Visits");
  const { salesman: s } = record;

  const counts: Record<Tab, number> = {
    Visits: record.visits.length,
    Orders: record.orders.length,
    Money: record.receipts.length,
    Attendance: record.attendance.length,
    Leave: record.leave.length,
    Expenses: record.expenses.length,
    Samples: record.samples.length,
    Leads: record.leads.length,
    Tasks: record.tasks.length,
  };

  return (
    <div className="p-6">
      <ScreenHeader
        title={s.name}
        subtitle={
          <>
            {s.email}
            {s.phone ? ` · ${s.phone}` : ""} · {plural(s.customerCount, "shop")} in the book
            {s.active ? "" : " · account closed"}
            {" · "}
            {s.deviceBoundAt
              ? s.lastSeenAt
                ? `handset last synced ${stamp(s.lastSeenAt)}`
                : "handset bound, never synced"
              : "has never signed in on a handset"}
          </>
        }
        actions={
          <Link
            href={`/sales/journeys?salesman=${s.id}`}
            className="inline-flex h-8.5 items-center rounded-[4px] border border-line bg-surface px-3 text-sm font-medium text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Plan a route
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              tab === t
                ? "-mb-px cursor-pointer border-b-2 border-brand px-3 py-2 text-sm font-medium text-[#5223E0]"
                : "-mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:text-body"
            }
          >
            {t}
            <span className="ml-1.5 text-[11px] tabular-nums opacity-70">{counts[t]}</span>
          </button>
        ))}
      </div>

      {tab === "Visits" ? (
        record.visits.length === 0 ? (
          <Empty title="No visits" body="Nothing has been logged from this handset yet." />
        ) : (
          <Table
            minWidth={980}
            head={
              <>
                <HeadCell width={160}>When</HeadCell>
                <HeadCell width={220}>Shop</HeadCell>
                <HeadCell width={150}>Outcome</HeadCell>
                <HeadCell width={110}>Duration</HeadCell>
                <HeadCell>What was said</HeadCell>
                <HeadCell width={140}>Verified</HeadCell>
              </>
            }
          >
            {record.visits.map((v, i) => (
              <Row key={v.id} striped={i % 2 === 1}>
                <Cell>{v.checkInAt ? stamp(v.checkInAt) : <span className="text-muted">—</span>}</Cell>
                <Cell truncate={220}>{v.customerName}</Cell>
                <Cell>{label(VISIT_OUTCOME_LABEL, v.outcome)}</Cell>
                <Cell>
                  {v.durationSeconds != null ? (
                    `${Math.round(v.durationSeconds / 60)} min`
                  ) : (
                    <span className="text-muted" title="The visit never closed — the salesman walked out of signal or did not check out.">
                      open
                    </span>
                  )}
                </Cell>
                <Cell truncate={420} title={v.notes ?? v.transcript ?? undefined}>
                  {v.notes || v.transcript || <span className="text-muted">Nothing written</span>}
                </Cell>
                <Cell>
                  {v.verified ? (
                    <Pill tone="success">Verified</Pill>
                  ) : (
                    <span title={v.unverifiedReason ?? "Saved unverified, with a reason."}>
                      <Pill tone="warn">{v.locationMismatch ? "Wrong place" : "Unverified"}</Pill>
                    </span>
                  )}
                </Cell>
              </Row>
            ))}
          </Table>
        )
      ) : null}

      {tab === "Orders" ? (
        record.orders.length === 0 ? (
          <Empty title="No orders" body="Nothing has been taken on this handset yet." />
        ) : (
          <Table
            minWidth={860}
            head={
              <>
                <HeadCell width={160}>When</HeadCell>
                <HeadCell width={170}>Number</HeadCell>
                <HeadCell>Shop</HeadCell>
                <HeadCell align="right" width={160}>Value</HeadCell>
                <HeadCell width={180}>Status</HeadCell>
              </>
            }
          >
            {record.orders.map((o, i) => (
              <Row key={o.id} striped={i % 2 === 1}>
                <Cell>{shortDate(o.orderedAt)}</Cell>
                <Cell>{o.orderNo ?? <span className="text-muted">Not yet numbered</span>}</Cell>
                <Cell truncate={320}>{o.customerName}</Cell>
                <Cell align="right">{money(o.totalAmountPaise)}</Cell>
                <Cell>
                  <Pill
                    tone={
                      o.status === "approved" || o.status === "dispatched"
                        ? "success"
                        : o.status === "declined" || o.status === "cancelled"
                          ? "danger"
                          : "warn"
                    }
                  >
                    {o.status.replace(/_/g, " ")}
                  </Pill>
                </Cell>
              </Row>
            ))}
          </Table>
        )
      ) : null}

      {tab === "Money" ? (
        record.receipts.length === 0 ? (
          <Empty title="Nothing collected" body="No receipt has been recorded on this handset." />
        ) : (
          <>
            <Table
              minWidth={980}
              head={
                <>
                  <HeadCell width={140}>Received</HeadCell>
                  <HeadCell width={170}>Receipt</HeadCell>
                  <HeadCell>Shop</HeadCell>
                  <HeadCell align="right" width={150}>Amount</HeadCell>
                  <HeadCell width={130}>Mode</HeadCell>
                  <HeadCell width={170}>Where it stands</HeadCell>
                </>
              }
            >
              {record.receipts.map((r, i) => (
                <Row key={r.id} striped={i % 2 === 1}>
                  <Cell>{shortDate(r.receivedAt)}</Cell>
                  <Cell>{r.receiptNo ?? <span className="text-muted">Not yet numbered</span>}</Cell>
                  <Cell truncate={300}>{r.customerName}</Cell>
                  <Cell align="right">{money(r.amountPaise)}</Cell>
                  <Cell>{r.mode}</Cell>
                  <Cell>
                    <Pill
                      tone={
                        r.status === "confirmed"
                          ? "success"
                          : r.status === "rejected" || r.status === "reversed"
                            ? "danger"
                            : "warn"
                      }
                    >
                      {r.status}
                    </Pill>
                    {r.depositedAt ? (
                      <span className="ml-1.5" title={`Banked ${stamp(r.depositedAt)}`}>
                        <Pill tone="brand">Deposited</Pill>
                      </span>
                    ) : null}
                  </Cell>
                </Row>
              ))}
            </Table>
            <p className="mt-3 max-w-[760px] text-[13px] text-pretty text-muted">
              A receipt is what the salesman says he collected. It counts against a bill only when
              accounts confirm it against the bank — until then nothing here has moved an
              outstanding balance. Deposited means he has told us he paid the cash in, which is his
              half of the answer and not the confirmation.
            </p>
          </>
        )
      ) : null}

      {tab === "Attendance" ? (
        record.attendance.length === 0 ? (
          <Empty
            title="No days recorded"
            body="Attendance is a check-in on the handset. Nothing has been marked yet."
          />
        ) : (
          <Table
            minWidth={780}
            head={
              <>
                <HeadCell width={160}>Day</HeadCell>
                <HeadCell width={140}>In</HeadCell>
                <HeadCell width={140}>Out</HeadCell>
                <HeadCell width={150}>Verdict</HeadCell>
                <HeadCell>Notes</HeadCell>
              </>
            }
          >
            {record.attendance.map((a, i) => (
              <Row key={a.day} striped={i % 2 === 1}>
                <Cell>{shortDate(a.day)}</Cell>
                <Cell>{a.checkInAt ? stamp(a.checkInAt) : <span className="text-muted">—</span>}</Cell>
                <Cell>
                  {a.checkOutAt ? stamp(a.checkOutAt) : <span className="text-muted">Never closed</span>}
                </Cell>
                <Cell>
                  <Pill
                    tone={
                      a.status === "present"
                        ? "success"
                        : a.status === "absent"
                          ? "danger"
                          : "warn"
                    }
                  >
                    {a.status.replace(/_/g, " ")}
                  </Pill>
                </Cell>
                <Cell>
                  {a.withinGeofence === false ? (
                    <span
                      className="mr-1.5"
                      title="Checked in outside the permitted radius. Flagged, never blocked."
                    >
                      <Pill tone="warn">Off site</Pill>
                    </span>
                  ) : null}
                  {a.regularisationRequested ? <Pill tone="brand">Correction asked for</Pill> : null}
                </Cell>
              </Row>
            ))}
          </Table>
        )
      ) : null}

      {tab === "Leave" ? (
        record.leave.length === 0 ? (
          <Empty title="No leave asked for" body="Nothing has been requested from this handset." />
        ) : (
          <Table
            minWidth={820}
            head={
              <>
                <HeadCell width={150}>Kind</HeadCell>
                <HeadCell width={220}>When</HeadCell>
                <HeadCell align="right" width={90}>Days</HeadCell>
                <HeadCell>Why</HeadCell>
                <HeadCell width={150}>Where it stands</HeadCell>
              </>
            }
          >
            {record.leave.map((l, i) => (
              <Row key={l.id} striped={i % 2 === 1}>
                <Cell>{label(LEAVE_LABEL, l.leaveType)}</Cell>
                <Cell>
                  {shortDate(l.fromDate)}
                  {l.toDate !== l.fromDate ? ` – ${shortDate(l.toDate)}` : ""}
                  {l.halfDay ? " (half day)" : ""}
                </Cell>
                <Cell align="right">{l.days}</Cell>
                <Cell truncate={340}>{l.reason ?? <span className="text-muted">—</span>}</Cell>
                <Cell>
                  {l.cancelledAt ? (
                    <Pill>Withdrawn</Pill>
                  ) : l.state === "approved" ? (
                    <Pill tone="success">Approved</Pill>
                  ) : l.state === "rejected" ? (
                    <Pill tone="danger">Refused</Pill>
                  ) : (
                    <Pill tone="warn">Waiting</Pill>
                  )}
                </Cell>
              </Row>
            ))}
          </Table>
        )
      ) : null}

      {tab === "Expenses" ? (
        record.expenses.length === 0 ? (
          <Empty title="No claims" body="Nothing has been claimed from this handset." />
        ) : (
          <Table
            minWidth={820}
            head={
              <>
                <HeadCell width={150}>Spent on</HeadCell>
                <HeadCell width={150}>Category</HeadCell>
                <HeadCell align="right" width={150}>Amount</HeadCell>
                <HeadCell>Remarks</HeadCell>
                <HeadCell width={150}>Where it stands</HeadCell>
              </>
            }
          >
            {record.expenses.map((e, i) => (
              <Row key={e.id} striped={i % 2 === 1}>
                <Cell>{shortDate(e.expenseDate)}</Cell>
                <Cell className="capitalize">{e.category}</Cell>
                <Cell align="right">{money(e.amountPaise)}</Cell>
                <Cell truncate={340}>{e.remarks ?? <span className="text-muted">—</span>}</Cell>
                <Cell>
                  {e.state === "approved" ? (
                    <Pill tone="success">Approved</Pill>
                  ) : e.state === "rejected" ? (
                    <Pill tone="danger">Refused</Pill>
                  ) : e.state === "partially_approved" ? (
                    <Pill tone="warn">Part</Pill>
                  ) : (
                    <Pill tone="warn">Waiting</Pill>
                  )}
                </Cell>
              </Row>
            ))}
          </Table>
        )
      ) : null}

      {tab === "Samples" ? (
        record.samples.length === 0 ? (
          <Empty title="No samples" body="Nothing has been asked for from this handset." />
        ) : (
          <Table
            minWidth={860}
            head={
              <>
                <HeadCell width={150}>Asked for</HeadCell>
                <HeadCell>Shop</HeadCell>
                <HeadCell>Product</HeadCell>
                <HeadCell align="right" width={90}>Cans</HeadCell>
                <HeadCell width={150}>Follow up</HeadCell>
                <HeadCell width={140}>Stands</HeadCell>
              </>
            }
          >
            {record.samples.map((sm, i) => (
              <Row key={sm.id} striped={i % 2 === 1}>
                <Cell>{sm.requestedDate ? shortDate(sm.requestedDate) : "—"}</Cell>
                <Cell truncate={240}>{sm.customerName}</Cell>
                <Cell truncate={240}>
                  {sm.productName ?? <span className="text-muted">Not named</span>}
                </Cell>
                <Cell align="right">{sm.quantityCans ?? "—"}</Cell>
                <Cell>
                  {sm.followUpDate ? (
                    shortDate(sm.followUpDate)
                  ) : (
                    <span className="text-muted">None set</span>
                  )}
                </Cell>
                <Cell>
                  {sm.state === "approved" ? (
                    <Pill tone="success">Approved</Pill>
                  ) : sm.state === "rejected" ? (
                    <Pill tone="danger">Refused</Pill>
                  ) : (
                    <Pill tone="warn">Waiting</Pill>
                  )}
                </Cell>
              </Row>
            ))}
          </Table>
        )
      ) : null}

      {tab === "Leads" ? (
        record.leads.length === 0 ? (
          <Empty
            title="No leads"
            body="A lead is a shop that is not on the book yet. Nothing has been raised from this handset."
          />
        ) : (
          <Table
            minWidth={900}
            head={
              <>
                <HeadCell width={220}>Who</HeadCell>
                <HeadCell width={220}>Company</HeadCell>
                <HeadCell width={160}>Number</HeadCell>
                <HeadCell width={140}>Stage</HeadCell>
                <HeadCell width={150}>Next follow-up</HeadCell>
                <HeadCell width={150}>Last worked</HeadCell>
              </>
            }
          >
            {record.leads.map((l, i) => (
              <Row key={l.id} striped={i % 2 === 1}>
                <Cell truncate={220}>{l.name}</Cell>
                <Cell truncate={220}>
                  {l.companyName ?? <span className="text-muted">—</span>}
                </Cell>
                <Cell>{l.mobile}</Cell>
                <Cell>
                  <Pill tone={l.stage === "won" ? "success" : l.stage === "lost" ? "danger" : "brand"}>
                    {l.stage}
                  </Pill>
                </Cell>
                <Cell>
                  {l.nextFollowUpDate ? (
                    shortDate(l.nextFollowUpDate)
                  ) : (
                    <span className="text-muted">None promised</span>
                  )}
                </Cell>
                <Cell>
                  {l.lastActivityDate ? (
                    shortDate(l.lastActivityDate)
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Cell>
              </Row>
            ))}
          </Table>
        )
      ) : null}

      {tab === "Tasks" ? (
        record.tasks.length === 0 ? (
          <Empty title="Nothing open" body="No task is waiting on this person." />
        ) : (
          <Table
            minWidth={820}
            head={
              <>
                <HeadCell>What</HeadCell>
                <HeadCell width={220}>Shop</HeadCell>
                <HeadCell width={130}>Priority</HeadCell>
                <HeadCell width={150}>Due</HeadCell>
                <HeadCell width={140}>Status</HeadCell>
              </>
            }
          >
            {record.tasks.map((t, i) => (
              <Row key={t.id} striped={i % 2 === 1}>
                <Cell truncate={380}>{t.title}</Cell>
                <Cell truncate={220}>
                  {t.customerName ?? <span className="text-muted">—</span>}
                </Cell>
                <Cell>
                  <Pill tone={t.priority === "high" ? "danger" : "neutral"}>{t.priority}</Pill>
                </Cell>
                <Cell>
                  {t.dueDate ? shortDate(t.dueDate) : <span className="text-muted">No date</span>}
                </Cell>
                <Cell className="capitalize">{t.status.replace(/_/g, " ")}</Cell>
              </Row>
            ))}
          </Table>
        )
      ) : null}
    </div>
  );
}
