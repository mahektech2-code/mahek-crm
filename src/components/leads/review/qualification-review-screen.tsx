"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import { parseRupees, stamp } from "@/lib/format";
import { cx, Input, Select, Textarea } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { Banner, Button } from "@/components/console/parts";
import { salesTypeLabel, stageLabel, type LeadStage } from "@/lib/lead-labels";
import {
  SECTION_TITLE,
  type ReviewEdits,
  type ReviewField,
  type ReviewSection,
} from "@/lib/qualification-review";
import { QUALIFICATION_ANSWER_KEYS } from "@/lib/engines/lead-gates";
import { reviewLeadQualification } from "@/lib/actions/lead-qualification-review";
import { saveQualificationReviewEdits } from "@/lib/actions/lead-qualification-review-edit";
import type { QualificationReviewModel } from "@/lib/services/lead-qualification-review-service";

/* ---------------------------------------------------------------------------
 * The Qualification Review — Suspect, Prospect and Qualification answers in one
 * dialog, with the designated approver's Confirm and Reject beside them.
 *
 * This only DRAWS. Who may edit, confirm or reject is decided by the server
 * (`viewer.canDecide`, asked of the same function the actions ask), and the
 * actions refuse again — an undrawn button is a fact about a component.
 * ------------------------------------------------------------------------- */

const SECTIONS: ReviewSection[] = ["suspect", "prospect", "qualification"];
const ANSWER_KEYS = new Set<string>(QUALIFICATION_ANSWER_KEYS);

const STATE_COPY: Record<
  QualificationReviewModel["state"],
  { tone: "info" | "warn" | "danger"; title: string }
> = {
  not_open: { tone: "info", title: "Qualification is not open on this lead" },
  in_progress: { tone: "warn", title: "Qualification is still being completed" },
  pending: { tone: "info", title: "Waiting for the approver's decision" },
  sent_back: { tone: "danger", title: "Rejected — the Salesman owes a correction" },
  verified: { tone: "info", title: "Confirmed by the approver" },
};

type Draft = Record<string, string>;

/** The text a control starts from. */
function startValue(f: ReviewField): string {
  if (f.value === null || f.value === undefined) return "";
  return String(f.value);
}

