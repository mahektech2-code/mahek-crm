import Link from "next/link";
import { notFound } from "next/navigation";
import { shortDate, stamp } from "@/lib/format";
import { today } from "@/lib/recompute";
import { taskCampaign, type CampaignTaskRow } from "@/lib/services/task-campaign-service";
import {
  expandTaskForm,
  isTaskFieldAnswered,
  summariseTaskField,
  TASK_FIELD_TYPE_LABELS,
  taskAnswerProblems,
  taskAnswerText,
  visibleTaskFields,
  type LocationAnswer,
  type TaskAnswer,
  type TaskField,
} from "@/lib/task-form";
import {
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
import { CustomerName } from "@/components/console/customer-name";
import { plural } from "@/components/console/words";
import { CampaignActions } from "./campaign-actions";
import { CampaignBrain } from "./campaign-brain";
import { taskAiAvailable } from "@/lib/services/task-ai-service";

export const metadata = { title: "Task answers — Sales Dashboard — MahekOne" };

/**
 * EVERYTHING THE FIELD SAID, about one thing the office asked.
 *
 * Three cuts of the same rows. ANSWERS is one row per task — per salesman,
 * per shop — with one column per question, so twenty salesmen's replies read
 * across like a spreadsheet and a photo is a click away. BY SALESMAN is who
 * has done how much of it. SUMMARY is each question added up: how many said
 * yes, which option won, the average of a number.
 *
 * A blank cell says WHICH blank it is. A question the form never showed this
 * salesman (its condition did not hold) is "not asked"; one it showed and he
 * left empty is "—"; one it needed and a closed task lacks — which only an
 * older app can produce — is "missing", in red. Three different facts, and a
 * column of identical dashes would hide the one that matters.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{ view?: string; status?: string; salesman?: string }>;
}) {
  const [{ campaignId }, sp] = await Promise.all([params, searchParams]);
  const day = await today();
  const [c, aiAvailable] = await Promise.all([taskCampaign(campaignId, day), taskAiAvailable()]);
  if (!c) notFound();

  const view = ["answers", "people", "summary"].includes(sp.view ?? "") ? sp.view! : "answers";
  const status = ["all", "done", "open"].includes(sp.status ?? "") ? sp.status! : "all";
  const salesman = sp.salesman && c.tasks.some((t) => t.salesmanId === sp.salesman) ? sp.salesman : null;

  const live = c.tasks.filter((t) => t.status !== "cancelled");
  const done = live.filter((t) => t.status === "done");
  const open = live.filter((t) => t.status !== "done");
  const overdue = open.filter((t) => t.overdueDays > 0);
  const fromRecord = done.filter((t) => t.completedVia === "record").length;
  const people = new Map<string, { name: string; rows: CampaignTaskRow[] }>();
  for (const t of c.tasks) {
    const p = people.get(t.salesmanId) ?? { name: t.salesmanName, rows: [] };
    p.rows.push(t);
    people.set(t.salesmanId, p);
  }

  const shown = c.tasks.filter(
    (t) =>
      (!salesman || t.salesmanId === salesman) &&
      (status === "all" || (status === "done" ? t.status === "done" : t.status !== "done" && t.status !== "cancelled")),
  );
  const questions = c.form.filter((f) => f.type !== "info");

  const q = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams();
    const merged = { view, status, salesman, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v && !(k === "status" && v === "all") && !(k === "view" && v === "answers")) next.set(k, v);
    const s = next.toString();
    return `/sales/tasks/${c.id}${s ? `?${s}` : ""}`;
  };

  return (
    <div className="p-6">
      <Link href="/sales/tasks" className="mb-2 inline-block text-[13px] text-muted no-underline hover:underline">
        ← Tasks
      </Link>
      <ScreenHeader
        title={c.title}
        subtitle={[
          c.audienceSentence,
          c.dueDate ? `Due ${shortDate(c.dueDate)}` : null,
          c.createdBy ? `Set by ${c.createdBy}, ${stamp(c.createdAt)}` : null,
          c.closedAt ? `Withdrawn ${stamp(c.closedAt)}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={<CampaignActions campaignId={c.id} open={open.length} />}
      />
      {c.description ? (
        <p className="mb-4 max-w-[80ch] text-[13px] whitespace-pre-line text-body">{c.description}</p>
      ) : null}

      <CampaignBrain
        campaignId={c.id}
        aiAvailable={aiAvailable}
        answered={done.length}
        summary={c.aiSummary}
        summaryAt={c.aiSummaryAt ? stamp(c.aiSummaryAt) : null}
        brief={c.aiBrief}
        linked={c.form.filter((f) => f.link).map((f) => f.label)}
        skippedComplete={c.skippedComplete}
      />

      <MetricRow
        metrics={[
          { label: "Assigned", value: String(live.length), sub: plural(people.size, "salesman", "salesmen") },
          {
            label: "Answered",
            value: String(done.length),
            sub: live.length ? `${Math.round((done.length / live.length) * 100)}%` : undefined,
            tone: live.length && done.length === live.length ? "success" : undefined,
          },
          ...(fromRecord
            ? [{ label: "From the record", value: String(fromRecord), sub: "completed themselves", tone: "success" as const }]
            : []),
          { label: "Waiting", value: String(open.length) },
          { label: "Overdue", value: String(overdue.length), tone: overdue.length ? "danger" : undefined },
        ]}
      />

      <FilterChips
        current={view}
        options={[
          { key: "answers", href: q({ view: "answers" }), label: "Answers", count: shown.length },
          { key: "people", href: q({ view: "people" }), label: "By salesman", count: people.size },
          { key: "summary", href: q({ view: "summary" }), label: "Summary", count: questions.length },
        ]}
      />

      {view === "answers" ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[13px]">
            {(["all", "done", "open"] as const).map((s) => (
              <Link
                key={s}
                href={q({ status: s })}
                className={`rounded-[4px] border px-2.5 py-1 no-underline ${status === s ? "border-brand bg-brand-soft text-[#5223E0]" : "border-line text-body"}`}
              >
                {s === "all" ? "Everything" : s === "done" ? "Answered" : "Waiting"}
              </Link>
            ))}
            {salesman ? (
              <Link href={q({ salesman: null })} className="ml-2 rounded-full bg-canvas px-2.5 py-1 text-body no-underline">
                {`${people.get(salesman)?.name ?? "Salesman"} ✕`}
              </Link>
            ) : null}
          </div>
          {shown.length === 0 ? (
            <Empty title="Nothing here" body="No task in this assignment matches what is picked above." />
          ) : (
            <Answers form={c.form} rows={shown} />
          )}
        </>
      ) : null}

      {view === "people" ? (
        <Table
          minWidth={760}
          head={
            <>
              <HeadCell>Salesman</HeadCell>
              <HeadCell width={110} align="right">Assigned</HeadCell>
              <HeadCell width={110} align="right">Answered</HeadCell>
              <HeadCell width={110} align="right">Waiting</HeadCell>
              <HeadCell width={110} align="right">Overdue</HeadCell>
              <HeadCell width={170}>Last answer</HeadCell>
            </>
          }
        >
          {[...people.entries()]
            .sort((a, b) => a[1].name.localeCompare(b[1].name))
            .map(([id, p], i) => {
              const l = p.rows.filter((t) => t.status !== "cancelled");
              const d = l.filter((t) => t.status === "done");
              const w = l.filter((t) => t.status !== "done");
              const late = w.filter((t) => t.overdueDays > 0).length;
              const times = d.filter((t) => t.completedAt).map((t) => new Date(t.completedAt!).getTime());
              const last = times.length ? new Date(Math.max(...times)) : null;
              return (
                <Row key={id} striped={i % 2 === 1}>
                  <Cell>
                    <Link href={q({ view: "answers", salesman: id })} className="font-medium text-ink no-underline hover:underline">
                      {p.name}
                    </Link>
                  </Cell>
                  <Cell align="right">{l.length}</Cell>
                  <Cell align="right">{d.length}</Cell>
                  <Cell align="right">{w.length}</Cell>
                  <Cell align="right">{late ? <span className="text-danger">{late}</span> : 0}</Cell>
                  <Cell>{last ? stamp(last) : <span className="text-muted">Nothing yet</span>}</Cell>
                </Row>
              );
            })}
        </Table>
      ) : null}

      {view === "summary" ? (
        questions.length === 0 ? (
          <Empty title="No questions were asked" body="This task was done with a note. The notes are on the Answers tab." />
        ) : (
          <Summary form={c.form} rows={done} asked={live.length} />
        )
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- answers */

function Answers({ form, rows }: { form: TaskField[]; rows: CampaignTaskRow[] }) {
  const questions = form.filter((f) => f.type !== "info");
  const width = 520 + questions.reduce((n, f) => n + colWidth(f), 0) + 260;
  return (
    <Table
      minWidth={width}
      head={
        <>
          <HeadCell width={170}>Salesman</HeadCell>
          <HeadCell width={210}>Shop</HeadCell>
          <HeadCell width={140}>State</HeadCell>
          {questions.map((f) => (
            <HeadCell key={f.id} width={colWidth(f)}>
              <span title={`${TASK_FIELD_TYPE_LABELS[f.type].label}${f.required ? " · needed" : ""}`}>{f.label}</span>
            </HeadCell>
          ))}
          <HeadCell width={260}>Note</HeadCell>
        </>
      }
    >
      {rows.map((t, i) => {
        const answers = t.responses ?? {};
        /* The form as this shop's salesman saw it — a question about every
           contact is one question per person — so each base column can show
           every person's answer, and the record's verdict on each. */
        const expanded = expandTaskForm(form, t.context).fields;
        const showing = new Set(visibleTaskFields(expanded, answers).map((f) => f.id));
        const missing = new Set(
          t.status === "done" && t.completedVia !== "record"
            ? taskAnswerProblems(expanded, answers).map((p) => p.fieldId)
            : [],
        );
        const partsOf = (base: TaskField) =>
          expanded.filter((e) => e.id === base.id || e.id.startsWith(`${base.id}@`));
        return (
          <Row key={t.id} striped={i % 2 === 1}>
            <Cell truncate={170}>{t.salesmanName}</Cell>
            <Cell truncate={210}>
              {t.customerId ? (
                <>
                  <CustomerName id={t.customerId} name={t.customerName} muted={<span className="text-muted">—</span>} />
                  {t.place ? <span className="block truncate text-[12px] text-muted">{t.place}</span> : null}
                </>
              ) : (
                <span className="text-muted">No shop</span>
              )}
            </Cell>
            <Cell>
              <StatePill t={t} />
              {t.completedAt ? <span className="block text-[12px] text-muted">{stamp(t.completedAt)}</span> : null}
              {t.status !== "done" && t.snoozedTo ? (
                <span className="block text-[12px] text-muted" title={t.snoozeReason ?? undefined}>
                  {`Moved to ${shortDate(t.snoozedTo)}`}
                </span>
              ) : null}
            </Cell>
            {questions.map((f) => {
              const parts = partsOf(f);
              const asked = parts.filter((p) => showing.has(p.id));
              return (
                <Cell key={f.id} truncate={colWidth(f)}>
                  {t.status !== "done" ? (
                    <span className="text-muted">—</span>
                  ) : !asked.length ? (
                    <span className="text-faint" title="The form did not ask this, because of an earlier answer.">
                      not asked
                    </span>
                  ) : (
                    asked.map((p) => (
                      <span key={p.id} className="block">
                        {asked.length > 1 ? <span className="text-[11px] text-muted">{p.label.split(" — ").pop()}: </span> : null}
                        {missing.has(p.id) && !isTaskFieldAnswered(p, answers[p.id]) ? (
                          <span className="text-danger" title="Needed, and not in what came back — usually an older app.">
                            missing
                          </span>
                        ) : (
                          <AnswerCell field={f} value={answers[p.id]} />
                        )}
                        {f.link ? <RecordMark result={t.linkResults?.[p.id]} viaRecord={t.completedVia === "record"} /> : null}
                      </span>
                    ))
                  )}
                </Cell>
              );
            })}
            <Cell truncate={260} title={t.completionNote ?? undefined}>
              {t.completionNote && !questions.length ? t.completionNote : extraNote(t.completionNote, form, answers)}
            </Cell>
          </Row>
        );
      })}
    </Table>
  );
}

/** What he wrote beyond the answers — the note is the answers plus his line. */
function extraNote(note: string | null, form: TaskField[], answers: Record<string, TaskAnswer>): React.ReactNode {
  if (!note) return <span className="text-muted">—</span>;
  const answerLines = new Set(
    visibleTaskFields(form, answers)
      .filter((f) => f.type !== "info")
      .map((f) => `${f.label}: ${taskAnswerText(f, answers[f.id])}`),
  );
  const own = note
    .split("\n")
    .filter((l) => !answerLines.has(l))
    .join(" ")
    .trim();
  return own || <span className="text-muted">—</span>;
}

function colWidth(f: TaskField): number {
  if (f.type === "photo") return 200;
  if (f.type === "long_text") return 260;
  if (f.type === "yes_no" || f.type === "rating" || f.type === "birthday") return 120;
  return 170;
}

function StatePill({ t }: { t: CampaignTaskRow }) {
  if (t.status === "done" && t.completedVia === "record") return <Pill tone="success">From record</Pill>;
  if (t.status === "done") return <Pill tone="success">Answered</Pill>;
  if (t.status === "cancelled") return <Pill tone="neutral">Withdrawn</Pill>;
  if (t.overdueDays > 0) return <Pill tone="danger">{`${plural(t.overdueDays, "day")} late`}</Pill>;
  return <Pill tone="warn">Waiting</Pill>;
}

function AnswerCell({ field, value }: { field: TaskField; value: TaskAnswer | undefined }) {
  if (value === undefined || !isTaskFieldAnswered(field, value)) return <span className="text-muted">—</span>;
  if (field.type === "photo" && Array.isArray(value)) {
    return (
      <span className="flex gap-1">
        {value.slice(0, 4).map((id) => (
          <a key={id} href={`/api/attachments/${id}`} target="_blank" rel="noreferrer" title="Open the photo">
            {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated attachment, not a static asset */}
            <img src={`/api/attachments/${id}`} alt="" className="h-9 w-9 rounded-[3px] border border-line object-cover" loading="lazy" />
          </a>
        ))}
        {value.length > 4 ? <span className="self-center text-[12px] text-muted">+{value.length - 4}</span> : null}
      </span>
    );
  }
  if (field.type === "location") {
    const l = value as LocationAnswer;
    return (
      <a href={`https://www.google.com/maps?q=${l.lat},${l.lng}`} target="_blank" rel="noreferrer">
        {taskAnswerText(field, value)}
      </a>
    );
  }
  if (field.type === "phone") return <a href={`tel:${value}`}>{String(value)}</a>;
  if (field.type === "yes_no") return <Pill tone={value ? "success" : "neutral"}>{value ? "Yes" : "No"}</Pill>;
  const text = taskAnswerText(field, value);
  return <span title={text}>{text}</span>;
}

/* ----------------------------------------------------------------- summary */

function Summary({ form, rows, asked }: { form: TaskField[]; rows: CampaignTaskRow[]; asked: number }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
      {form
        .filter((f) => f.type !== "info")
        .map((f, i) => {
          /* Every person's answer counts — a question about every contact
             was asked once per contact. */
          const partsOf = (t: CampaignTaskRow) => {
            const answers = t.responses ?? {};
            const shown = visibleTaskFields(expandTaskForm(form, t.context).fields, answers);
            return shown.filter((x) => x.id === f.id || x.id.startsWith(`${f.id}@`)).map((x) => answers[x.id]);
          };
          const perRow = rows.map(partsOf);
          const showing = rows.filter((_, k) => perRow[k].length > 0);
          const s = summariseTaskField(f, perRow.flat());
          return (
            <div key={f.id} className="rounded-[6px] border border-line bg-surface p-4">
              <p className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                {`${i + 1} · ${TASK_FIELD_TYPE_LABELS[f.type].label}`}
              </p>
              <p className="mb-2 text-[14px] font-medium text-ink">{f.label}</p>
              <p className="mb-2 text-[12px] text-muted">
                {`${s.answered} answered of ${showing.length} asked`}
                {asked > rows.length ? ` · ${asked - rows.length} still waiting` : ""}
              </p>
              {s.kind === "counts" ? (
                <div className="space-y-1">
                  {s.counts.map((c) => {
                    const pct = s.answered ? Math.round((c.count / s.answered) * 100) : 0;
                    return (
                      <div key={c.label} className="text-[13px]">
                        <div className="flex justify-between text-body">
                          <span className="truncate">{c.label}</span>
                          <span className="text-muted">{`${c.count} · ${pct}%`}</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-divider">
                          <div className="h-full bg-brand" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : s.kind === "numbers" ? (
                <dl className="grid grid-cols-2 gap-1 text-[13px]">
                  <dt className="text-muted">Average</dt>
                  <dd className="text-ink">{`${round(s.average)}${f.unit ? ` ${f.unit}` : ""}`}</dd>
                  <dt className="text-muted">Total</dt>
                  <dd className="text-ink">{`${round(s.total)}${f.unit ? ` ${f.unit}` : ""}`}</dd>
                  <dt className="text-muted">Lowest – highest</dt>
                  <dd className="text-ink">{`${round(s.min)} – ${round(s.max)}`}</dd>
                </dl>
              ) : (
                <p className="text-[13px] text-body">
                  {s.photos != null ? plural(s.photos, "photo") + " in all" : "See each answer on the Answers tab."}
                </p>
              )}
            </div>
          );
        })}
    </div>
  );
}

function round(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString("en-IN") : n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/** What became of a linked answer on the customer record. */
function RecordMark({ result, viaRecord }: { result: string | undefined; viaRecord: boolean }) {
  if (viaRecord) {
    return <span className="ml-1 text-[11px] text-success" title="The customer record already had this, so the task completed itself.">↻ from record</span>;
  }
  if (!result) return null;
  if (result === "saved") return <span className="ml-1 text-[11px] text-success" title="Written to the customer record.">↻ saved</span>;
  if (result === "same") return <span className="ml-1 text-[11px] text-muted" title="The record already said exactly this.">↻ same</span>;
  if (result === "kept") {
    return (
      <span className="ml-1 text-[11px] text-warn" title="The record already had a value and this task only fills blanks, so the record was kept.">
        ↻ kept record
      </span>
    );
  }
  return <span className="ml-1 text-[11px] text-danger" title={result}>↻ not saved</span>;
}
