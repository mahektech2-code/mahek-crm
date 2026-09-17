"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import Link from "next/link";
import { stamp } from "@/lib/format";
import {
  OVERRIDE_REASONS,
  labelOf,
  salesTypeLabel,
  stageLabel,
  type CodedOption,
} from "@/lib/lead-labels";
import type { ConditionCount, OverrideRow } from "@/lib/services/lead-oversight-service";
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
  plural,
} from "@/components/console/parts";

/**
 * §28's escape hatch, read back — and it is NOT a shaming list.
 *
 * The override exists so the rule survives contact with a Tuesday. A system
 * that refuses everything is defeated in a week by people recording the work
 * after the event, and the record then says the process was followed when it
 * was not, which is worse than the gate being open. So a manager may pass a
 * shut gate, it demands a reason, and the gate stores exactly what was still
 * missing.
 *
 * **WHAT THE LOG IS FOR IS THE PATTERN, which is why the counts are above the
 * rows.** Twenty overrides spread across twenty conditions is twenty Tuesdays.
 * Twenty on ONE condition is not twenty people cutting corners — it is the
 * wrong condition, shut on everybody, and this is the only place in the
 * product that can tell you so. That is the payoff for storing a code rather
 * than a sentence somebody typed.
 *
 * **The counts come from the book, never from the rows on this page.** A
 * capped list counting itself reports the shape of the page instead of the
 * shape of the problem, which is precisely the mistake the customer timeline's
 * filter pills made before they learned to ask SQL.
 *
 * This screen writes nothing. There is no control on it that changes a lead.
 */