export function QualificationReviewScreen({
  workspace,
  model,
}: {
  workspace: LeadWorkspace;
  model: QualificationReviewModel;
}) {
  const router = useRouter();
  const toast = useToast();
  const canEdit = model.viewer.canDecide;

  const editable = React.useMemo(
    () => model.rows.flatMap((r) => r.fields).filter((f) => f.editKey),
    [model.rows],
  );
  const initial = React.useMemo<Draft>(
    () => Object.fromEntries(editable.map((f) => [f.editKey as string, startValue(f)])),
    [editable],
  );
  const [draft, setDraft] = React.useState<Draft>(initial);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  const [rejectKind, setRejectKind] = React.useState<"incomplete" | "clarification">("incomplete");

  const dirtyKeys = editable.map((f) => f.editKey as string).filter((k) => draft[k] !== initial[k]);
  const dirty = dirtyKeys.length > 0;

  function build(): ReviewEdits {
    const edits: { fields: Record<string, string | number | null>; answers: Record<string, string> } = {
      fields: {},
      answers: {},
    };
    for (const f of editable) {
      const k = f.editKey as string;
      if (!dirtyKeys.includes(k)) continue;
      const text = String(draft[k] ?? "").trim();
      if (ANSWER_KEYS.has(k)) {
        edits.answers[k] = text;
        continue;
      }
      let out: string | number | null;
      if (text === "") out = null;
      else if (f.kind === "litres" || f.kind === "days") out = Number(text.replace(/[, ]/g, ""));
      else out = text;
      edits.fields[k] = out;
    }
    return edits as ReviewEdits;
  }

  async function save() {
    setBusy("save");
    setError(null);
    try {
      const r = await saveQualificationReviewEdits({ customerId: model.customerId, edits: build() });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.push(r.message ?? "Saved.");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function decide(verdict: "verified" | "incomplete" | "clarification") {
    setBusy(verdict);
    setError(null);
    try {
      const r = await reviewLeadQualification({ customerId: model.customerId, verdict, note });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.push(r.message ?? "Recorded.");
      setNote("");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const copy = STATE_COPY[model.state];
  const d = model.decision;
  const blocked = model.blockers.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="qualification-review-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="qr-title"
        data-testid="qualification-review"
        className="flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-[8px] bg-surface shadow-[0_20px_60px_rgba(0,0,0,0.25)]"
      >
        <div className="border-b border-line px-5 pt-4 pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 id="qr-title" className="text-[16px] leading-[22px] font-semibold text-ink">
                Qualification review
              </h1>
              <p className="text-[12px] text-muted">
                {model.name} · {stageLabel(model.stage as LeadStage)}
                {model.salesType ? ` · ${salesTypeLabel(model.salesType as never)}` : ""}
              </p>
            </div>
            <Link
              href={leadHref(workspace, `${model.customerId}/qualify`)}
              aria-label="Close the review"
              className="-mr-1 rounded px-2 text-[20px] leading-none text-muted hover:text-ink"
            >
              ×
            </Link>
          </div>
          <div className="mt-3 text-[12px] text-muted" data-testid="progress-all">
            <strong className="font-semibold text-ink">
              {model.tally.answered} of {model.tally.total}
            </strong>{" "}
            answers in
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-divider" aria-hidden>
            <div
              className="h-1 rounded-full bg-brand"
              style={{ width: `${Math.round((model.tally.answered / Math.max(model.tally.total, 1)) * 100)}%` }}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-5">
          <Banner
            tone={copy.tone}
            title={copy.title}
            body={
              model.state === "verified" || model.state === "sent_back"
                ? decisionLine(model)
                : model.state === "in_progress"
                  ? `Not yet ready to confirm — ${model.blockers.length} thing${model.blockers.length === 1 ? " is" : "s are"} still missing.`
                  : model.state === "pending"
                    ? "Every required answer is in. The designated approver can confirm or reject it."
                    : (model.viewer.why ?? undefined)
            }
          />

          {/* The owner reads the decision and the reason without needing to act. */}
          {d && d.verdict !== "verified" && d.note ? (
            <section
              className="mt-3 rounded-[6px] border border-danger bg-danger-soft px-5 py-4"
              aria-label="Rejection reason"
              data-testid="rejection-reason"
            >
              <div className="text-[11px] font-medium tracking-[0.04em] text-danger uppercase">
                {d.verdict === "incomplete" ? "Rejected as not finished" : "Rejected — clarification wanted"}
                {d.byName ? ` by ${d.byName}` : ""}
                {d.at ? ` · ${stamp(d.at)}` : ""}
              </div>
              <p className="mt-1 text-[15px] text-ink">{d.note}</p>
            </section>
          ) : null}

          <section className="mt-3 grid grid-cols-2 gap-x-8 gap-y-2 rounded-[6px] border border-line bg-surface px-5 py-3 text-[13px]">
            <Person label="Raised by" name={model.people.creatorName} />
            <Person label="Owner" name={model.people.ownerName} />
            <Person label="Lead manager" name={model.people.leadManagerName} />
            <Person label="Designated approver" name={model.people.verifierName} />
          </section>

          <p className="mt-3 text-[13px] text-muted" data-testid="tally">
            {model.tally.answered} of {model.tally.total} answered
            {model.tally.missingRequired
              ? ` · ${model.tally.missingRequired} required answer${model.tally.missingRequired === 1 ? "" : "s"} missing`
              : " · nothing required is missing"}
            {model.tally.missingOptional ? ` · ${model.tally.missingOptional} optional not answered` : ""}
          </p>

          {SECTIONS.map((section) => {
            const rows = model.rows.filter((r) => r.section === section);
            if (!rows.length) return null;
            const answeredCount = rows.filter((r) => r.answered).length;
            const pct = Math.round((answeredCount / rows.length) * 100);
            return (
              <section key={section} className="mt-4 rounded-[6px] border border-line bg-surface">
                <div className="border-b border-line px-5 pt-3.5 pb-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="text-[15px] font-semibold text-ink">{SECTION_TITLE[section]}</h2>
                    <span className="text-[12px] whitespace-nowrap text-muted" data-testid={`progress-${section}`}>
                      <strong className="font-semibold text-ink">
                        {answeredCount} of {rows.length}
                      </strong>{" "}
                      answers in
                    </span>
                  </div>
                  <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-divider" aria-hidden>
                    <div className="h-1 rounded-full bg-brand" style={{ width: `${pct}%` }} />
                  </div>
                </div>
                <ol>
                  {rows.map((row, i) => {
                    const isDirty = row.fields.some((f) => f.editKey && dirtyKeys.includes(f.editKey));
                    const composite = row.fields.length > 1;
                    return (
                      <li
                        key={row.key}
                        className="flex gap-3 border-b border-divider px-5 py-3.5 last:border-b-0"
                        data-testid={`row-${row.key}`}
                      >
                        <StepDot n={i + 1} done={row.answered} required={row.required} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-[13px] leading-[20px] font-semibold text-ink">{row.label}</div>
                              {row.hint ? <div className="text-[12px] text-muted">{row.hint}</div> : null}
                            </div>
                            <StatusTag answered={row.answered} required={row.required} dirty={isDirty} />
                          </div>
                          <div className={cx("mt-1.5", composite && "space-y-3")}>
                            {row.fields.map((f) => (
                              <div key={f.id} data-testid={`field-${f.id}`}>
                                {f.label ? (
                                  <div className="mb-1 text-[12px] font-medium text-body">{f.label}</div>
                                ) : null}
                                {f.editKey ? (
                                  <EditControl
                                    field={f}
                                    rowLabel={row.label}
                                    value={draft[f.editKey]}
                                    products={model.products}
                                    disabled={busy !== null}
                                    onChange={(v) => setDraft((p) => ({ ...p, [f.editKey as string]: v }))}
                                  />
                                ) : (
                                  <div
                                    className={cx(
                                      "rounded-[4px] border border-line bg-black/[0.03] px-3 py-2 text-[14px]",
                                      f.value !== null && f.value !== "" ? "text-ink" : "text-muted",
                                    )}
                                  >
                                    {f.value !== null && f.value !== "" ? f.display : "Not answered"}
                                  </div>
                                )}
                                {f.hint && f.editKey ? <div className="mt-1 text-[12px] text-muted">{f.hint}</div> : null}
                                {!f.editKey && f.readOnlyReason ? (
                                  <div className="mt-1 text-[12px] text-muted" data-testid="read-only-reason">
                                    {f.readOnlyReason}
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            );
          })}

          {canEdit ? (
            <section className="mt-4 rounded-[6px] border border-line bg-surface px-5 py-4" data-testid="decision-panel">
              <h2 className="text-[15px] font-semibold text-ink">Your decision</h2>
              {blocked ? (
                <div className="mt-2 text-[13px] text-body" data-testid="blockers">
                  <div className="font-medium text-warn-ink">Confirm is held until:</div>
                  <ul className="mt-1 list-disc pl-5">
                    {model.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <label className="mt-3 block text-[13px] text-muted" htmlFor="review-note">
                Reason — required to reject, optional to confirm
              </label>
              <Textarea
                id="review-note"
                rows={3}
                maxLength={2000}
                className="mt-1 w-full max-w-[760px]"
                value={note}
                disabled={busy !== null}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What is missing, or what needs clarifying"
              />
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button
                  tone="primary"
                  disabled={busy !== null || blocked || dirty}
                  title={
                    dirty ? "Save your changes first." : blocked ? "Required answers are still missing." : undefined
                  }
                  onClick={() => decide("verified")}
                >
                  {busy === "verified" ? "Confirming…" : "Confirm qualification"}
                </Button>
                <span className="mx-1 h-5 w-px bg-line" aria-hidden />
                <Select
                  aria-label="Kind of rejection"
                  value={rejectKind}
                  disabled={busy !== null}
                  onChange={(e) => setRejectKind(e.target.value as "incomplete" | "clarification")}
                >
                  <option value="incomplete">Not finished</option>
                  <option value="clarification">Needs a clarification</option>
                </Select>
                <Button
                  tone="danger"
                  disabled={busy !== null || !note.trim()}
                  title={note.trim() ? undefined : "Say why — the Salesman works from this sentence."}
                  onClick={() => decide(rejectKind)}
                >
                  {busy === "incomplete" || busy === "clarification" ? "Rejecting…" : "Reject and send back"}
                </Button>
              </div>
              <p className="mt-2 text-[12px] text-muted">
                Rejecting keeps every answer, holds the lead at Qualification, and tells the owner why.
              </p>
            </section>
          ) : model.viewer.why && model.state !== "not_open" ? (
            <p className="mt-4 text-[13px] text-muted" data-testid="why-not">
              {model.viewer.why}
            </p>
          ) : null}

          <section className="mt-6" data-testid="history">
            <h2 className="text-[15px] font-semibold text-ink">History</h2>
            {model.history.length === 0 ? (
              <p className="mt-1 text-[13px] text-muted">Nothing has been decided or changed here yet.</p>
            ) : (
              <ol className="mt-2 space-y-2">
                {model.history.map((h, i) => (
                  <li key={`${h.at}-${i}`} className="rounded-[6px] border border-line bg-surface px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                      <span className="font-medium text-ink">{h.summary}</span>
                      <span className="text-muted">{stamp(h.at)}</span>
                    </div>
                    {h.note ? <p className="mt-1 text-[13px] text-body">“{h.note}”</p> : null}
                    {h.changes.length ? (
                      <ul className="mt-1 text-[13px] text-body">
                        {h.changes.map((c) => (
                          <li key={c.field}>
                            <span className="text-muted">{c.label}:</span> {fmt(c.from)} → <strong>{fmt(c.to)}</strong>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        {error ? (
          <p
            className="border-t border-danger bg-danger-soft px-5 py-2 text-[13px] text-danger"
            role="alert"
            data-testid="review-error"
          >
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <span className="max-w-[230px] text-[11px] leading-[15px] text-muted">
            {canEdit
              ? "Every change you save is recorded with your name, the time, and the before and after."
              : "Read only — only the lead's designated approver can change or decide."}
          </span>
          <div className="flex items-center gap-2">
            <Link
              href={leadHref(workspace, `${model.customerId}/qualify`)}
              className="inline-flex h-8.5 items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] font-medium text-ink hover:bg-divider"
            >
              Close
            </Link>
            {canEdit ? (
              <>
                {dirty ? (
                  <Button tone="quiet" disabled={busy !== null} onClick={() => setDraft(initial)}>
                    Discard
                  </Button>
                ) : null}
                <Button tone="primary" disabled={!dirty || busy !== null} onClick={save}>
                  {busy === "save"
                    ? "Saving…"
                    : dirty
                      ? `Save ${dirtyKeys.length} change${dirtyKeys.length === 1 ? "" : "s"}`
                      : "Save changes"}
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function fmt(v: string | number | boolean | null): string {
  if (v === null) return "(empty)";
  if (v === true) return "Yes";
  if (v === false) return "No";
  return String(v);
}

function decisionLine(model: QualificationReviewModel): string | undefined {
  const d = model.decision;
  if (!d) return undefined;
  const who = d.byName ? ` by ${d.byName}` : "";
  const when = d.at ? ` on ${stamp(d.at)}` : "";
  return d.verdict === "verified"
    ? `Confirmed${who}${when}.`
    : `${d.verdict === "incomplete" ? "Marked not finished" : "Sent back for clarification"}${who}${when}. Every answer is kept.`;
}

function Person({ label, name }: { label: string; name: string | null }) {
  return (
    <div>
      <div className="text-[11px] tracking-[0.04em] text-muted uppercase">{label}</div>
      <div className={cx("text-[14px]", name ? "text-ink" : "text-muted")}>{name ?? "Not recorded"}</div>
    </div>
  );
}

function EditControl({
  field,
  rowLabel,
  value,
  products,
  disabled,
  onChange,
}: {
  field: ReviewField;
  rowLabel: string;
  value: string | undefined;
  products: { id: string; name: string }[];
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const label = field.label ?? rowLabel;
  const v = value ?? "";
  if ((field.kind === "choice" || field.kind === "yesno") && field.options) {
    return (
      <Select aria-label={label} value={v} disabled={disabled} onChange={(e) => onChange(e.target.value)} className="w-full">
        <option value="">— not answered —</option>
        {field.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  }
  if (field.kind === "product") {
    const known = products.some((p) => p.id === v);
    return (
      <Select aria-label={label} value={v} disabled={disabled} onChange={(e) => onChange(e.target.value)} className="w-full">
        <option value="">— not answered —</option>
        {!known && v ? <option value={v}>{field.display}</option> : null}
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
    );
  }
  if (field.kind === "long") {
    return (
      <Textarea
        aria-label={label}
        rows={2}
        maxLength={500}
        value={v}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full"
      />
    );
  }
  const numeric = field.kind === "litres" || field.kind === "days";
  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label={label}
        type={field.kind === "date" ? "date" : "text"}
        inputMode={numeric ? "numeric" : undefined}
        value={v}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full"
        maxLength={field.id === "gstin" ? 20 : 200}
      />
      {field.kind === "litres" ? <span className="text-[13px] whitespace-nowrap text-muted">litres / month</span> : null}
      {field.kind === "days" ? <span className="text-[13px] text-muted">days</span> : null}
    </div>
  );
}

/** The numbered circle: a green tick once answered, amber while an answer is still needed. */
function StepDot({ n, done, required }: { n: number; done: boolean; required: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
        done ? "bg-success-soft text-success" : required ? "bg-warn-soft text-warn-ink" : "bg-divider text-muted",
      )}
    >
      {done ? "✓" : n}
    </span>
  );
}

/** The right-hand tag: on the record / needed / optional, or unsaved while being edited. */
function StatusTag({ answered, required, dirty }: { answered: boolean; required: boolean; dirty: boolean }) {
  if (dirty) return <span className="text-[11px] font-medium whitespace-nowrap text-brand">unsaved</span>;
  if (answered) return <span className="text-[11px] font-medium whitespace-nowrap text-success">on the record</span>;
  if (required) return <span className="text-[11px] font-medium whitespace-nowrap text-warn-ink">needed</span>;
  return <span className="text-[11px] font-medium whitespace-nowrap text-muted">optional</span>;
}
