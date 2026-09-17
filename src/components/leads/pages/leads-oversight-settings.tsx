import { type LeadWorkspace } from "@/lib/lead-workspace";
import type { ReactNode } from "react";
import Link from "next/link";
import { stamp } from "@/lib/format";
import { leadThresholds, type ThresholdRow } from "@/lib/services/lead-oversight-service";
import { LeadTabs } from "@/components/leads/lead-tabs";
import { Banner, Cell, HeadCell, Pill, Row, ScreenHeader, Table } from "@/components/console/parts";


/* ---------------------------------------------------------------------------
 * The thresholds this workspace runs on, READ-ONLY.
 *
 * **A SECOND DOOR ONTO CONFIGURATION IS HOW TWO SCREENS COME TO DISAGREE ABOUT
 * A THRESHOLD**, and the sentence is on the page rather than only here. The
 * Admin Console is where a setting is authored: it validates against the
 * registry's own bounds, it runs `checkConsistency` over the whole set before
 * it saves, and it writes an audit row with the before and the after. A second
 * form doing three quarters of that is not a convenience, it is a way to store
 * a value the first door would have refused — and nothing on either screen
 * would say which of them was right.
 *
 * So there is no edit control anywhere on this page. What it is FOR is the
 * other question: somebody looking at a lead that will not move, or a salesman
 * asking why his phone demanded a decision on the third visit, needs to read
 * the number in force. Sending them to the console to find that out means
 * sending somebody who may not hold the console to the one place they cannot
 * go.
 *
 * Every value is `getConfig()`'s, through `listSettings`. Nothing here carries
 * a default typed into the screen — a number in this file would be a fourth
 * copy of a threshold, and the copy in the prose is always the one that stops
 * being true.
 * ------------------------------------------------------------------------- */

/**
 * A stored value in words, without inventing any.
 *
 * Four shapes reach this: a number, a boolean, a list of numbers, and a list
 * of coded options. Anything else is printed as what it is and counted rather
 * than flattened into a sentence — `mbos.leads.validationScript` is a document
 * somebody wrote, and a table cell is not where it should be read.
 */
function valueWords(row: ThresholdRow): ReactNode {
  const v = row.value;

  if (typeof v === "boolean") {
    return <Pill tone={v ? "success" : "neutral"}>{v ? "On" : "Off"}</Pill>;
  }
  if (typeof v === "number") {
    return <span className="font-medium tabular-nums text-ink">{v}</span>;
  }
  if (typeof v === "string") {
    return <span className="text-ink">{v}</span>;
  }
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === "number")) {
      return <span className="font-medium tabular-nums text-ink">{v.join(", ")}</span>;
    }
    const coded = v.filter(
      (x): x is { code: string; label: string } =>
        !!x && typeof x === "object" && "code" in x && "label" in x,
    );
    if (coded.length === v.length) {
      return (
        <div className="flex flex-wrap gap-1">
          {coded.map((o) => (
            <Pill key={o.code} tone="neutral">
              {o.label}
            </Pill>
          ))}
        </div>
      );
    }
    return <span className="text-muted">{v.length} entries</span>;
  }
  if (v && typeof v === "object") {
    return (
      <span className="text-muted">
        a structured value of {Object.keys(v as object).length} parts — read it in the console
      </span>
    );
  }
  return <span className="text-muted italic">not set</span>;
}

function ThresholdTable({ rows, minWidth }: { rows: ThresholdRow[]; minWidth: number }) {
  return (
    <Table
      minWidth={minWidth}
      head={
        <>
          <HeadCell width={300}>Setting</HeadCell>
          <HeadCell width={240}>In force</HeadCell>
          <HeadCell width={220}>Key</HeadCell>
          <HeadCell width={200}>Last changed</HeadCell>
        </>
      }
    >
      {rows.map((r, i) => (
        <Row key={r.key} striped={i % 2 === 1}>
          <Cell>
            <div className="font-medium text-ink">{r.label}</div>
            <p className="mt-0.5 max-w-[420px] text-[12px] text-pretty text-muted">
              {r.description}
            </p>
          </Cell>
          <Cell>{valueWords(r)}</Cell>
          <Cell truncate={210}>
            <code className="text-[12px] text-muted">{r.key}</code>
            {r.isDefault ? (
              <div className="mt-0.5 text-[12px] text-muted">
                still the shipped default — nobody has chosen this
              </div>
            ) : null}
          </Cell>
          <Cell truncate={190}>
            {/*
              WHERE NOTHING RECORDS AN AUTHOR, NOTHING IS SAID. `app_settings`
              keeps `updated_by_id`, and a seeded row carries none — printing
              the row's own timestamp beside a value nobody chose would read as
              somebody having decided it.
            */}
            {r.changedAt ? (
              <>
                <div>{stamp(r.changedAt)}</div>
                {r.changedByName ? (
                  <div className="text-[12px] text-muted">by {r.changedByName}</div>
                ) : (
                  <div className="text-[12px] text-muted italic">author not recorded</div>
                )}
              </>
            ) : (
              <span className="text-[12px] text-muted">—</span>
            )}
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

export async function Body({
  workspace,
}: {
  workspace: LeadWorkspace;
}) {
  const { office, handset } = await leadThresholds();

  return (
    <>
      <LeadTabs workspace={workspace} />

      <ScreenHeader
        title="Lead thresholds"
        subtitle="Every number and switch the funnel runs on, as it stands right now. Read-only on purpose: configuration is authored in the Admin Console, and a second door onto it is how two screens come to disagree about a threshold."
      />

      <Banner
        tone="info"
        title="This page cannot change anything, and that is deliberate."
        body={
          <>
            The Admin Console validates a value against the registry&rsquo;s own bounds, runs the
            consistency check over the whole set before it saves, and writes an audit row with the
            before and the after. A second form here would do three quarters of that, which is a way
            to store a value the real door would have refused — with nothing on either screen saying
            which was right. Change one there and it is in force here on the next read.
            <span className="block mt-1">
              <Link href="/admin/crm" className="font-medium text-[#5223E0]">
                Admin Console → CRM schema
              </Link>
            </span>
          </>
        }
      />

      <section className="mb-6">
        <h2 className="mb-1 text-[15px] font-semibold text-ink">Read at a desk</h2>
        <p className="mb-2.5 max-w-[760px] text-[13px] text-pretty text-muted">
          The eleven <code className="text-[12px]">leads.*</code> keys. These are what the gate
          engine, the nurture sequence and the appointment chain read on the server — a lead that
          will not move is refused by one of them.
        </p>
        <ThresholdTable rows={office} minWidth={1000} />
      </section>

      <section>
        <h2 className="mb-1 text-[15px] font-semibold text-ink">Read on a handset</h2>
        <p className="mb-2.5 max-w-[760px] text-[13px] text-pretty text-muted">
          The six <code className="text-[12px]">mbos.leads.*</code> keys. They ride down on every
          pull with the rest of the <code className="text-[12px]">mbos.*</code> settings, so a
          change made here reaches a phone on its next sync rather than on its next release — which
          is the whole reason the validation script is configuration and not a string in an APK
          nobody can recall.
        </p>
        <ThresholdTable rows={handset} minWidth={1000} />
      </section>

      <p className="mt-4 text-[12px] text-muted">
        Listed by key prefix rather than from a list typed here, so a twelfth{" "}
        <code className="text-[12px]">leads.*</code> key appears on this page the day it is added to
        the registry. A list in this file would be the thing nobody remembers to update.
      </p>
    </>
  );
}