export function OverridesScreen({
  workspace,
  rows,
  counts,
  total,
  reasons,
  overrideAllowed,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  rows: OverrideRow[];
  /** Every condition anybody was let past, counted over the whole book. */
  counts: ConditionCount[];
  total: number;
  /**
   * The configured list. Codes are stored and labels are configuration, so the
   * words come down from the server rather than out of the engine's shipped
   * copy — a reworded reason stops resolving otherwise, which is the whole
   * reason a code is stored in the first place.
   */
  reasons: CodedOption[];
  /** `leads.allowManagerOverride`. Off, this log can only ever be history. */
  overrideAllowed: boolean;
}) {
  const [condition, setCondition] = React.useState<string | null>(null);
  const list = condition ? rows.filter((r) => r.conditions.includes(condition)) : rows;
  const vocabulary = reasons.length ? reasons : OVERRIDE_REASONS;

  const worst = counts[0] ?? null;
  const people = new Set(rows.map((r) => r.actorId).filter(Boolean)).size;

  return (
    <>
      <ScreenHeader
        title="Override log"
        subtitle="Every shut gate somebody passed, what the gate was still refusing on, and the reason they gave. Read it for the pattern rather than for the names: one condition shut on everybody, week after week, is the wrong condition — not twenty people cutting corners."
      />

      {!overrideAllowed ? (
        <Banner
          tone="info"
          title="Overrides are switched off."
          body={
            <>
              <code className="text-[12px]">leads.allowManagerOverride</code> is off, so nobody may
              pass a shut gate today. Anything below happened while it was on and is kept — a
              transition is append-only, and a row recorded wrongly is corrected by a further
              transition rather than by an edit.
            </>
          }
        />
      ) : null}

      <MetricRow
        metrics={[
          {
            label: "Gates passed",
            value: String(total),
            sub: "transitions carrying a missing condition",
            tone: total > 0 ? "warn" : undefined,
          },
          {
            label: "Most often waived",
            value: worst ? String(worst.count) : "—",
            sub: worst ? worst.says : "nothing waived yet",
            tone: worst && worst.count >= 5 ? "danger" : undefined,
          },
          {
            label: "Managers involved",
            value: String(people),
            sub: "on this page",
          },
        ]}
      />

      {counts.length > 0 ? (
        <div className="mb-4 rounded-[6px] border border-line bg-surface px-4 py-3">
          <div className="mb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            What was being waived
          </div>
          <div className="flex flex-wrap gap-1.5">
            {/* A chip that filters the rows beneath it. It is deliberately not
                a link with its own URL: the counts are the subject of this
                screen and the rows are the evidence for one of them, so
                narrowing to a condition is reading the same screen rather than
                arriving at a different one. */}
            <button
              type="button"
              onClick={() => setCondition(null)}
              className={
                condition === null
                  ? "rounded-[4px] border border-brand bg-brand-soft px-2.5 py-1 text-[12px] font-medium text-[#5223E0]"
                  : "rounded-[4px] border border-line bg-canvas px-2.5 py-1 text-[12px] text-body"
              }
            >
              All ({total})
            </button>
            {counts.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCondition(c.id === condition ? null : c.id)}
                title={c.says}
                className={
                  c.id === condition
                    ? "rounded-[4px] border border-brand bg-brand-soft px-2.5 py-1 text-[12px] font-medium text-[#5223E0]"
                    : "rounded-[4px] border border-line bg-canvas px-2.5 py-1 text-[12px] text-body"
                }
              >
                {c.says} <span className="tabular-nums text-muted">({c.count})</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-muted">
            Counted over the whole book, not over this page. A condition nobody can name any more
            shows as its stored id rather than being dropped — &ldquo;we let somebody past something we
            can no longer name&rdquo; is the worse answer.
          </p>
        </div>
      ) : null}

      {list.length === 0 ? (
        <Empty
          title={condition ? "Nothing on this page waived that one" : "No gate has been passed"}
          body={
            condition
              ? "The count above is taken over the whole book; this page is the most recent slice of it, and none of these rows named that condition."
              : "Every lead that moved forward met what its rung asked for. That is the gates doing their job, not an empty screen."
          }
        />
      ) : (
        <Table
          minWidth={1120}
          head={
            <>
              <HeadCell width={140}>When</HeadCell>
              <HeadCell width={210}>Lead</HeadCell>
              <HeadCell width={190}>Move</HeadCell>
              <HeadCell width={280}>Still missing</HeadCell>
              <HeadCell width={200}>Reason</HeadCell>
              <HeadCell width={180}>Who, and under which hat</HeadCell>
            </>
          }
        >
          {list.map((r, i) => (
            <Row key={r.id} striped={i % 2 === 1}>
              <Cell>{stamp(r.at)}</Cell>
              <Cell truncate={200}>
                <Link href={leadHref(workspace, `leads/${r.customerId}`)} className="font-medium text-ink">
                  {r.customerName}
                </Link>
                <div className="text-[12px] text-muted">
                  {r.city ?? "no city"}
                  {r.salesType ? ` · ${salesTypeLabel(r.salesType)}` : ""}
                </div>
              </Cell>
              <Cell>
                <span className="text-muted">
                  {r.fromStage ? stageLabel(r.fromStage) : "raised"}
                </span>{" "}
                → <span className="font-medium text-ink">{stageLabel(r.toStage)}</span>
              </Cell>
              <Cell>
                <div className="flex flex-wrap gap-1">
                  {r.conditions.map((id) => (
                    <Pill key={id} tone="warn">
                      {counts.find((c) => c.id === id)?.says ?? id}
                    </Pill>
                  ))}
                </div>
              </Cell>
              <Cell truncate={190}>
                {/* The code is stored; the words are configuration. An unknown
                    code prints as itself rather than as a blank — a reason
                    somebody chose and nobody can read is still evidence that
                    they chose one. */}
                <div>{labelOf(vocabulary, r.reasonCode)}</div>
                {r.note ? <div className="text-[12px] text-muted">{r.note}</div> : null}
              </Cell>
              <Cell truncate={170}>
                <div>{r.actorName ?? <span className="text-muted">not recorded</span>}</div>
                <div className="text-[12px] text-muted">
                  {r.actorRole || r.actorApp ? (
                    <>
                      {r.actorRole ?? "role not recorded"}
                      {r.actorApp ? ` · ${r.actorApp}` : " · app not recorded"}
                    </>
                  ) : (
                    "hat not recorded"
                  )}
                </div>
              </Cell>
            </Row>
          ))}
        </Table>
      )}

      {rows.length > 0 && total > rows.length ? (
        <p className="mt-2 text-[12px] text-muted">
          Showing the {plural(rows.length, "most recent move", "most recent moves")} of {total}.
        </p>
      ) : null}
    </>
  );
}
