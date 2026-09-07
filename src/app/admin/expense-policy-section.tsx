"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Select,
  Td,
  Textarea,
  Th,
  Tr,
} from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import {
  RULE_KINDS,
  MEAL_OPTIONS,
  clockOf,
  describeQualifier,
  ruleSpec,
  type RuleField,
  type RuleKindSpec,
} from "@/lib/expense-rule-forms";
import {
  archiveDraft,
  createPolicyDraft,
  deleteRule,
  publishPolicy,
  saveCityClass,
  saveGradeMapping,
  saveRule,
  simulateDraft,
} from "@/lib/actions/expense-policy";
import type { ExpensePolicyData } from "./expense-policy-data";

export const EXPENSE_POLICY_TABS = [
  { slug: "rules", label: "Rules" },
  { slug: "simulate", label: "What it would cost" },
  { slug: "versions", label: "Versions" },
  { slug: "grades", label: "Grades" },
  { slug: "cities", label: "Cities" },
] as const;

export const EXPENSE_POLICY_SUBTITLE =
  "The travel and expense policy, as versioned rules. Every rate, limit and time of day below is typed on this screen and none of it is in code — which is the whole point of the module. A published version can never be edited: a change is a new version with its own effective date, which is what keeps an old claim worth what it was worth on the day it was made.";

/* -------------------------------------------------------------- the fields */

/**
 * One rule field, rendered from its declaration.
 *
 * Thirteen rule kinds and one form. The alternative was thirteen bespoke
 * components, which is thirteen places for a validation to be forgotten and
 * thirteen chances for two of them to disagree about what "leave it empty"
 * does — and it is exactly that question this screen has to answer well,
 * because an empty box that quietly means "no limit" and an empty box that
 * quietly means "nothing allowed" look identical.
 */
