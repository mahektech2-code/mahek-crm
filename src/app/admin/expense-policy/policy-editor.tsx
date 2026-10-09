"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  MoneyInput,
  Select,
  Td,
  Textarea,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { ConfirmDialog, Tabs } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { PolicyView } from "@/components/expenses/policy-view";
import {
  KM_SOURCES,
  computeDay,
  type DayComputation,
  type ExpenseKind,
  type Policy,
  type PolicyRuleKind,
  type TravelLegFacts,
  type ExpenseLineFacts,
} from "@/lib/engines/expense-policy";
import {
  EXPENSE_KIND_OPTIONS,
  MEAL_OPTIONS,
  clockOf,
  describeRule,
  parseRule,
  ruleSpec,
  type RuleDraft,
  type RuleField,
} from "@/lib/expense-rule-forms";
import {
  RULE_SECTIONS,
  blankRule,
  checkRules,
  diffRules,
  MAX_GUIDELINE_CHARS,
  MAX_GUIDELINES,
  policyGaps,
  sectionOf,
  type RuleSectionKey,
} from "@/lib/expense-policy-sets";
import { policyInWords } from "@/lib/expense-policy-standard";
import {
  duplicatePolicySet,
  restorePolicyRevision,
  savePolicySet,
  setPolicySetActive,
} from "@/lib/actions/expense-policy-sets";
import { ADMIN } from "@/lib/admin-routes";
import { AdminPage } from "../_shell/admin-page";

/* ---------------------------------------------------------------------------
 * ONE EXPENSE POLICY, every figure in it editable.
 *
 * Drawn from the rule specs in `lib/expense-rule-forms.ts` — the same closed
 * vocabulary the engine prices with — so a rule kind the engine understands is
 * a rule kind this screen can edit, with a dropdown wherever the answer is one
 * of a list (vehicle, meal, kind of bill, time of day, grade, city class).
 *
 * Nothing is written until Save, and the whole list is saved at once with the
 * revision it was edited from. The Preview and Try a day tabs run over the
 * UNSAVED rules, so the effect of a change is visible before it is made.
 * ------------------------------------------------------------------------- */

export type EditorSet = {
  id: string;
  name: string;
  description: string | null;
  isStandard: boolean;
  active: boolean;
  revision: number;
  unreadable: number;
  updatedAt: string | null;
  updatedByName: string | null;
  clonedFromName: string | null;
  guidelines: string[];
};

export type EditorChoices = {
  modes: { key: string; label: string; reimbursementKind: string }[];
  grades: { key: string; label: string }[];
  cityClasses: string[];
};

export type EditorRevision = {
  id: string;
  revision: number;
  name: string;
  note: string | null;
  ruleCount: number;
  createdAt: string | null;
  createdByName: string | null;
};

type Row = { k: string; d: RuleDraft };
type TabKey = "rules" | "preview" | "try" | "people" | "history";

const BILL_CATEGORIES = EXPENSE_KIND_OPTIONS.filter((o) => o.value !== "lodging");
const CLASS_LABEL: Record<string, string> = { metro: "Metro", tier1: "Tier 1", tier2: "Tier 2", other: "Other cities" };
const classLabel = (c: string) => CLASS_LABEL[c] ?? c;

function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

let keySeq = 0;
const nextKey = () => `n${++keySeq}_${Math.random().toString(36).slice(2, 8)}`;

