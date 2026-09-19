import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import Link from "next/link";
import { shortDate, stamp } from "@/lib/format";
import { today } from "@/lib/recompute";
import { getConfig } from "@/lib/config/store";
import { labelOf, salesTypeLabel, stageLabel } from "@/lib/lead-labels";
import { parkedLeads } from "@/lib/services/lead-hold-service";
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
} from "@/components/console/parts";
import { plural } from "@/components/console/words";
import { LeadTabs } from "@/components/leads/lead-tabs";


/**
 * THE PARKED BOOK — and it is a worklist rather than a report.
 *
 * On Hold is a PAUSE, not a quiet death. That sentence is the whole reason the
 * rung exists apart from `lost`, and until this screen it was a sentence the
 * product did not keep: a lead could be parked with a reason and a resume date,
 * and then nothing anywhere read either. The date was added precisely because
 * "back after Diwali" written into the reason is a sentence nobody is watching —
 * and a date nobody is watching is the identical failure in a column, with the
 * additional harm that a column LOOKS like the problem was solved.
 *
 * **THE ROW THAT MATTERS IS THE ONE WHOSE DAY HAS GONE.** It is sorted to the
 * top, it carries how many days late in words, and the count is a banner above
 * the table rather than a number somebody has to find by scrolling. Everything
 * else on the screen is context for that one question: is anybody going back to
 * these.
 *
 * **A park with NO resume date sorts above even that.** Those are the leads
 * parked before the date was demanded, and they are the worst case rather than
 * the mildest: not late by any amount somebody can read, and nothing on the
 * record that will ever make them due. Sorting them last — which "order by date
 * nulls last" would do — is how they stay parked for ever.
 *
 * **THE RUNG IT WAS PARKED FROM IS THE COLUMN NOBODY WOULD EXPECT TO BE HARD.**
 * A lead has one stage column and `on_hold` takes it, so a qualified lead that
 * is parked no longer records anywhere on its own row that it was ever at
 * Qualification — the only surviving statement of it is the `from_stage` of the
 * transition that parked it, which is what `lead-hold-service` reads. It is
 * printed because coming back is a move to a NAMED rung: a manager looking at
 * this list is deciding whether to reopen, and "reopen to what" is the first
 * thing they have to answer.
 *
 * A server component with no client state: there is nothing to DO from a row
 * here. Reopening a lead is a stage move made on the lead, with the gate asked,
 * which is a link rather than a button — the same shape the "nobody is working
 * these" screen beside it takes, and for the same reason.
 */
