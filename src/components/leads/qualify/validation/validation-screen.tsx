"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import Link from "next/link";
import { money, shortDate, stamp } from "@/lib/format";
import {
  questionsInSection,
  salesTypeLabel,
  stageLabel,
  VERIFICATION_QUESTIONS,
  VERIFICATION_SECTIONS,
} from "@/lib/lead-labels";
import type {
  ValidationCallRow,
  ValidationDisagreement,
} from "@/lib/services/lead-qualify-service";
import {
  Banner,
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

type Script = { sections: { heading: string; lines: string[] }[] };

/**
 * §8's calls, and what they disagreed with.
 *
 * **THE DISAGREEMENT IS THE POINT OF THE SCREEN.** What the salesman was told
 * standing in the shop and what the office was told on the phone are two
 * readings of one fact, kept in two columns precisely so they can differ — and
 * the two differing is the single most useful thing this call produces, because
 * it is how anybody finds out the report and the shop did not match. So it is
 * not buried inside an expanded row: a row that contradicts itself says so on
 * the line, and opening it shows which answer and both sides of it.
 *
 * **A silence is not a contradiction.** Where one side never answered, the
 * comparison says so in words rather than drawing a difference. A question
 * nobody asked and two answers that differ are different facts about a call,
 * and rendering them alike would put an accusation on a row where nothing
 * happened.
 *
 * **Nothing here writes.** There is no edit, no verdict change and no delete,
 * because a validation record is append-only by nature: a second call is a
 * second row, and correcting the first would destroy the disagreement this
 * screen exists to show.
 */
export function ValidationScreen({
  workspace,
  rows,
  total,
  withDisagreement,
  windowKey,
  show,
  script,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  rows: ValidationCallRow[];
  /** From SQL — a capped list still says what it is a slice of. */
  total: number;
  withDisagreement: number;
  windowKey: string;
  show: "all" | "disagreements" | "undecided";
  script: Script;
}) {
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const [scriptOpen, setScriptOpen] = React.useState(false);

  const base = leadHref(workspace, "leads/qualify/validation");
  const win = (s: string) => `${base}?window=${windowKey}${s}`;

  const undecided = rows.filter((r) => r.verified === null);
  const shown =
    show === "disagreements"
      ? rows.filter((r) => r.disagreements.some((d) => d.differs))
      : show === "undecided"
        ? undecided
        : rows;

  const notReached = rows.filter((r) => !r.reached).length;

  return (
    <>
      <ScreenHeader
        title="Validation calls"
        subtitle="Every §8 call that was made, its twelve answers and its verdict — and, on the line, where the shop said something other than what the salesman wrote down. That disagreement is what the call is for."
        actions={
          <Link
            href={leadHref(workspace, "leads/qualify/verification")}
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Calls still to make →
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] text-muted">Window</span>
        {[
          { key: "30", label: "30 days" },
          { key: "90", label: "90 days" },
          { key: "365", label: "A year" },
          { key: "all", label: "Everything" },
        ].map((o) => (
          <a
            key={o.key}
            href={`${base}?window=${o.key}${show === "all" ? "" : `&show=${show}`}`}
            className={
              o.key === windowKey
                ? "inline-flex h-8 items-center rounded-[4px] border border-brand bg-brand-soft px-3 text-[13px] font-medium text-[#5223E0] no-underline hover:no-underline"
                : "inline-flex h-8 items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
            }
          >
            {o.label}
          </a>
        ))}
      </div>

      <FilterChips
        current={show}
        options={[
          { key: "all", label: "Every call", href: win(""), count: rows.length },
          {
            key: "disagreements",
            label: "The shop said otherwise",
            href: win("&show=disagreements"),
            count: withDisagreement,
          },
          {
            key: "undecided",
            label: "No verdict yet",
            href: win("&show=undecided"),
            count: undecided.length,
          },
        ]}
      />

      {withDisagreement ? (
        <Banner
          tone="warn"
          title={`${plural(withDisagreement, "call")} where the shop said something else`}
          body="One of these is a misheard answer. A pattern of them on one salesman's leads is what this screen exists to make visible, and it is not visible one record at a time."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Calls recorded", value: String(total) },
          {
            label: "Disagreed",
            value: String(withDisagreement),
            tone: withDisagreement ? "warn" : undefined,
          },
          {
            label: "No verdict",
            value: String(undecided.length),
            sub: "somebody rang and nobody decided",
          },
          { label: "Nobody answered", value: String(notReached) },
        ]}
      />

      <div className="mb-4 rounded-[6px] border border-line bg-surface">
        <button
          type="button"
          onClick={() => setScriptOpen((v) => !v)}
          className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-left"
        >
          <span className="text-sm font-medium text-ink">What the caller reads out</span>
          <span className="text-[12px] text-muted">
            {scriptOpen ? "Hide" : "Show"} the script · Admin Console → Settings
          </span>
        </button>
        {scriptOpen ? (
          <div className="border-t border-divider px-4 py-3">
            <p className="mb-2 text-[12px] text-muted">
              Configuration, not code. It is CONTENT — it will be argued about, improved after a
              bad call and eventually translated, and none of that should need a deploy or an APK
              nobody can recall.
            </p>
            {script.sections.length === 0 ? (
              <p className="text-[13px] text-body">
                No script is configured. The call still happens and the twelve answers are still
                recorded — what is missing is the wording, which lives in
                <span className="font-medium"> mbos.leads.validationScript</span>.
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {script.sections.map((s) => (
                  <div key={s.heading}>
                    <div className="text-[13px] font-medium text-ink">{s.heading}</div>
                    <ul className="mt-1 list-disc pl-5 text-[13px] text-body">
                      {s.lines.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <Empty
          title={
            show === "disagreements"
              ? "Nothing the shop contradicted"
              : show === "undecided"
                ? "Every call has a verdict"
                : "No validation calls recorded in this window"
          }
          body={
            show === "all"
              ? "A call lands here the moment a manager records one against a prospect. An empty window means none were made in it — not that none were needed; the Verification queue is where what is owed is counted."
              : "A good answer, and worth being able to see. Widen the window if you are looking for an older one."
          }
        />
      ) : (
        <>
          {rows.length < total ? (
            <p className="mb-2 text-[12px] text-muted">
              Showing the newest {rows.length} of {total} in this window.
            </p>
          ) : null}
          <Table
            minWidth={1260}
            head={
              <>
                <HeadCell width={230}>Prospect</HeadCell>
                <HeadCell width={170}>Called</HeadCell>
                <HeadCell width={160}>By</HeadCell>
                <HeadCell width={150}>Verdict</HeadCell>
                <HeadCell width={120}>Answers</HeadCell>
                <HeadCell width={290}>Against what the salesman wrote</HeadCell>
                <HeadCell align="right" width={120} />
              </>
            }
          >
            {shown.flatMap((r, i) => {
              const differing = r.disagreements.filter((d) => d.differs);
              const expanded = open[r.id] === true;
              const striped = i % 2 === 1;
              const body = [
                <Row key={r.id} striped={striped}>
                  <Cell truncate={230}>
                    <Link href={leadHref(workspace, `leads/${r.customerId}`)} className="no-underline">
                      {r.customerName}
                    </Link>
                    <span className="block truncate text-[12px] text-muted">
                      {[r.companyName, r.city].filter(Boolean).join(" · ") || "—"} ·{" "}
                      {stageLabel(r.stage)}
                    </span>
                  </Cell>
                  <Cell>
                    {shortDate(r.calledAt)}
                    <span className="block text-[12px] text-muted">
                      {r.attempts > 1 ? `call ${r.attempt} of ${r.attempts}` : "first call"}
                      {r.reached ? "" : " · nobody answered"}
                    </span>
                  </Cell>
                  <Cell truncate={160}>
                    {r.callerName ?? "—"}
                    <span className="block truncate text-[12px] text-muted">
                      salesman: {r.salesmanName ?? "nobody"}
                    </span>
                  </Cell>
                  <Cell>
                    <Verdict row={r} />
                  </Cell>
                  <Cell>
                    <span className="tabular-nums">{r.answered}</span>
                    <span className="text-muted"> / {VERIFICATION_QUESTIONS.length}</span>
                    <span className="block text-[12px] text-muted">
                      {salesTypeLabel(r.salesType)}
                    </span>
                  </Cell>
                  <Cell truncate={290}>
                    {differing.length ? (
                      <>
                        <span className="mr-1.5">
                          <Pill tone="warn">{plural(differing.length, "disagreement")}</Pill>
                        </span>
                        <span className="text-[12px] text-muted">
                          {differing.map((d) => d.label).join(", ")}
                        </span>
                      </>
                    ) : (
                      <span className="text-[12px] text-muted">
                        {r.disagreements.some((d) => d.comparable)
                          ? "matches what the salesman wrote"
                          : "nothing on both sides to compare"}
                      </span>
                    )}
                  </Cell>
                  <Cell align="right">
                    <button
                      type="button"
                      onClick={() => setOpen((o) => ({ ...o, [r.id]: !expanded }))}
                      className="cursor-pointer rounded-[4px] border border-line bg-surface px-3 py-1 text-[13px] text-body hover:bg-canvas"
                    >
                      {expanded ? "Close" : "The call"}
                    </button>
                  </Cell>
                </Row>,
              ];

              if (expanded) {
                body.push(
                  /* A plain `td` rather than a `Cell`: every cell in this table
                     clips and holds one line, which is right for a row and
                     wrong for a panel of sentences underneath it. The leads
                     list does the same for its own detail panel. */
                  <tr key={`${r.id}-open`} className={striped ? "bg-canvas" : "bg-surface"}>
                    <td colSpan={7} className="border-b border-divider px-4 pb-4">
                      <CallDetail row={r} />
                    </td>
                  </tr>,
                );
              }
              return body;
            })}
          </Table>
        </>
      )}
    </>
  );
}

/**
 * The verdict, with `pending` kept apart from a negative one.
 *
 * `verificationVerdict` answers NULL for `pending` and `on_hold` on purpose: a
 * call left undecided is a real state — somebody rang, wrote down what they
 * were told, and the judgement is another person's — and drawing it as "could
 * not verify" would put a follow-up's sentence on a row where nobody has
 * decided anything.
 */
function Verdict({ row }: { row: ValidationCallRow }) {
  if (row.verified === true) return <Pill tone="success">Verified</Pill>;
  if (row.verified === false) return <Pill tone="danger">Not qualified</Pill>;
  return (
    <>
      <Pill tone="neutral">Undecided</Pill>
      <span className="block text-[12px] text-muted">{row.verdictRaw}</span>
    </>
  );
}

/**
 * Every answer and the comparison, in the order the call asked them, UNDER THE
 * SECTION EACH QUESTION BELONGS TO.
 *
 * This cut the list with `slice(0, 2)` and `slice(2)` — the first two are
 * about the salesman, the rest about the sale — and that was already wrong
 * before anything was added to it: "How did you find our man?" is the third
 * salesman question and sits at index seven, so it had been drawn under "About
 * the opportunity" since the day it landed. §5.2 then took the list to
 * seventeen in four sections, and a slice put the five new ones — the two
 * objections and all three readiness questions — under a heading that was
 * about neither, with the two headings this screen knows about silently
 * covering four.
 *
 * A section is a PROPERTY of the question and never a position in the array:
 * the order is what the conversation takes and the heading is what the
 * question is about, and those move independently. `VERIFICATION_SECTIONS` and
 * `questionsInSection` are the shape, read here exactly as the form that
 * writes these reads them — the headings are in `lead-labels.ts` for the
 * reason every list in that file is, that two screens draw them and the half
 * that drifts is the half somebody reads.
 *
 * A section with nothing answered is still DRAWN, because `Answer` already
 * draws an unanswered question as unanswered rather than leaving it out: a
 * call where the shop had plenty to say about price and nothing about credit
 * is the ordinary case, and a panel that dropped the empty half would read as
 * a shorter call than the one that happened.
 */
function CallDetail({ row }: { row: ValidationCallRow }) {
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <div>
        {VERIFICATION_SECTIONS.map((s) => (
          <Section key={s.id} title={s.title} says={s.says}>
            {questionsInSection(s.id).map((q) => (
              <Answer key={q.id} ask={q.ask} said={row.answers[q.id]} />
            ))}
          </Section>
        ))}
        {row.verdictReason || row.notes ? (
          <div className="mt-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5">
            <div className="text-[12px] text-muted">What the caller added</div>
            <div className="text-[13px] whitespace-pre-wrap text-body">
              {row.verdictReason ?? row.notes}
            </div>
          </div>
        ) : null}
        <p className="mt-2 text-[12px] text-muted">
          Recorded {stamp(row.calledAt)} by {row.callerName ?? "somebody whose account has gone"}.
          Nothing on this screen can change it: a transition recorded wrongly is corrected by a
          further call, never by an edit.
        </p>
      </div>

      <div>
        <div className="mb-1.5 text-[13px] font-semibold text-ink">
          The shop against the report
        </div>
        <p className="mb-2 text-[12px] text-pretty text-muted">
          The left column is what the salesman wrote down standing in the shop; the right is what
          the shop told the office on the phone. They are two columns so they can differ.
        </p>
        <div className="rounded-[6px] border border-line bg-surface">
          {row.disagreements.map((d) => (
            <Compare key={d.field} d={d} />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Money is paise all the way here and formatted only on the way to the screen,
 * which is why the service hands both sides across as the stored integer: two
 * renderings of one figure can disagree about rounding, and a comparison that
 * differed only in its formatting would be a disagreement this screen invented.
 */
function shownAs(field: string, value: string | null): string | null {
  if (value === null) return null;
  if (field === "potential_paise") {
    const paise = Number(value);
    return Number.isFinite(paise) ? money(paise) : value;
  }
  if (field === "monthly_litres") return `${value} L`;
  return value;
}

function Compare({ d }: { d: ValidationDisagreement }) {
  const reported = shownAs(d.field, d.reported);
  const confirmed = shownAs(d.field, d.confirmed);
  return (
    <div className="border-b border-divider px-3 py-2 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-ink">{d.label}</span>
        {d.differs ? (
          <Pill tone="warn">Differs</Pill>
        ) : d.comparable ? (
          <span className="text-[12px] text-muted">agrees</span>
        ) : (
          <span className="text-[12px] text-muted">nothing to compare</span>
        )}
      </div>
      <div className="mt-1 grid grid-cols-2 gap-2 text-[13px]">
        <div>
          <div className="text-[11px] tracking-[0.04em] text-muted uppercase">Salesman</div>
          <div className={reported ? "text-body" : "text-muted"}>
            {reported ?? "never recorded"}
          </div>
        </div>
        <div>
          <div className="text-[11px] tracking-[0.04em] text-muted uppercase">Shop, on the call</div>
          <div className={confirmed ? (d.differs ? "text-warn-ink" : "text-body") : "text-muted"}>
            {confirmed ?? "not asked"}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One section, with the sentence that says why it is asked at all.
 *
 * `says` is carried rather than dropped because two of the four headings mean
 * nothing on their own: "What they are ready for" reads as a fourth batch of
 * questions until somebody knows §5.4 decides whether a sample goes out on the
 * answer. It is the same sentence the form that writes these puts above the
 * same questions, from the same constant, so the manager reading a call back
 * is reading what the caller was reading.
 */
function Section({
  title,
  says,
  children,
}: {
  title: string;
  says?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1 text-[11px] tracking-[0.04em] text-muted uppercase">{title}</div>
      {says ? <p className="mt-0 mb-1 max-w-[560px] text-[12px] text-pretty text-muted">{says}</p> : null}
      <div className="rounded-[6px] border border-line bg-surface">{children}</div>
    </div>
  );
}

/**
 * One question and what was said.
 *
 * An unanswered question is drawn as unanswered rather than left out. A shop
 * with plenty to say about dispatch and nothing about quality is the ordinary
 * case, and a list that silently dropped the empty ones would read as a shorter
 * call than the one that happened.
 */
function Answer({ ask, said }: { ask: string; said?: string }) {
  return (
    <div className="flex gap-3 border-b border-divider px-3 py-2 last:border-b-0">
      <div className="w-[230px] flex-none text-[13px] text-muted">{ask}</div>
      <div className={said ? "text-[13px] text-body" : "text-[13px] text-muted italic"}>
        {said ?? "not answered"}
      </div>
    </div>
  );
}