export function PolicyEditor({
  set,
  drafts,
  defaults,
  defaultGuidelines,
  choices,
  revisions,
  members,
  standardCount,
  canWrite,
}: {
  set: EditorSet;
  drafts: RuleDraft[];
  /** The shipped figures — the standard policy only, for "Reset to defaults". */
  defaults: RuleDraft[] | null;
  /** The shipped guidelines — the standard policy only. */
  defaultGuidelines: string[] | null;
  choices: EditorChoices;
  revisions: EditorRevision[];
  members: { userId: string; name: string; position: string | null }[];
  standardCount: number;
  canWrite: boolean;
}) {
  const router = useRouter();
  const { run, push } = useToast();
  const initialRows = React.useMemo(() => drafts.map((d, i) => ({ k: `r${i}`, d })), [drafts]);
  const [rows, setRows] = React.useState<Row[]>(initialRows);
  const [name, setName] = React.useState(set.name);
  const [description, setDescription] = React.useState(set.description ?? "");
  const [guidelines, setGuidelines] = React.useState<string[]>(set.guidelines);
  const [note, setNote] = React.useState("");
  const [tab, setTab] = React.useState<TabKey>("rules");
  const [saving, setSaving] = React.useState(false);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [restoring, setRestoring] = React.useState<EditorRevision | null>(null);

  const current = rows.map((r) => r.d);
  const { rules, errors } = checkRules(current);
  const errorAt = (index: number, field: string) =>
    errors.find((e) => e.index === index && e.field === field)?.message ?? null;
  const rowErrors = (index: number) => errors.filter((e) => e.index === index);

  const saved = JSON.stringify({ n: set.name, d: set.description ?? "", g: set.guidelines, r: drafts });
  const dirty = JSON.stringify({ n: name, d: description, g: guidelines, r: current }) !== saved;
  const guidelinesMoved = JSON.stringify(guidelines) !== JSON.stringify(set.guidelines);
  const cleanGuidelines = guidelines.map((g) => g.trim()).filter(Boolean);
  const diff = diffRules(drafts, current);

  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const modeLabel = React.useCallback((k: string) => choices.modes.find((m) => m.key === k)?.label, [choices.modes]);
  const gradeLabel = React.useCallback(
    (k: string) => choices.grades.find((g) => g.key === k)?.label ?? k,
    [choices.grades],
  );
  const policy: Policy = { id: set.id, versionNo: set.revision, effectiveFrom: "2000-01-01", effectiveTo: null, rules };

  const update = (k: string, fn: (d: RuleDraft) => RuleDraft) =>
    setRows((rs) => rs.map((r) => (r.k === k ? { ...r, d: fn(r.d) } : r)));
  const remove = (k: string) => setRows((rs) => rs.filter((r) => r.k !== k));
  const duplicate = (k: string) =>
    setRows((rs) => {
      const i = rs.findIndex((r) => r.k === k);
      if (i < 0) return rs;
      const copy = { k: nextKey(), d: structuredClone(rs[i]!.d) };
      return [...rs.slice(0, i + 1), copy, ...rs.slice(i + 1)];
    });
  const add = (kind: PolicyRuleKind, section: RuleSectionKey) =>
    setRows((rs) => [...rs, { k: nextKey(), d: blankRule(kind, section) }]);

  function discard() {
    setRows(initialRows);
    setName(set.name);
    setDescription(set.description ?? "");
    setGuidelines(set.guidelines);
    setNote("");
  }

  async function save() {
    if (errors.length) {
      push(
        `${errors.length === 1 ? "One field needs" : `${errors.length} fields need`} fixing first — they are marked in red.`,
        "error",
      );
      setTab("rules");
      return;
    }
    setSaving(true);
    try {
      const r = await run(
        savePolicySet({
          id: set.id,
          name,
          description: description.trim() || null,
          rules: current,
          guidelines: cleanGuidelines,
          expectedRevision: set.revision,
          note: note.trim() || null,
        }),
      );
      if (r.ok) router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const refuse = canWrite ? undefined : "Only accounts and administrators may change expense policies.";
  const gaps = policyGaps(rules);

  return (
    <AdminPage
      title={
        <span className="flex flex-wrap items-center gap-2">
          {set.name}
          {set.isStandard ? <Badge tone="brand">Standard</Badge> : null}
          {set.active ? <Badge tone="success">Active</Badge> : <Badge tone="muted">Switched off</Badge>}
        </span>
      }
      subtitle={
        set.isStandard
          ? `The policy everybody is on unless they are put on another — ${standardCount} ${standardCount === 1 ? "person" : "people"} right now. Revision ${set.revision}, saved ${when(set.updatedAt)}${set.updatedByName ? ` by ${set.updatedByName}` : ""}.`
          : `${members.length} ${members.length === 1 ? "person is" : "people are"} on this policy. Revision ${set.revision}, saved ${when(set.updatedAt)}${set.updatedByName ? ` by ${set.updatedByName}` : ""}.`
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Link href={ADMIN.expensePolicy()} className="text-[13px] text-muted hover:text-body">
            ← All policies
          </Link>
          <Button
            disabled={!canWrite || dirty}
            title={dirty ? "Save or discard your changes first." : refuse}
            onClick={() =>
              void run(duplicatePolicySet({ id: set.id })).then((r) => {
                if (r.ok) router.push(ADMIN.expensePolicy(r.data.id));
              })
            }
          >
            Duplicate
          </Button>
          {!set.isStandard ? (
            <Button
              disabled={!canWrite || dirty}
              title={dirty ? "Save or discard your changes first." : refuse}
              onClick={() =>
                void run(setPolicySetActive({ id: set.id, active: !set.active })).then((r) => {
                  if (r.ok) router.refresh();
                })
              }
            >
              {set.active ? "Switch off" : "Switch on"}
            </Button>
          ) : null}
          <Button variant="primary" disabled={!canWrite || !dirty || saving} title={refuse} onClick={save}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      }
    >
      {dirty ? (
        <div className="sticky top-0 z-20 -mx-6 mb-3 flex flex-wrap items-center gap-3 border-b border-warn-line bg-warn-soft px-6 py-2.5 text-[13px] text-warn-ink">
          <span className="font-medium">Unsaved changes</span>
          <span>
            {[
              diff.added ? `${diff.added} added` : null,
              diff.changed ? `${diff.changed} changed` : null,
              diff.removed ? `${diff.removed} removed` : null,
              name !== set.name || description !== (set.description ?? "") ? "name or description" : null,
              guidelinesMoved ? "guidelines" : null,
            ]
              .filter(Boolean)
              .join(" · ") || "rules reordered"}
          </span>
          {errors.length ? <span className="text-danger">{errors.length} to fix</span> : null}
          <span className="ml-auto block w-[300px]">
            <Input
              className="h-8 bg-surface"
              placeholder="What changed, for the history (optional)"
              value={note}
              maxLength={300}
              onChange={(e) => setNote(e.target.value)}
            />
          </span>
          <Button size="sm" onClick={discard}>
            Discard
          </Button>
          <Button size="sm" variant="primary" disabled={!canWrite || saving} onClick={save}>
            Save
          </Button>
        </div>
      ) : null}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "rules", label: "Rules", count: rows.length },
          { key: "preview", label: "Preview in words" },
          { key: "try", label: "Try a day" },
          { key: "people", label: "People", count: set.isStandard ? standardCount : members.length },
          { key: "history", label: "History", count: revisions.length },
        ]}
      />

      {tab === "rules" ? (
        <div className="mt-4 space-y-4">
          {set.unreadable > 0 ? (
            <Callout tone="danger">
              {set.unreadable} saved {set.unreadable === 1 ? "rule is" : "rules are"} in a shape this release cannot
              read, and
              {set.unreadable === 1 ? " is" : " are"} left out of the policy. Saving will drop{" "}
              {set.unreadable === 1 ? "it" : "them"}.
            </Callout>
          ) : null}

          <Card>
            <CardHeader title="About this policy" />
            <div className="grid gap-4 px-5 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <Field label="Name" error={name.trim().length < 2 ? "Give the policy a name." : null}>
                <Input value={name} maxLength={80} disabled={!canWrite} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="What it is for" hint="Optional. Who should be on it and why.">
                <Textarea
                  rows={2}
                  value={description}
                  maxLength={500}
                  disabled={!canWrite}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
            </div>
            {set.isStandard && defaults ? (
              <div className="flex items-center justify-between gap-3 border-t border-divider px-5 py-3 text-[13px] text-muted">
                <span>
                  The standard policy shipped with Mahek&apos;s own figures. You can put them back at any time.
                </span>
                <Button size="sm" disabled={!canWrite} title={refuse} onClick={() => setConfirmReset(true)}>
                  Reset to shipped defaults
                </Button>
              </div>
            ) : null}
          </Card>

          <Card>
            <CardHeader
              title="Guidelines"
              hint="What the figures cannot say — how a claim is proved, when advances are paid, who to call. Shown to salesmen and managers beside the rules, and on the handset."
            />
            <div className="space-y-2 px-5 py-4">
              {guidelines.length === 0 ? (
                <div className="text-[13px] text-muted italic">None — this policy is its figures alone.</div>
              ) : null}
              {guidelines.map((g, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="mt-2 w-5 shrink-0 text-right text-[12px] text-muted">{i + 1}.</span>
                  <span className="block min-w-0 flex-1">
                    <Input
                      value={g}
                      maxLength={MAX_GUIDELINE_CHARS}
                      disabled={!canWrite}
                      placeholder="A line of the policy, in plain words"
                      onChange={(e) => setGuidelines((gs) => gs.map((x, j) => (j === i ? e.target.value : x)))}
                    />
                  </span>
                  <Button
                    size="sm"
                    disabled={!canWrite || i === 0}
                    title={i === 0 ? "Already first." : "Move up"}
                    onClick={() =>
                      setGuidelines((gs) => {
                        const next = [...gs];
                        [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                        return next;
                      })
                    }
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    disabled={!canWrite}
                    title={refuse}
                    onClick={() => setGuidelines((gs) => gs.filter((_, j) => j !== i))}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                disabled={!canWrite || guidelines.length >= MAX_GUIDELINES}
                title={guidelines.length >= MAX_GUIDELINES ? `At most ${MAX_GUIDELINES} guidelines.` : refuse}
                onClick={() => setGuidelines((gs) => [...gs, ""])}
              >
                + Add a guideline
              </Button>
            </div>
          </Card>

          {gaps.length ? (
            <Callout tone="warn">
              <div className="font-medium">Worth a look before saving</div>
              <ul className="mt-1 list-disc pl-5">
                {gaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </Callout>
          ) : null}

          {RULE_SECTIONS.map((section) => (
            <Card key={section.key}>
              <CardHeader title={section.title} hint={section.blurb} />
              <div className="divide-y divide-divider">
                {section.kinds.map((kind) => {
                  const spec = ruleSpec(kind)!;
                  const inKind = rows
                    .map((r, index) => ({ ...r, index }))
                    .filter((r) => r.d.kind === kind && sectionOf(r.d) === section.key);
                  const label =
                    kind === "actuals"
                      ? section.key === "bills"
                        ? "Bills paid at cost"
                        : "Tickets & fares paid at cost"
                      : spec.label;
                  return (
                    <div key={kind} className="px-5 py-3.5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[14px] font-semibold text-ink">
                            {label} <span className="ml-1 text-[12px] font-normal text-muted">{inKind.length}</span>
                          </div>
                          <div className="mt-0.5 max-w-[760px] text-[12px] text-muted">{spec.blurb}</div>
                        </div>
                        <Button size="sm" disabled={!canWrite} title={refuse} onClick={() => add(kind, section.key)}>
                          + Add
                        </Button>
                      </div>
                      {inKind.length === 0 ? (
                        <div className="mt-2 text-[13px] text-muted italic">None — this policy says nothing here.</div>
                      ) : (
                        <div className="mt-3 space-y-2.5">
                          {inKind.map((r) => (
                            <RuleRow
                              key={r.k}
                              draft={r.d}
                              section={section.key}
                              number={r.index + 1}
                              choices={choices}
                              disabled={!canWrite}
                              errorAt={(f) => errorAt(r.index, f)}
                              hasErrors={rowErrors(r.index).length > 0}
                              gradeLabel={gradeLabel}
                              onChange={(fn) => update(r.k, fn)}
                              onRemove={() => remove(r.k)}
                              onDuplicate={() => duplicate(r.k)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}
        </div>
      ) : null}

      {tab === "preview" ? (
        <div className="mt-4">
          <PolicyView
            sections={policyInWords(rules, { modeLabel, gradeLabel })}
            guidelines={cleanGuidelines}
            title={name}
            intro={
              dirty
                ? "as it would read once saved — these changes are not saved yet."
                : "as a salesman and his manager read it."
            }
          />
        </div>
      ) : null}

      {tab === "try" ? (
        <TryADay policy={policy} choices={choices} modeLabel={modeLabel} dirty={dirty} broken={errors.length} />
      ) : null}

      {tab === "people" ? (
        <Card className="mt-4 overflow-hidden">
          <CardHeader
            title="Who is on this policy"
            hint={
              set.isStandard
                ? "Everybody holding the Salesman App who is not on another active policy."
                : set.active
                  ? "Move people on or off it from the list of policies."
                  : "This policy is switched off, so these people are paid on the standard policy until it is switched back on."
            }
            action={
              <Link href={`${ADMIN.expensePolicy()}?tab=people`} className="text-[13px] text-brand hover:underline">
                Change who is on which →
              </Link>
            }
          />
          {set.isStandard ? (
            <div className="px-5 py-4 text-[13px] text-body">
              {standardCount} {standardCount === 1 ? "person" : "people"} on the standard policy.
            </div>
          ) : members.length === 0 ? (
            <EmptyState title="Nobody yet" body="Put salesmen on this policy from the Who is on which tab." />
          ) : (
            <table className="w-full table-fixed">
              <thead>
                <tr>
                  <Th>Person</Th>
                  <Th>Position</Th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <Tr key={m.userId}>
                    <Td className="font-medium text-ink">{m.name}</Td>
                    <Td>{m.position ?? <span className="text-muted">—</span>}</Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : null}

      {tab === "history" ? (
        <Card className="mt-4 overflow-hidden">
          <CardHeader
            title="Every saved version"
            hint="Restoring an old version saves it as a new revision, so nothing is ever lost."
          />
          {revisions.length === 0 ? (
            <EmptyState title="No history yet" />
          ) : (
            <div className="overflow-auto">
              <table className="w-full min-w-[760px] table-fixed">
                <thead>
                  <tr>
                    <Th style={{ width: 90 }}>Revision</Th>
                    <Th style={{ width: 200 }}>Saved</Th>
                    <Th style={{ width: 300 }}>Note</Th>
                    <Th style={{ width: 70 }} align="right">
                      Rules
                    </Th>
                    <Th style={{ width: 100 }} />
                  </tr>
                </thead>
                <tbody>
                  {revisions.map((rv) => (
                    <Tr key={rv.id}>
                      <Td>
                        {rv.revision}
                        {rv.revision === set.revision ? (
                          <Badge tone="success" className="ml-1.5">
                            Current
                          </Badge>
                        ) : null}
                      </Td>
                      <Td className="whitespace-normal text-[13px]">
                        {when(rv.createdAt)}
                        {rv.createdByName ? <div className="text-[12px] text-muted">by {rv.createdByName}</div> : null}
                      </Td>
                      <Td className="whitespace-normal text-[13px]">
                        {rv.note ?? <span className="text-muted">—</span>}
                        {rv.name !== set.name ? <div className="text-[12px] text-muted">named “{rv.name}”</div> : null}
                      </Td>
                      <Td align="right">{rv.ruleCount}</Td>
                      <Td align="right">
                        {rv.revision !== set.revision ? (
                          <Button
                            size="sm"
                            disabled={!canWrite || dirty}
                            title={dirty ? "Save or discard your changes first." : refuse}
                            onClick={() => setRestoring(rv)}
                          >
                            Restore
                          </Button>
                        ) : null}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      <ConfirmDialog
        open={confirmReset}
        title="Put the shipped defaults back?"
        body="Every rule and guideline on this page is replaced with the figures the standard policy shipped with. Nothing is saved until you press Save."
        confirmLabel="Replace the rules"
        onClose={() => setConfirmReset(false)}
        onConfirm={() => {
          if (defaults) setRows(defaults.map((d) => ({ k: nextKey(), d })));
          if (defaultGuidelines) setGuidelines(defaultGuidelines);
          setNote("Reset to the shipped defaults.");
        }}
      />
      <ConfirmDialog
        open={!!restoring}
        title={`Restore revision ${restoring?.revision ?? ""}?`}
        body="Its rules replace the current ones and are saved at once as a new revision. The current version stays in the history."
        confirmLabel="Restore"
        onClose={() => setRestoring(null)}
        onConfirm={async () => {
          if (!restoring) return;
          const r = await run(restorePolicyRevision({ id: set.id, revision: restoring.revision }));
          if (r.ok) router.refresh();
        }}
      />
    </AdminPage>
  );
}

/* ------------------------------------------------------------ one rule */

function scopeOptions(
  kind: string,
  section: RuleSectionKey,
  choices: EditorChoices,
): { label: string; options: { value: string; label: string }[] } | null {
  const modes = choices.modes.map((m) => ({ value: m.key, label: m.label }));
  const travelModes = choices.modes.map((m) => ({ value: `travel_mode:${m.key}`, label: m.label }));
  const categories = BILL_CATEGORIES.map((c) => ({ value: `category:${c.value}`, label: c.label }));
  switch (kind) {
    case "per_km":
    case "zero_rated":
      return { label: "Vehicle", options: modes };
    case "km_source":
    case "odometer_photo":
      return { label: "Vehicle", options: [{ value: "*", label: "Every vehicle" }, ...modes] };
    case "actuals":
      return section === "bills"
        ? { label: "Kind of bill", options: categories }
        : { label: "Ticket / fare", options: travelModes };
    case "meal_rate":
    case "meal_entitlement":
    case "meal_disqualifier":
      return { label: "Meal", options: MEAL_OPTIONS.map((m) => ({ value: m.value, label: m.label })) };
    case "proof_threshold":
      return {
        label: "For",
        options: [
          { value: "*", label: "Everything" },
          { value: "category:lodging", label: "Hotel bills" },
          ...categories.map((c) => ({ ...c, label: `${c.label} bills` })),
          ...travelModes.map((m) => ({ ...m, label: `${m.label} tickets` })),
        ],
      };
    default:
      return null;
  }
}

function RuleRow({
  draft,
  section,
  number,
  choices,
  disabled,
  errorAt,
  hasErrors,
  gradeLabel,
  onChange,
  onRemove,
  onDuplicate,
}: {
  draft: RuleDraft;
  section: RuleSectionKey;
  number: number;
  choices: EditorChoices;
  disabled: boolean;
  errorAt: (field: string) => string | null;
  hasErrors: boolean;
  gradeLabel: (k: string) => string;
  onChange: (fn: (d: RuleDraft) => RuleDraft) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const spec = ruleSpec(draft.kind);
  if (!spec) return null;
  const scope = scopeOptions(draft.kind, section, choices);
  const parsed = hasErrors ? null : parseRule({ ...draft, valueJson: draft.value });
  const setValue = (key: string, v: unknown) => onChange((d) => ({ ...d, value: { ...d.value, [key]: v } }));
  const scopeKnown = !scope || scope.options.some((o) => o.value === draft.scopeKey);
  const sentence = parsed ? describeRule(parsed) : null;
  const who = [
    draft.grade ? gradeLabel(draft.grade) : null,
    draft.cityClass ? `${classLabel(draft.cityClass)} cities` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className={cx("rounded-[6px] border bg-surface px-3.5 py-3", hasErrors ? "border-danger" : "border-line")}>
      <div className="flex flex-wrap items-start gap-3 [&>label>span:first-child]:flex [&>label>span:first-child]:min-h-8 [&>label>span:first-child]:items-end">
        <span className="mt-[45px] w-6 shrink-0 text-[12px] text-muted">#{number}</span>
        {scope ? (
          <Field label={scope.label} error={errorAt("scopeKey")} className="w-[210px]">
            <Select
              className="w-full"
              value={draft.scopeKey}
              disabled={disabled}
              onChange={(e) => onChange((d) => ({ ...d, scopeKey: e.target.value }))}
            >
              {!draft.scopeKey ? <option value="">Pick…</option> : null}
              {!scopeKnown && draft.scopeKey ? (
                <option value={draft.scopeKey}>{draft.scopeKey} (not on the list)</option>
              ) : null}
              {scope.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {spec.fields.map((f) => (
          <RuleFieldInput
            key={f.key}
            field={f}
            value={draft.value[f.key]}
            error={errorAt(f.key)}
            disabled={disabled}
            onChange={(v) => setValue(f.key, v)}
          />
        ))}

        <Field label="Grade" className="w-[150px]">
          <Select
            className="w-full"
            value={draft.grade ?? ""}
            disabled={disabled}
            onChange={(e) => onChange((d) => ({ ...d, grade: e.target.value || null }))}
          >
            <option value="">Every grade</option>
            {draft.grade && !choices.grades.some((g) => g.key === draft.grade) ? (
              <option value={draft.grade}>{draft.grade}</option>
            ) : null}
            {choices.grades.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="City class" className="w-[140px]">
          <Select
            className="w-full"
            value={draft.cityClass ?? ""}
            disabled={disabled}
            onChange={(e) => onChange((d) => ({ ...d, cityClass: e.target.value || null }))}
          >
            <option value="">Every city</option>
            {choices.cityClasses.map((c) => (
              <option key={c} value={c}>
                {classLabel(c)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="mt-2 flex items-center gap-3 text-[12px]">
        <div className="min-w-0">
          {sentence ? (
            <span className="text-body">
              {who ? <span className="mr-1 font-medium text-ink">{who}:</span> : null}
              {sentence}
            </span>
          ) : errorAt("kind") ? (
            <span className="text-danger">{errorAt("kind")}</span>
          ) : (
            <span className="text-danger">Fix the fields marked in red.</span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            title="Copy this rule — e.g. to give one grade a different figure"
            onClick={onDuplicate}
          >
            Copy
          </Button>
          <Button size="sm" variant="ghost" disabled={disabled} title="Remove this rule" onClick={onRemove}>
            Remove
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ one field */

const CLOCK_STEPS = Array.from({ length: (36 * 60) / 15 + 1 }, (_, i) => i * 15);

function clockLabel(minutes: number): string {
  const nextDay = minutes >= 24 * 60;
  const m = minutes % (24 * 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${suffix}${nextDay ? " (next day)" : ""}`;
}

function RuleFieldInput({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  field: RuleField;
  value: unknown;
  error: string | null;
  disabled: boolean;
  onChange: (v: unknown) => void;
}) {
  const hint = !field.required && field.emptyMeans ? `Empty: ${field.emptyMeans}` : undefined;
  switch (field.type) {
    case "clock": {
      const n = typeof value === "number" ? value : null;
      return (
        <Field label={field.label} error={error} className="w-[170px]">
          <Select
            className="w-full"
            value={n === null ? "" : String(n)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          >
            {!field.required || n === null ? <option value="">{field.required ? "Pick…" : "—"}</option> : null}
            {n !== null && !CLOCK_STEPS.includes(n) ? <option value={n}>{clockOf(n)}</option> : null}
            {CLOCK_STEPS.map((m) => (
              <option key={m} value={m}>
                {clockLabel(m)}
              </option>
            ))}
          </Select>
        </Field>
      );
    }
    case "boolean":
      return (
        <Field label={field.label} error={error} className="w-[190px]">
          <Select
            className="w-full"
            value={value === true ? "yes" : value === false ? "no" : ""}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value === "yes")}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </Select>
        </Field>
      );
    case "select":
      return (
        <Field label={field.label} error={error} className="w-[250px]">
          <Select
            className="w-full"
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          >
            {!field.required ? <option value="">{field.emptyMeans ? `— ${field.emptyMeans}` : "—"}</option> : null}
            {(field.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      );
    case "km_precedence": {
      const list = Array.isArray(value) ? (value as string[]) : [];
      const label = (s: string) => (s === "gps" ? "GPS track" : s === "odometer" ? "Odometer" : "Typed by hand");
      const setAt = (i: number, v: string) => {
        const next = [...list];
        if (v === "") next.splice(i);
        else next[i] = v;
        onChange(next.filter(Boolean));
      };
      return (
        <Field label={field.label} error={error} className="w-[420px]">
          <span className="flex gap-1.5">
            {[0, 1, 2].map((i) => (
              <Select
                key={i}
                className="w-full"
                value={list[i] ?? ""}
                disabled={disabled || (i > 0 && !list[i - 1])}
                onChange={(e) => setAt(i, e.target.value)}
              >
                {i > 0 ? <option value="">{i === 1 ? "then nothing" : "then nothing"}</option> : null}
                {KM_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {i + 1}. {label(s)}
                  </option>
                ))}
              </Select>
            ))}
          </span>
        </Field>
      );
    }
    default:
      return (
        <NumberField field={field} value={value} error={error} hint={hint} disabled={disabled} onChange={onChange} />
      );
  }
}

/** Money, kilometres, minutes and percentages — typed, kept as text until it reads as a number. */
function NumberField({
  field,
  value,
  error,
  hint,
  disabled,
  onChange,
}: {
  field: RuleField;
  value: unknown;
  error: string | null;
  hint?: string;
  disabled: boolean;
  onChange: (v: unknown) => void;
}) {
  const scale = field.type === "paise" || field.type === "percent" ? 100 : 1;
  const toText = (v: unknown) =>
    typeof v === "number" ? String(Number((v / scale).toFixed(2))) : typeof v === "string" ? v : "";
  const [text, setText] = React.useState(() => toText(value));
  const unit = field.type === "km" ? "km" : field.type === "percent" ? "%" : field.help === "Minutes." ? "min" : null;

  function change(t: string) {
    setText(t);
    const trimmed = t.trim().replace(/,/g, "");
    if (trimmed === "") return onChange(null);
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return onChange(t);
    onChange(Math.round(n * scale));
  }

  const placeholder = field.required ? undefined : (field.emptyMeans ?? "—");
  return (
    <Field label={field.label} error={error} className="w-[190px]">
      {field.type === "paise" ? (
        <MoneyInput
          value={text}
          invalid={!!error}
          disabled={disabled}
          placeholder={placeholder}
          title={hint ?? field.help}
          onChange={(e) => change(e.target.value)}
        />
      ) : (
        <span className="flex items-center gap-1.5">
          <Input
            inputMode="decimal"
            value={text}
            invalid={!!error}
            disabled={disabled}
            placeholder={placeholder}
            title={hint ?? field.help}
            onChange={(e) => change(e.target.value)}
          />
          {unit ? <span className="text-[12px] text-muted">{unit}</span> : null}
        </span>
      )}
    </Field>
  );
}

/* ------------------------------------------------------------ try a day */

type TryLeg = { k: string; mode: string; km: string; fare: string; proof: boolean };
type TryBill = { k: string; kind: ExpenseKind; amount: string; proof: boolean; nights: string };

const money = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** The engine, run over a made-up day. Outside the component so a throw is a sentence, not a crash. */
function workOut(
  policy: Policy,
  day: {
    subject: { grade: string | null; cityClass: string | null };
    departed: number;
    returned: number;
    arrived: number | null;
    overnight: boolean;
    hotel: boolean;
    legs: TravelLegFacts[];
    lines: ExpenseLineFacts[];
  },
): { result: DayComputation | null; failure: string | null } {
  try {
    const result = computeDay(policy, day.subject, {
      day: "2026-01-15",
      clock: { departedMinutes: day.departed, returnedMinutes: day.returned, arrivedAtDestinationMinutes: day.arrived },
      departedFromHometown: true,
      stayedInHotel: day.hotel,
      overnight: day.overnight,
      legs: day.legs,
      lines: day.lines,
    });
    return { result, failure: null };
  } catch (e) {
    return { result: null, failure: e instanceof Error ? e.message : "This day could not be worked out." };
  }
}

function TryADay({
  policy,
  choices,
  modeLabel,
  dirty,
  broken,
}: {
  policy: Policy;
  choices: EditorChoices;
  modeLabel: (k: string) => string | undefined;
  dirty: boolean;
  /** Rules with a field to fix — worked out as best they read, and said so. */
  broken: number;
}) {
  const [grade, setGrade] = React.useState("");
  const [cityClass, setCityClass] = React.useState("");
  const [departed, setDeparted] = React.useState(9 * 60);
  const [returned, setReturned] = React.useState(19 * 60 + 30);
  const [overnight, setOvernight] = React.useState(false);
  const [hotel, setHotel] = React.useState(false);
  const [arrived, setArrived] = React.useState(7 * 60);
  const [legs, setLegs] = React.useState<TryLeg[]>([
    {
      k: "l0",
      mode: choices.modes.find((m) => m.key === "own_bike")?.key ?? choices.modes[0]?.key ?? "own_bike",
      km: "40",
      fare: "",
      proof: true,
    },
  ]);
  const [bills, setBills] = React.useState<TryBill[]>([
    { k: "b0", kind: "food", amount: "", proof: true, nights: "1" },
  ]);

  const num = (s: string) => {
    const n = Number(s.replace(/,/g, ""));
    return Number.isFinite(n) && s.trim() !== "" ? n : null;
  };

  const legFacts: TravelLegFacts[] = legs.map((l) => {
    const km = num(l.km);
    const fare = num(l.fare);
    return {
      id: l.k,
      modeKey: l.mode,
      gpsMetres: km === null ? null : Math.round(km * 1000),
      gpsCoveragePct: km === null ? null : 100,
      manualMetres: null,
      odometerMetres: km === null ? null : Math.round(km * 1000),
      hasOdometerPhoto: true,
      ticketAmountPaise: fare === null ? null : Math.round(fare * 100),
      hasTicketProof: l.proof,
    };
  });
  const lineFacts: ExpenseLineFacts[] = bills
    .filter((b) => num(b.amount) !== null)
    .map((b) => ({
      id: b.k,
      kind: b.kind,
      claimedPaise: Math.round(num(b.amount)! * 100),
      hasProof: b.proof,
      nights: b.kind === "lodging" ? (num(b.nights) ?? 0) : undefined,
    }));

  const { result, failure } = workOut(policy, {
    subject: { grade: grade || null, cityClass: cityClass || null },
    departed,
    returned,
    arrived: overnight ? arrived : null,
    overnight,
    hotel,
    legs: legFacts,
    lines: lineFacts,
  });

  const clockSelect = (v: number, set: (n: number) => void) => (
    <Select className="w-full" value={String(v)} onChange={(e) => set(Number(e.target.value))}>
      {CLOCK_STEPS.map((m) => (
        <option key={m} value={m}>
          {clockLabel(m)}
        </option>
      ))}
    </Select>
  );

  return (
    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader
          title="A day to try"
          hint={`Worked out by the same engine the claims are paid with, on ${dirty ? "your UNSAVED rules" : "this policy as saved"}. Nothing here is stored.`}
        />
        <div className="space-y-4 px-5 py-4">
          {broken ? (
            <Callout tone="warn">
              {broken === 1 ? "One field on the Rules tab needs" : `${broken} fields on the Rules tab need`} fixing, so
              this day uses those rules as best they read.
            </Callout>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Grade">
              <Select className="w-full" value={grade} onChange={(e) => setGrade(e.target.value)}>
                <option value="">No grade</option>
                {choices.grades.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="City class">
              <Select className="w-full" value={cityClass} onChange={(e) => setCityClass(e.target.value)}>
                <option value="">Not classed</option>
                {choices.cityClasses.map((c) => (
                  <option key={c} value={c}>
                    {classLabel(c)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Punched in / left home">{clockSelect(departed, setDeparted)}</Field>
            <Field label="Punched out / back">{clockSelect(returned, setReturned)}</Field>
          </div>
          <div className="flex flex-wrap items-end gap-4 text-[13px] text-body">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={overnight} onChange={(e) => setOvernight(e.target.checked)} /> Travelled
              overnight
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={hotel} onChange={(e) => setHotel(e.target.checked)} /> Stayed in a hotel
            </label>
            {overnight ? (
              <Field label="Arrived at" className="w-[180px]">
                {clockSelect(arrived, setArrived)}
              </Field>
            ) : null}
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Trips</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setLegs((l) => [
                    ...l,
                    { k: nextKey(), mode: choices.modes[0]?.key ?? "bus", km: "", fare: "", proof: true },
                  ])
                }
              >
                + Trip
              </Button>
            </div>
            <div className="space-y-2">
              {legs.map((l) => (
                <div key={l.k} className="flex flex-wrap items-center gap-2">
                  <Select
                    className="w-[180px]"
                    value={l.mode}
                    onChange={(e) => setLegs((ls) => ls.map((x) => (x.k === l.k ? { ...x, mode: e.target.value } : x)))}
                  >
                    {choices.modes.map((m) => (
                      <option key={m.key} value={m.key}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                  <span className="block w-[90px]">
                    <Input
                      inputMode="decimal"
                      placeholder="km"
                      value={l.km}
                      onChange={(e) => setLegs((ls) => ls.map((x) => (x.k === l.k ? { ...x, km: e.target.value } : x)))}
                    />
                  </span>
                  <span className="text-[12px] text-muted">km</span>
                  <MoneyInput
                    className="w-[120px]"
                    placeholder="fare"
                    value={l.fare}
                    onChange={(e) => setLegs((ls) => ls.map((x) => (x.k === l.k ? { ...x, fare: e.target.value } : x)))}
                  />
                  <label className="flex items-center gap-1.5 text-[12px] text-body">
                    <input
                      type="checkbox"
                      checked={l.proof}
                      onChange={(e) =>
                        setLegs((ls) => ls.map((x) => (x.k === l.k ? { ...x, proof: e.target.checked } : x)))
                      }
                    />{" "}
                    ticket
                  </label>
                  <button
                    className="text-[12px] text-muted hover:text-danger"
                    onClick={() => setLegs((ls) => ls.filter((x) => x.k !== l.k))}
                  >
                    remove
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Bills logged</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setBills((b) => [...b, { k: nextKey(), kind: "other", amount: "", proof: true, nights: "1" }])
                }
              >
                + Bill
              </Button>
            </div>
            <div className="space-y-2">
              {bills.map((b) => (
                <div key={b.k} className="flex flex-wrap items-center gap-2">
                  <Select
                    className="w-[180px]"
                    value={b.kind}
                    onChange={(e) =>
                      setBills((bs) => bs.map((x) => (x.k === b.k ? { ...x, kind: e.target.value as ExpenseKind } : x)))
                    }
                  >
                    {EXPENSE_KIND_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                  <MoneyInput
                    className="w-[130px]"
                    placeholder="amount"
                    value={b.amount}
                    onChange={(e) =>
                      setBills((bs) => bs.map((x) => (x.k === b.k ? { ...x, amount: e.target.value } : x)))
                    }
                  />
                  {b.kind === "lodging" ? (
                    <>
                      <span className="block w-[70px]">
                        <Input
                          inputMode="numeric"
                          value={b.nights}
                          onChange={(e) =>
                            setBills((bs) => bs.map((x) => (x.k === b.k ? { ...x, nights: e.target.value } : x)))
                          }
                        />
                      </span>
                      <span className="text-[12px] text-muted">nights</span>
                    </>
                  ) : null}
                  <label className="flex items-center gap-1.5 text-[12px] text-body">
                    <input
                      type="checkbox"
                      checked={b.proof}
                      onChange={(e) =>
                        setBills((bs) => bs.map((x) => (x.k === b.k ? { ...x, proof: e.target.checked } : x)))
                      }
                    />{" "}
                    bill photo
                  </label>
                  <button
                    className="text-[12px] text-muted hover:text-danger"
                    onClick={() => setBills((bs) => bs.filter((x) => x.k !== b.k))}
                  >
                    remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="What it pays" />
        {failure ? (
          <div className="px-5 py-4 text-[13px] text-danger">{failure}</div>
        ) : result ? (
          <div className="px-5 py-4 text-[13px]">
            <dl className="divide-y divide-divider">
              {result.meals.map((m) => (
                <div key={m.meal} className="flex justify-between gap-3 py-1.5">
                  <dt className="text-body">
                    {m.meal[0]!.toUpperCase() + m.meal.slice(1)}
                    {m.withheldReason ? <span className="block text-[12px] text-muted">{m.withheldReason}</span> : null}
                  </dt>
                  <dd className="font-medium text-ink">{m.earned ? money(m.amountPaise) : "—"}</dd>
                </div>
              ))}
              {result.dormitoryApplied ? (
                <div className="flex justify-between py-1.5">
                  <dt className="text-body">Overnight morning</dt>
                  <dd className="font-medium text-ink">{money(result.dormitoryPaise)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between py-1.5">
                <dt className="font-medium text-body">Food allowance</dt>
                <dd className="font-semibold text-ink">{money(result.foodPaise)}</dd>
              </div>
              {result.legs.map((l, i) => (
                <div key={l.legId} className="flex justify-between gap-3 py-1.5">
                  <dt className="text-body">
                    Trip {i + 1} — {modeLabel(l.modeKey) ?? l.modeKey}
                    <span className="block text-[12px] text-muted">
                      {l.unpricedReason ??
                        (l.paisePerKm !== null && l.chosenMetres !== null
                          ? `${(l.chosenMetres / 1000).toFixed(1)} km × ${money(l.paisePerKm)}`
                          : l.claimedPaise
                            ? `fare ${money(l.claimedPaise)}`
                            : "")}
                    </span>
                  </dt>
                  <dd className="font-medium text-ink">{money(l.eligiblePaise)}</dd>
                </div>
              ))}
              <div className="flex justify-between py-1.5">
                <dt className="text-body">Hotel</dt>
                <dd className="font-medium text-ink">
                  {money(result.lodgingEligiblePaise)}
                  {result.lodgingClaimedPaise ? (
                    <span className="ml-1 text-[12px] font-normal text-muted">
                      of {money(result.lodgingClaimedPaise)}
                    </span>
                  ) : null}
                </dd>
              </div>
              <div className="flex justify-between py-1.5">
                <dt className="text-body">Other bills</dt>
                <dd className="font-medium text-ink">
                  {money(result.otherEligiblePaise)}
                  {result.otherClaimedPaise ? (
                    <span className="ml-1 text-[12px] font-normal text-muted">
                      of {money(result.otherClaimedPaise)}
                    </span>
                  ) : null}
                </dd>
              </div>
              <div className="flex justify-between py-2 text-[14px]">
                <dt className="font-semibold text-ink">Allowed for the day</dt>
                <dd className="font-semibold text-ink">{money(result.totalEligiblePaise)}</dd>
              </div>
              {result.totalExcessPaise > 0 ? (
                <div className="flex justify-between py-1.5 text-warn-ink">
                  <dt>Over the limits</dt>
                  <dd>{money(result.totalExcessPaise)}</dd>
                </div>
              ) : null}
            </dl>
            {result.exceptions.length ? (
              <div className="mt-3">
                <div className="mb-1 text-xs font-medium tracking-[0.04em] text-muted uppercase">
                  Flags the manager would see
                </div>
                <ul className="space-y-1">
                  {result.exceptions.map((e, i) => (
                    <li key={i} className="flex gap-2">
                      <Badge tone={e.severity === "info" ? "muted" : e.severity === "warn" ? "warn" : "danger"}>
                        {e.severity === "block_route" ? "needs proof" : e.severity}
                      </Badge>
                      <span className="text-body">{e.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