export async function Body({ workspace }: { workspace: LeadWorkspace }) {
  /* `today()` applies `workingDay.dayBoundaryHour` in Asia/Kolkata. Every
     "how late is this" on the screen is measured against it in SQL rather than
     in the browser, so a manager in another zone reads the same number. */
  const day = await today();
  /* The six, from configuration rather than from `HOLD_REASONS`: a deployment
     that has reworded one stores its own codes, and a screen resolving them
     against the literal would print the raw code beside every park made since
     somebody edited the list. */
  const [{ rows, total, due, undated }, config] = await Promise.all([
    parkedLeads(day),
    getConfig(),
  ]);
  const holdReasons = config["leads.holdReasons"];

  return (
    <div className="p-6">
      <LeadTabs
        workspace={workspace}
        counts={{ [leadHref(workspace, "leads/actions/parked")]: due }}
      />
      <ScreenHeader
        title="On hold"
        subtitle="Every lead somebody stopped, and the day they said it comes back. On hold is a pause and not a close — the shop is still live, somebody is going to look again, and this is the list that makes sure somebody does."
        actions={
          <Link
            href={leadHref(workspace, "leads")}
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ← All leads
          </Link>
        }
      />

      {due ? (
        <Banner
          tone="warn"
          title={`${plural(due, "parked lead")} due back now`}
          body="The day somebody named has come or gone. Open the lead and move it back onto its ladder, or park it again with a new date and a reason — what it must not do is sit here."
        />
      ) : null}

      {undated ? (
        <Banner
          tone="danger"
          title={`${plural(undated, "lead")} parked with no day at all`}
          body="Parked before a resume date was demanded, so nothing will ever make them due. These are not the mildest rows on this screen — they are the only ones that cannot come back on their own."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "On hold", value: String(total) },
          { label: "Due back", value: String(due), tone: due ? "warn" : "success" },
          {
            label: "No day named",
            value: String(undated),
            tone: undated ? "danger" : undefined,
          },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title="Nothing is parked"
          body="Which is a real answer rather than an empty screen: no lead in your book is waiting on a plant shutdown, a budget quarter or a buyer who is abroad. A lead that genuinely is stopped belongs here — parking it is the On hold control on its own stage history."
        />
      ) : (
        <Table
          minWidth={1280}
          head={
            <>
              <HeadCell width={230}>Lead</HeadCell>
              <HeadCell width={150}>Parked from</HeadCell>
              <HeadCell width={260}>Why it stopped</HeadCell>
              <HeadCell width={170}>Comes back</HeadCell>
              <HeadCell width={250}>What happens then</HeadCell>
              <HeadCell width={160}>Salesman</HeadCell>
            </>
          }
        >
          {rows.map((r, i) => (
            <Row key={r.customerId} striped={i % 2 === 1}>
              <Cell truncate={230}>
                <Link
                  href={leadHref(workspace, `leads/${r.customerId}`)}
                  className="no-underline"
                >
                  {r.name}
                </Link>
                <span className="block truncate text-[12px] text-muted">
                  {[r.companyName, r.city].filter(Boolean).join(" · ") || "—"}
                </span>
              </Cell>

              <Cell truncate={150}>
                {/*
                  Two different facts and they are drawn differently. A rung
                  means a reopen has a destination; no rung means the park was
                  recorded without one, and nothing on the record can say where
                  this lead goes back to — which is a thing a manager has to
                  decide rather than read.
                */}
                {r.parkedFrom ? (
                  <>
                    {stageLabel(r.parkedFrom)}
                    <span className="block truncate text-[12px] text-muted">
                      {salesTypeLabel(r.salesType)}
                    </span>
                  </>
                ) : (
                  <>
                    <Pill tone="warn">Not recorded</Pill>
                    <span className="block truncate text-[12px] text-muted">
                      no rung to reopen to
                    </span>
                  </>
                )}
              </Cell>

              <Cell truncate={260}>
                {/*
                  THE CODE AND THE SENTENCE, IN THAT ORDER, AND NEITHER STANDS
                  IN FOR THE OTHER. The code is which of the six — it is what
                  makes this list countable, which is the whole reason Mahek
                  asked for a controlled list. The sentence is what actually
                  happened, and it is what the person going back on the resume
                  date reads. A park made before the codes existed has only the
                  sentence and NOTHING backfills a code onto it: reading months
                  later which of six somebody meant is a guess, and a guess
                  stored in the column the counting question is asked of answers
                  that question wrongly rather than leaving it open. So a coded
                  park and a legacy one are drawn as the two different things
                  they are, and the row with neither says so.
                */}
                {r.holdReasonCode ? (
                  <span className="block truncate font-medium">
                    {labelOf(holdReasons, r.holdReasonCode)}
                  </span>
                ) : null}
                {r.holdReason ? (
                  <span className="block truncate">{r.holdReason}</span>
                ) : r.holdReasonCode ? null : (
                  <span className="text-warn-ink">Nobody said</span>
                )}
                <span className="block truncate text-[12px] text-muted">
                  {r.parkedAt ? stamp(r.parkedAt) : "date unknown"}
                  {r.parkedByName ? ` · ${r.parkedByName}` : " · nobody recorded"}
                </span>
              </Cell>

              <Cell truncate={170}>
                {r.resumeDate === null ? (
                  <Pill tone="danger">No day named</Pill>
                ) : r.overdueDays !== null ? (
                  <>
                    <Pill tone="warn">
                      {r.overdueDays === 0 ? "Due today" : `${plural(r.overdueDays, "day")} late`}
                    </Pill>
                    <span className="block truncate text-[12px] text-muted">
                      {shortDate(r.resumeDate)}
                    </span>
                  </>
                ) : (
                  <>
                    {shortDate(r.resumeDate)}
                    <span className="block truncate text-[12px] text-muted">
                      in {plural(r.dueInDays ?? 0, "day")}
                    </span>
                  </>
                )}
              </Cell>

              <Cell truncate={250}>
                {/*
                  §24 again, read back. A park is supposed to carry what happens
                  when it comes back and who does it — the action demands both —
                  so a row with neither is a lead parked before the rule, and it
                  comes back to nobody. It is said in words rather than left
                  blank, because a blank cell reads as missing data.
                */}
                {r.nextAction ? (
                  <>
                    <span className="block truncate">{r.nextAction}</span>
                    <span className="block truncate text-[12px] text-muted">
                      {r.nextActionOwnerName ?? "nobody named"}
                      {r.nextActionDate ? ` · ${shortDate(r.nextActionDate)}` : ""}
                    </span>
                  </>
                ) : (
                  <span className="text-warn-ink">Comes back to nobody</span>
                )}
              </Cell>

              <Cell truncate={160}>
                {r.salesmanId ? (
                  <Link
                    href={leadHref(workspace, `people/${r.salesmanId}`)}
                    className="no-underline"
                  >
                    {r.salesmanName}
                  </Link>
                ) : (
                  <span className="text-warn-ink">Nobody</span>
                )}
                <span className="block truncate text-[12px] text-muted">
                  {r.leadManagerName ?? "no lead manager"}
                </span>
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </div>
  );
}
