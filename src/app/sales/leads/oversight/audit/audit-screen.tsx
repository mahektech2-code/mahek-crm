import Link from "next/link";
import { stamp } from "@/lib/format";
import type { AuditCursor, LeadAuditRow } from "@/lib/services/lead-oversight-service";
import {
  Banner,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "../../../parts";

/* ---------------------------------------------------------------------------
 * The funnel's own audit trail.
 *
 * Deliberately NOT a client component. There is no state on this screen and no
 * control that changes anything — paging is a link, because a keyset page
 * deserves its own URL: a manager who has read back to March should be able to
 * send that to somebody. Reading it as a server component also keeps the clock
 * out of render, which the React Compiler rules require anyway.
 * ------------------------------------------------------------------------- */

/**
 * THE HAT, IN TWO COLUMNS, AND NEITHER IS OPTIONAL.
 *
 * With one role per person, "was he allowed to do this" was answerable from
 * the person. With roles as LEVELS it is not: `associate` says neither "clerk"
 * nor "seniority", so the level alone cannot tell the person at the ledger
 * desk from the person on the phones — the APP is what does that. Both are
 * written by `requireCapability`, and both are drawn here.
 *
 * **Null means NOT RECORDED, never "no role".** Every row that predates the
 * column, and anything written outside a capability check. A write with no hat
 * behind it is not a state this product produces, so rendering the absence as
 * an answer — "no role", "none", a dash in a column of roles — would be
 * inventing one. It says what it is.
 */
function Hat({ role, app }: { role: string | null; app: string | null }) {
  if (!role && !app) {
    return <span className="text-[12px] text-muted italic">hat not recorded</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {role ? (
        <Pill tone="neutral">{role}</Pill>
      ) : (
        <span className="text-[12px] text-muted italic">level not recorded</span>
      )}
      {app ? (
        <Pill tone="brand">{app}</Pill>
      ) : (
        <span className="text-[12px] text-muted italic">app not recorded</span>
      )}
    </div>
  );
}

function pageHref(cursor: AuditCursor | null): string {
  if (!cursor) return "/sales/leads/oversight/audit";
  const q = new URLSearchParams({ at: cursor.at, id: cursor.id });
  return `/sales/leads/oversight/audit?${q.toString()}`;
}

export function AuditScreen({
  rows,
  total,
  nextCursor,
  onFirstPage,
}: {
  rows: LeadAuditRow[];
  /** From SQL. A page that counted itself would say 50 on a book of 4,000. */
  total: number;
  nextCursor: AuditCursor | null;
  onFirstPage: boolean;
}) {
  const unrecorded = rows.filter((r) => !r.actorRole && !r.actorApp).length;

  return (
    <>
      <ScreenHeader
        title="Lead audit trail"
        subtitle="Every audited write the funnel makes — the ladder, the samples, the appointments and the handover — with the hat that authorised each one. Read-only by construction: there is no edit path onto this table and there is not meant to be one."
      />

      <MetricRow
        metrics={[
          { label: "Audited actions", value: String(total), sub: "in what you can see" },
          { label: "On this page", value: String(rows.length), sub: "newest first" },
          {
            label: "Hat not recorded",
            value: String(unrecorded),
            sub: unrecorded ? "written before the columns, or outside a check" : "every row named one",
          },
        ]}
      />

      {unrecorded > 0 ? (
        <Banner
          tone="info"
          title="Some rows name no hat, and that is not the same as naming none."
          body="A null actor role or app means NOT RECORDED — the row predates the column, or it was written outside a capability check. It is drawn as that rather than as a role, because a blank in a column of roles reads as a fact about the person who acted."
        />
      ) : null}

      {rows.length === 0 ? (
        <Empty
          title={onFirstPage ? "Nothing has been done to the funnel yet" : "You have reached the end"}
          body={
            onFirstPage
              ? "No lead has moved, no sample has been decided and no appointment has been signed off inside what you can see. Every one of those writes an audit row as it happens, so this fills itself."
              : "There are no older rows past this point."
          }
          action={
            onFirstPage ? undefined : (
              <Link href={pageHref(null)} className="text-[13px] font-medium text-[#5223E0]">
                Back to the newest
              </Link>
            )
          }
        />
      ) : (
        <Table
          minWidth={1080}
          head={
            <>
              <HeadCell width={150}>When</HeadCell>
              <HeadCell width={200}>Action</HeadCell>
              <HeadCell width={220}>Account</HeadCell>
              <HeadCell width={160}>Who</HeadCell>
              <HeadCell width={200}>Under which hat</HeadCell>
              <HeadCell width={150}>Record</HeadCell>
            </>
          }
        >
          {rows.map((r, i) => (
            <Row key={r.id} striped={i % 2 === 1}>
              <Cell>{stamp(r.at)}</Cell>
              <Cell truncate={190}>
                <span className="font-medium text-ink">{r.action}</span>
              </Cell>
              <Cell truncate={210}>
                {r.subjectCustomerId && r.subject ? (
                  <Link href={`/sales/leads/${r.subjectCustomerId}`} className="text-ink">
                    {r.subject}
                  </Link>
                ) : (
                  /* Not every audited write in the funnel names an account a
                     person would recognise — a distributor's own salesman is a
                     row on its own table. Said rather than guessed at. */
                  <span className="text-[12px] text-muted italic">
                    no account behind this row
                  </span>
                )}
              </Cell>
              <Cell truncate={150}>
                {r.actorName ?? <span className="text-[12px] text-muted italic">not recorded</span>}
              </Cell>
              <Cell>
                <Hat role={r.actorRole} app={r.actorApp} />
              </Cell>
              <Cell truncate={140}>
                <div className="text-[12px] text-muted">{r.entityType}</div>
                <div className="text-[12px] text-muted">{r.entityId ?? "—"}</div>
              </Cell>
            </Row>
          ))}
        </Table>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[12px] text-muted">
          {/* The sort is `(at, id) desc` and the cursor is the pair. Without
              the tiebreaker, rows sharing a second are ordered by whatever the
              planner feels like — invisible until it is paged, and then it is
              a row on two pages while another is on none. */}
          Paged newest first on the instant and the id together. Going back is the browser&rsquo;s back
          button: a keyset walks one way.
        </p>
        <div className="flex flex-none gap-2">
          {!onFirstPage ? (
            <Link
              href={pageHref(null)}
              className="rounded-[4px] border border-line bg-surface px-3 py-1.5 text-[13px] text-body no-underline"
            >
              Newest
            </Link>
          ) : null}
          {nextCursor ? (
            <Link
              href={pageHref(nextCursor)}
              className="rounded-[4px] border border-line bg-surface px-3 py-1.5 text-[13px] text-body no-underline"
            >
              Older
            </Link>
          ) : null}
        </div>
      </div>
    </>
  );
}