function RuleFieldInput({
  field,
  value,
  onChange,
}: {
  field: RuleField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const help = field.help ?? (field.required ? undefined : `Leave it empty for ${field.emptyMeans}.`);

  if (field.type === "boolean") {
    return (
      <Field label={field.label} hint={help}>
        <Checkbox label="Yes" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
      </Field>
    );
  }

  if (field.type === "select") {
    return (
      <Field label={field.label} hint={help}>
        <Select value={String(value ?? "")} onChange={(e) => onChange(e.target.value || null)}>
          {!field.required ? <option value="">— {field.emptyMeans} —</option> : null}
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  if (field.type === "km_precedence") {
    const list = Array.isArray(value) ? (value as string[]) : ["odometer", "gps", "manual"];
    return (
      <Field label={field.label} hint={help}>
        <Select
          value={list.join(">")}
          onChange={(e) => onChange(e.target.value.split(">"))}
        >
          <option value="odometer>gps>manual">Odometer, then GPS, then by hand</option>
          <option value="gps>odometer>manual">GPS, then the odometer, then by hand</option>
          <option value="odometer>manual>gps">Odometer, then by hand, then GPS</option>
          <option value="manual>odometer>gps">By hand, then the odometer, then GPS</option>
        </Select>
      </Field>
    );
  }

  if (field.type === "clock") {
    const mins = typeof value === "number" ? value : null;
    return (
      <Field label={field.label} hint={help ?? "24-hour. A window running past midnight is written 25:30."}>
        <Input
          value={mins === null ? "" : clockOf(mins)}
          placeholder="08:00"
          onChange={(e) => {
            const m = /^(\d{1,2}):(\d{2})$/.exec(e.target.value.trim());
            onChange(m ? Number(m[1]) * 60 + Number(m[2]) : e.target.value.trim() === "" ? null : value);
          }}
        />
      </Field>
    );
  }

  /* Rupees on the screen, paise in the row. The ×100 happens here, once,
     rather than at each of the places a rate is read. */
  const isMoney = field.type === "paise";
  const isPercent = field.type === "percent";
  const shown =
    value === null || value === undefined || value === ""
      ? ""
      : isMoney
        ? String(Number(value) / 100)
        : isPercent
          ? String(Number(value) / 100)
          : String(value);

  return (
    <Field
      label={field.label + (isMoney ? " (₹)" : isPercent ? " (%)" : field.type === "km" ? " (km)" : "")}
      hint={help}
    >
      <Input
        value={shown}
        inputMode="decimal"
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") return onChange(null);
          const n = Number(raw.replace(/[^0-9.]/g, ""));
          if (!Number.isFinite(n)) return;
          onChange(isMoney || isPercent ? Math.round(n * 100) : Math.round(n));
        }}
      />
    </Field>
  );
}

/* --------------------------------------------------------------- the rule */

type Draft = {
  ruleId: string | null;
  kind: string;
  scopeKey: string;
  grade: string | null;
  cityClass: string | null;
  value: Record<string, unknown>;
};

function scopeOptionsFor(spec: RuleKindSpec, modes: string[]) {
  if (spec.scope === "meal") return MEAL_OPTIONS.map((m) => ({ value: m.value, label: m.label }));
  if (spec.scope === "travel_mode")
    return modes.map((m) => ({ value: `travel_mode:${m}`, label: m.replace(/_/g, " ") }));
  if (spec.scope === "category")
    return [
      { value: "category:travel", label: "Travel" },
      { value: "category:food", label: "Food" },
      { value: "category:lodging", label: "Hotel" },
      { value: "category:local_transport", label: "Local transport" },
      { value: "category:other", label: "Other" },
      ...modes.map((m) => ({ value: `travel_mode:${m}`, label: `Travel by ${m.replace(/_/g, " ")}` })),
    ];
  if (spec.scope === "wildcard")
    return [
      { value: "*", label: "Anything" },
      { value: "category:lodging", label: "Hotel only" },
      { value: "category:other", label: "Other only" },
    ];
  return [];
}

/* The modes are seeded in the migration and read by the handset from the
   database; the builder needs their keys to offer them. They are listed here
   rather than fetched because this component is the only thing that needs them
   as a PICKER, and a round trip to draw a dropdown is a round trip. Adding a
   mode in the database and not here still works — the rule just has to be
   typed rather than picked. */
const SEEDED_MODES = [
  "own_bike",
  "own_car",
  "bus",
  "train",
  "auto_local",
  "taxi",
  "company_vehicle",
  "customer_vehicle",
  "walking",
];

export function ExpensePolicySection({
  data,
  tab,
}: {
  data: ExpensePolicyData;
  tab: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [newVersion, setNewVersion] = React.useState(false);
  const [publishing, setPublishing] = React.useState(false);

  const slug = EXPENSE_POLICY_TABS[Math.min(tab, EXPENSE_POLICY_TABS.length - 1)]!.slug;
  const detail = data.detail;
  const editable = detail?.policy.status === "draft" && data.canWrite;
  const gradeLabel = (key: string) => data.grades.find((g) => g.key === key)?.label ?? key;

  const run = async (fn: () => Promise<{ ok: boolean; error?: string; message?: string; fieldErrors?: { field: string; message: string }[] }>) => {
    setBusy(true);
    setErrors({});
    const r = await fn();
    setBusy(false);
    if (!r.ok) {
      if (r.fieldErrors?.length) {
        setErrors(Object.fromEntries(r.fieldErrors.map((f) => [f.field, f.message])));
      }
      toast.push(r.error ?? "That did not save.", "error");
      return false;
    }
    if (r.message) toast.push(r.message);
    router.refresh();
    return true;
  };

  /* ------------------------------------------------------------- rules tab */

  if (slug === "rules") {
    return (
      <div className="mt-5 space-y-5">
        {!detail ? (
          <EmptyState
            title="No policy version yet"
            body="Create one, attach the document HR issued, and type the rates from it. Nothing is in force until an administrator publishes it."
            action={
              data.canWrite ? (
                <Button variant="primary" onClick={() => setNewVersion(true)}>Create the first version</Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <Card>
              <CardHeader
                title={`Version ${detail.policy.versionNo} — ${detail.policy.title}`}
                hint={
                  detail.policy.status === "draft"
                    ? "A draft. Nothing on any handset reads it, and it can be changed freely."
                    : detail.policy.inForce
                      ? `In force from ${detail.policy.effectiveFrom}. It cannot be edited — every claim already made was worked out against it.`
                      : `${detail.policy.status}, ${detail.policy.effectiveFrom} to ${detail.policy.effectiveTo ?? "now"}. Still read for claims dated inside it.`
                }
                action={
                  <div className="flex gap-2">
                    {data.canWrite ? (
                      <Button variant="secondary" onClick={() => setNewVersion(true)}>
                        New version
                      </Button>
                    ) : null}
                    {editable && data.canPublish ? (
                      <Button variant="primary" onClick={() => setPublishing(true)}>Publish</Button>
                    ) : null}
                  </div>
                }
              />

              {editable && !data.canPublish ? (
                <Callout tone="brand">
                  You can write this policy and you cannot put it into force. That separation is
                  deliberate: requirement 4 asks for somebody to verify a policy before it goes
                  live, and verification by whoever typed the rates is not verification. Ask an
                  administrator to publish it.
                </Callout>
              ) : null}

              {data.readiness?.problems.length ? (
                <Callout tone="danger">
                  <strong>Not ready to publish.</strong>
                  <ul className="mt-1 list-disc pl-5">
                    {data.readiness.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </Callout>
              ) : null}

              {data.readiness?.warnings.length ? (
                <Callout tone="warn">
                  <strong>Worth checking first.</strong>
                  <ul className="mt-1 list-disc pl-5">
                    {data.readiness.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </Callout>
              ) : null}

              {detail.unreadableCount > 0 ? (
                <Callout tone="warn">
                  {detail.unreadableCount} rule
                  {detail.unreadableCount === 1 ? " is" : "s are"} of a kind this release cannot
                  read. They are still stored and still in force — they simply cannot be shown or
                  edited here.
                </Callout>
              ) : null}
            </Card>

            <Card>
              <CardHeader
                title="The rules"
                hint="Each one in the words somebody would use, so it can be held against the document it came from."
                action={
                  editable ? (
                    <Button
                      onClick={() =>
                        setDraft({
                          ruleId: null,
                          kind: "per_km",
                          scopeKey: "travel_mode:own_bike",
                          grade: null,
                          cityClass: null,
                          value: {},
                        })
                      }
                    >
                      Add a rule
                    </Button>
                  ) : undefined
                }
              />
              {detail.rules.length === 0 ? (
                <EmptyState
                  title="No rules yet"
                  body="A policy with no rules pays nothing to anybody. Start with the rate per kilometre and who decides a claim — publishing is refused without both."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr>
                        <Th>Rule</Th>
                        <Th>What it says</Th>
                        <Th>Applies to</Th>
                        {editable ? <Th align="right">&nbsp;</Th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {detail.rules.map((r) => {
                        const spec = ruleSpec(r.kind);
                        return (
                          <Tr key={r.id}>
                            <Td>
                              <span className="font-medium">{spec?.label ?? r.kind}</span>
                              {spec ? (
                                <span
                                  className="block text-[12px] text-muted"
                                  title={`Answers the client's requirement${spec.requirements.length === 1 ? "" : "s"} ${spec.requirements.join(", ")}`}
                                >
                                  §{spec.requirements.join(", §")}
                                </span>
                              ) : null}
                            </Td>
                            <Td>
                              {r.sentence ?? (
                                <span className="text-muted">
                                  This release cannot read “{r.kind}”.
                                </span>
                              )}
                            </Td>
                            <Td>
                              {describeQualifier(r, gradeLabel) || (
                                <span className="text-muted">Everybody, everywhere</span>
                              )}
                            </Td>
                            {editable ? (
                              <Td align="right">
                                <div className="flex justify-end gap-1.5">
                                  <Button
                                    variant="secondary"
                                    onClick={() =>
                                      setDraft({
                                        ruleId: r.id,
                                        kind: r.kind,
                                        scopeKey: r.scopeKey,
                                        grade: r.grade,
                                        cityClass: r.cityClass,
                                        value: r.valueJson,
                                      })
                                    }
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    variant="danger"
                                    disabled={busy}
                                    onClick={() =>
                                      void run(() =>
                                        deleteRule({ policyId: detail.policy.id, ruleId: r.id }),
                                      )
                                    }
                                  >
                                    Remove
                                  </Button>
                                </div>
                              </Td>
                            ) : null}
                          </Tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}

        <RuleModal
          draft={draft}
          errors={errors}
          busy={busy}
          policyId={detail?.policy.id ?? ""}
          onClose={() => setDraft(null)}
          onChange={setDraft}
          onSave={async (d) => {
            const okay = await run(() =>
              saveRule({
                policyId: detail!.policy.id,
                ruleId: d.ruleId,
                kind: d.kind,
                scopeKey: d.scopeKey,
                grade: d.grade,
                cityClass: d.cityClass,
                value: d.value,
              }),
            );
            if (okay) setDraft(null);
          }}
        />

        <NewVersionModal
          open={newVersion}
          busy={busy}
          versions={data.versions}
          onClose={() => setNewVersion(false)}
          onCreate={async (input) => {
            const okay = await run(() => createPolicyDraft(input));
            if (okay) setNewVersion(false);
          }}
        />

        <PublishModal
          open={publishing}
          busy={busy}
          detail={detail}
          onClose={() => setPublishing(false)}
          onPublish={async (input) => {
            const okay = await run(() => publishPolicy(input));
            if (okay) setPublishing(false);
          }}
        />
      </div>
    );
  }

  /* --------------------------------------------------------- simulate tab */

  if (slug === "simulate") {
    return (
      <Simulate
        detail={detail}
        canWrite={data.canWrite}
        today={data.today}
        monthAgo={data.monthAgo}
      />
    );
  }

  /* ---------------------------------------------------------- versions tab */

  if (slug === "versions") {
    return (
      <div className="mt-5">
        <Card>
          <CardHeader
            title="Every version"
            hint="A published version is never edited. That is what makes an expense claimed last March still worth what March's policy said it was worth."
          />
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <Th>Version</Th>
                  <Th>Title</Th>
                  <Th>State</Th>
                  <Th>In force</Th>
                  <Th>Rules</Th>
                  <Th>Published by</Th>
                  <Th align="right">&nbsp;</Th>
                </tr>
              </thead>
              <tbody>
                {data.versions.map((v) => (
                  <Tr key={v.id}>
                    <Td>{v.versionNo}</Td>
                    <Td>{v.title}</Td>
                    <Td>
                      <Badge tone={v.inForce ? "success" : v.status === "draft" ? "warn" : "neutral"}>
                        {v.inForce ? "In force" : v.status}
                      </Badge>
                    </Td>
                    <Td>
                      {v.effectiveFrom}
                      {v.effectiveTo ? ` — ${v.effectiveTo}` : " onwards"}
                    </Td>
                    <Td>{v.ruleCount}</Td>
                    <Td>{v.publishedByName ?? <span className="text-muted">—</span>}</Td>
                    <Td align="right">
                      {v.status === "draft" && data.canWrite ? (
                        <Button
                          variant="danger"
                          disabled={busy}
                          onClick={() => void run(() => archiveDraft({ policyId: v.id }))}
                        >
                          Archive
                        </Button>
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    );
  }

  /* ------------------------------------------------------------ grades tab */

  if (slug === "grades") {
    return (
      <div className="mt-5 space-y-5">
        <Card>
          <CardHeader
            title="Grades"
            hint="A rule may name a grade, so an ASM can have a different hotel limit from an executive without there being two policy documents. Exactly one grade is the residual — whoever no mapping names is paid on it."
          />
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <Th>Grade</Th>
                  <Th>Key</Th>
                  <Th>Residual</Th>
                </tr>
              </thead>
              <tbody>
                {data.grades.map((g) => (
                  <Tr key={g.id}>
                    <Td>{g.label}</Td>
                    <Td className="text-muted">{g.key}</Td>
                    <Td>{g.isResidual ? <Badge tone="success">Residual</Badge> : null}</Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {data.unmapped.length ? (
          <Card>
            <CardHeader
              title="Job titles HRMS has that no grade names"
              hint="These people are paid on the residual grade. That is a real answer and an ordinary one — but somebody being paid on a rule nobody chose for them should not be invisible, which is why this list exists rather than the mapping silently falling through."
            />
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <Th>As HR typed it</Th>
                    <Th>People</Th>
                    <Th align="right">Map it to</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.unmapped.map((u) => (
                    <Tr key={u.normalised}>
                      <Td>{u.position}</Td>
                      <Td>{u.peopleCount}</Td>
                      <Td align="right">
                        <Select
                          defaultValue=""
                          disabled={!data.canWrite || busy}
                          onChange={(e) => {
                            if (!e.target.value) return;
                            void run(() =>
                              saveGradeMapping({ position: u.position, gradeId: e.target.value }),
                            );
                          }}
                        >
                          <option value="">— choose a grade —</option>
                          {data.grades.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.label}
                            </option>
                          ))}
                        </Select>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}

        <Card>
          <CardHeader title="Mapped titles" hint="What HR types, and the grade it means." />
          {data.mappings.length === 0 ? (
            <EmptyState title="Nothing mapped yet" body="Everybody falls to the residual grade." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <Th>Title</Th>
                    <Th>Grade</Th>
                    <Th>People</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.mappings.map((m) => (
                    <Tr key={m.id}>
                      <Td>{m.positionRaw ?? m.positionNormalised}</Td>
                      <Td>{m.gradeLabel}</Td>
                      <Td>{m.peopleCount}</Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    );
  }

  /* ------------------------------------------------------------ cities tab */

  return (
    <div className="mt-5 space-y-5">
      <Card>
        <CardHeader
          title="City classes"
          hint="A rule may name a class rather than a city, because four hundred city names is a rule set nobody maintains. The class is a fact about WHERE HE WENT — a hotel ceiling is about what a room costs there, not about where he is posted."
        />
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <Th>City</Th>
                <Th>Class</Th>
                <Th>Customers</Th>
              </tr>
            </thead>
            <tbody>
              {data.cities.map((c) => (
                <Tr key={c.id}>
                  <Td>{c.cityRaw ?? c.cityNormalised}</Td>
                  <Td>
                    <Select
                      value={c.cityClass}
                      disabled={!data.canWrite || busy}
                      onChange={(e) =>
                        void run(() =>
                          saveCityClass({
                            city: c.cityRaw ?? c.cityNormalised,
                            cityClass: e.target.value as "metro" | "tier1" | "tier2" | "other",
                          }),
                        )
                      }
                    >
                      <option value="metro">Metro</option>
                      <option value="tier1">Tier 1</option>
                      <option value="tier2">Tier 2</option>
                      <option value="other">Other</option>
                    </Select>
                  </Td>
                  <Td>{c.customerCount}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {data.unclassified.length ? (
        <Card>
          <CardHeader
            title="Cities on the book with no class"
            hint="They fall to whatever rule names no class — which is a real answer, and one worth choosing on purpose for the places the field actually goes."
          />
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <Th>City</Th>
                  <Th>Customers</Th>
                  <Th align="right">Class it</Th>
                </tr>
              </thead>
              <tbody>
                {data.unclassified.map((c) => (
                  <Tr key={c.city}>
                    <Td>{c.city}</Td>
                    <Td>{c.customerCount}</Td>
                    <Td align="right">
                      <Select
                        defaultValue=""
                        disabled={!data.canWrite || busy}
                        onChange={(e) => {
                          if (!e.target.value) return;
                          void run(() =>
                            saveCityClass({
                              city: c.city,
                              cityClass: e.target.value as "metro" | "tier1" | "tier2" | "other",
                            }),
                          );
                        }}
                      >
                        <option value="">— choose —</option>
                        <option value="metro">Metro</option>
                        <option value="tier1">Tier 1</option>
                        <option value="tier2">Tier 2</option>
                        <option value="other">Other</option>
                      </Select>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- the modals */

function RuleModal({
  draft,
  errors,
  busy,
  policyId,
  onClose,
  onChange,
  onSave,
}: {
  draft: Draft | null;
  errors: Record<string, string>;
  busy: boolean;
  policyId: string;
  onClose: () => void;
  onChange: (d: Draft) => void;
  onSave: (d: Draft) => void;
}) {
  if (!draft || !policyId) return null;
  const spec = ruleSpec(draft.kind)!;
  const scopes = scopeOptionsFor(spec, SEEDED_MODES);

  return (
    <Modal open onClose={onClose} title={draft.ruleId ? "Change this rule" : "Add a rule"} width={560}>
      <p className="mb-3 text-[13px] text-muted">{spec.blurb}</p>
      <p className="mb-4 text-[12px] text-muted">
        Answers the client&apos;s requirement{spec.requirements.length === 1 ? "" : "s"}{" "}
        {spec.requirements.join(", ")}.
      </p>

      <Field label="Kind of rule">
        <Select
          value={draft.kind}
          onChange={(e) => {
            const next = ruleSpec(e.target.value)!;
            const nextScopes = scopeOptionsFor(next, SEEDED_MODES);
            onChange({
              ...draft,
              kind: e.target.value,
              scopeKey: next.scope === "none" ? "" : (nextScopes[0]?.value ?? ""),
              value: {},
            });
          }}
        >
          {RULE_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </Select>
      </Field>

      {spec.scope !== "none" ? (
        <Field label="Applies to" error={errors.scopeKey}>
          <Select value={draft.scopeKey} onChange={(e) => onChange({ ...draft, scopeKey: e.target.value })}>
            {scopes.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {spec.fields.map((f) => (
        <div key={f.key}>
          <RuleFieldInput
            field={f}
            value={draft.value[f.key]}
            onChange={(v) => onChange({ ...draft, value: { ...draft.value, [f.key]: v } })}
          />
          {errors[f.key] ? <p className="-mt-2 mb-3 text-[12px] text-danger">{errors[f.key]}</p> : null}
        </div>
      ))}

      <div className="mt-4 rounded-[6px] border border-line bg-canvas p-3">
        <p className="mb-2 text-[12px] font-medium">Narrow it — optional</p>
        <p className="mb-3 text-[12px] text-muted">
          Leave both empty and this rule applies to everybody, everywhere. A rule naming a grade
          beats one naming a city, and a rule naming both beats either.
        </p>
        <Field label="Only for this grade">
          <Input
            value={draft.grade ?? ""}
            placeholder="e.g. asm — leave empty for every grade"
            onChange={(e) => onChange({ ...draft, grade: e.target.value.trim() || null })}
          />
        </Field>
        <Field label="Only in this class of city">
          <Select
            value={draft.cityClass ?? ""}
            onChange={(e) => onChange({ ...draft, cityClass: e.target.value || null })}
          >
            <option value="">Every class</option>
            <option value="metro">Metro</option>
            <option value="tier1">Tier 1</option>
            <option value="tier2">Tier 2</option>
            <option value="other">Other</option>
          </Select>
        </Field>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => onSave(draft)}>
          {busy ? "Saving…" : "Save this rule"}
        </Button>
      </div>
    </Modal>
  );
}

function NewVersionModal({
  open,
  busy,
  versions,
  onClose,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  versions: ExpensePolicyData["versions"];
  onClose: () => void;
  onCreate: (input: {
    title: string;
    effectiveFrom: string;
    notes: string | null;
    copyFromPolicyId: string | null;
  }) => void;
}) {
  const [title, setTitle] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [copyFrom, setCopyFrom] = React.useState(
    versions.find((v) => v.inForce)?.id ?? versions[0]?.id ?? "",
  );
  if (!open) return null;

  return (
    <Modal open onClose={onClose} title="A new policy version" width={520}>
      <Field label="What to call it" hint="For example: Travel policy, April 2027 revision.">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field
        label="In force from"
        hint="The date claims start being worked out on it. Everything before this date goes on reading the version it was made under."
      >
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </Field>
      <Field
        label="Start from an existing version"
        hint="A revision is almost always last year's document with three numbers changed. Retyping forty rules to change three is how the other thirty-seven acquire a typo nobody is looking for."
      >
        <Select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
          <option value="">Start empty</option>
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              Version {v.versionNo} — {v.title} ({v.ruleCount} rules)
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Notes" hint="Optional. What changed, and why.">
        <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={busy || title.trim().length < 3 || !/^\d{4}-\d{2}-\d{2}$/.test(from)}
          onClick={() =>
            onCreate({
              title: title.trim(),
              effectiveFrom: from,
              notes: notes.trim() || null,
              copyFromPolicyId: copyFrom || null,
            })
          }
        >
          {busy ? "Creating…" : "Create the draft"}
        </Button>
      </div>
    </Modal>
  );
}

function PublishModal({
  open,
  busy,
  detail,
  onClose,
  onPublish,
}: {
  open: boolean;
  busy: boolean;
  detail: ExpensePolicyData["detail"];
  onClose: () => void;
  onPublish: (input: { policyId: string; effectiveFrom: string; confirmVersionNo: number }) => void;
}) {
  const [from, setFrom] = React.useState(detail?.policy.effectiveFrom ?? "");
  const [typed, setTyped] = React.useState("");
  if (!open || !detail) return null;

  return (
    <Modal open onClose={onClose} title={`Publish version ${detail.policy.versionNo}`} width={520}>
      <Callout tone="warn">
        From the date below, every handset computes against these rules and every claim is paid on
        them. The version currently in force ends the day before, and every expense dated inside it
        goes on being worked out on it — nothing already claimed changes value.
      </Callout>

      <div className="my-3 max-h-64 overflow-y-auto rounded-[6px] border border-line bg-canvas p-3">
        <p className="mb-2 text-[12px] font-medium">What you are putting into force</p>
        <ul className="list-disc space-y-1 pl-5 text-[13px]">
          {detail.rules.map((r) => (
            <li key={r.id}>{r.sentence ?? `A rule of kind ${r.kind} this release cannot read.`}</li>
          ))}
        </ul>
      </div>

      <Field label="In force from">
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </Field>
      <Field
        label={`Type ${detail.policy.versionNo} to confirm`}
        hint="Asked for deliberately. This pays money on the figures above."
      >
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} />
      </Field>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={busy || typed.trim() !== String(detail.policy.versionNo) || !/^\d{4}-\d{2}-\d{2}$/.test(from)}
          onClick={() =>
            onPublish({
              policyId: detail.policy.id,
              effectiveFrom: from,
              confirmVersionNo: detail.policy.versionNo,
            })
          }
        >
          {busy ? "Publishing…" : "Publish"}
        </Button>
      </div>
    </Modal>
  );
}


/* -------------------------------------------------------------- §N73, §N74 */

const rupees = (paise: number) =>
  `${paise < 0 ? "−" : ""}₹${Math.abs(Math.round(paise / 100)).toLocaleString("en-IN")}`;

/**
 * What a draft would have cost, on days that really happened.
 *
 * Requirements 73 and 74. It replays stored days through the draft and shows
 * the difference against what the policy in force at the time actually
 * allowed — no forecast, no model, no assumption about next month.
 *
 * **What it says about itself is as important as the number.** A simulator
 * that prints "+₹42,000" without saying it replayed eleven days is a
 * confidently wrong answer to a question about a month, and the caveats are
 * rendered as prominently as the total rather than under it in grey.
 */
function Simulate({
  detail,
  canWrite,
  today,
  monthAgo,
}: {
  detail: ExpensePolicyData["detail"];
  canWrite: boolean;
  /* Resolved on the server. Reading the clock during render is impure and the
     React Compiler rules refuse it — a component that re-rendered at midnight
     would quietly change what window it was asking about. */
  today: string;
  monthAgo: string;
}) {
  const [from, setFrom] = React.useState(monthAgo);
  const [to, setTo] = React.useState(today);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<Awaited<
    ReturnType<typeof simulateDraft>
  > | null>(null);

  if (!detail) {
    return (
      <div className="mt-5">
        <EmptyState
          title="No version to try"
          body="Create a draft and type some rates into it, then come back and see what it would have cost."
        />
      </div>
    );
  }

  const run = async () => {
    setBusy(true);
    setError(null);
    const r = await simulateDraft({ policyId: detail.policy.id, from, to });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      setResult(null);
      return;
    }
    setResult(r);
  };

  const sim = result?.ok ? result.data : null;

  return (
    <div className="mt-5 space-y-5">
      <Card>
        <CardHeader
          title={`What version ${detail.policy.versionNo} would have cost`}
          hint="It replays days that actually happened through these rules and compares the answer to what was allowed at the time. Nothing is written and no stored figure changes — the engine is pure, so this can only ever be a read."
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button variant="primary" disabled={busy || !canWrite} onClick={() => void run()}>
              {busy ? "Replaying…" : "Try it"}
            </Button>
          </div>
        </div>
        {error ? <Callout tone="danger">{error}</Callout> : null}
      </Card>

      {sim ? (
        <>
          {/* Said before the number, not after it. */}
          {sim.caveats.map((c, i) => (
            <Callout key={i} tone={i === 0 ? "brand" : "warn"}>
              {c}
            </Callout>
          ))}

          <Card>
            <CardHeader
              title="The difference"
              hint={`Over ${sim.daysReplayed} submitted day${sim.daysReplayed === 1 ? "" : "s"}.`}
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-[6px] border border-line px-3 py-2.5">
                <div className="text-[11px] tracking-[0.04em] text-muted uppercase">
                  Allowed at the time
                </div>
                <div className="text-[20px] font-semibold">
                  {rupees(sim.actualEligiblePaise)}
                </div>
              </div>
              <div className="rounded-[6px] border border-line px-3 py-2.5">
                <div className="text-[11px] tracking-[0.04em] text-muted uppercase">
                  Under this draft
                </div>
                <div className="text-[20px] font-semibold">
                  {rupees(sim.simulatedEligiblePaise)}
                </div>
              </div>
              <div className="rounded-[6px] border border-line px-3 py-2.5">
                <div className="text-[11px] tracking-[0.04em] text-muted uppercase">
                  Difference
                </div>
                <div
                  className={
                    sim.differencePaise > 0
                      ? "text-[20px] font-semibold text-warn-ink"
                      : "text-[20px] font-semibold text-ink"
                  }
                >
                  {sim.differencePaise > 0 ? "+" : ""}
                  {rupees(sim.differencePaise)}
                </div>
              </div>
            </div>

            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <Th>&nbsp;</Th>
                    <Th align="right">At the time</Th>
                    <Th align="right">Under this draft</Th>
                    <Th align="right">Difference</Th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Travel", sim.byCategory.actualTravelPaise, sim.byCategory.travelPaise],
                    ["Food", sim.byCategory.actualFoodPaise, sim.byCategory.foodPaise],
                    ["Hotel", sim.byCategory.actualLodgingPaise, sim.byCategory.lodgingPaise],
                    ["Everything else", sim.byCategory.actualOtherPaise, sim.byCategory.otherPaise],
                  ].map(([label, was, now]) => (
                    <Tr key={String(label)}>
                      <Td>{label}</Td>
                      <Td align="right">{rupees(Number(was))}</Td>
                      <Td align="right">{rupees(Number(now))}</Td>
                      <Td align="right">
                        {Number(now) - Number(was) > 0 ? "+" : ""}
                        {rupees(Number(now) - Number(was))}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {sim.perSalesman.length ? (
            <Card>
              <CardHeader
                title="Who it moves most"
                hint="Biggest change first — a rate rise is rarely felt evenly, and the person it moves most is the one to sanity-check it against."
              />
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr>
                      <Th>Salesman</Th>
                      <Th align="right">Days</Th>
                      <Th align="right">At the time</Th>
                      <Th align="right">Under this draft</Th>
                      <Th align="right">Difference</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {sim.perSalesman.map((p) => (
                      <Tr key={p.userId}>
                        <Td>{p.userName}</Td>
                        <Td align="right">{p.days}</Td>
                        <Td align="right">{rupees(p.actualEligiblePaise)}</Td>
                        <Td align="right">{rupees(p.simulatedEligiblePaise)}</Td>
                        <Td align="right">
                          {p.differencePaise > 0 ? "+" : ""}
                          {rupees(p.differencePaise)}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
