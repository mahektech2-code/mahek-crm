"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { money, parseRupees } from "@/lib/format";
import { cx, Input, Textarea } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { salesTypeLabel, stageLabel, type LeadStage } from "@/lib/lead-labels";
import type { Condition, GateVerdict } from "@/lib/engines/lead-gates";
import { saveLeadQualification, saveProspectFields } from "@/lib/actions/leads";
import {
  saveDistributorProfile,
  type DistributorProfilePatch,
} from "@/lib/actions/distributor-appointment";
import type { DistributorProfile } from "@/lib/services/lead-record-service";
import { Banner, Button, Empty, Pill, ScreenHeader } from "../../../parts";
import { plural } from "../../../words";

/* ---------------------------------------------------------------------------
 * §9 §11 — the qualification checklist, at full size.
 *
 * It is the same list and the same actions as the panel on the record; what is
 * different is the room. Twelve conditions inside a modal is a scroll, and
 * thirty is a scroll inside a scroll — a salesman answering the eleventh cannot
 * see the first, so he cannot tell whether he has contradicted himself, and a
 * manager reviewing it has to remember rather than read.
 *
 * **A TICK IS NOT AN ANSWER WHERE A COLUMN EXISTS, and that is the whole
 * argument for the layout below.** Eight of the twelve shop conditions and all
 * thirty of the distributor ones are satisfied by a VALUE — `lead_competitor`,
 * `lead_monthly_volume_litres`, `distributor_profiles.active_dealer_count` —
 * and the gate reads those columns rather than a checkbox beside them. Drawn as
 * ticks they would be a checklist somebody can complete without answering
 * anything and then be refused by a gate reading the fields. So every
 * value-backed condition is drawn WITH ITS FIELD INLINE: an empty box under a
 * condition is visibly the wrong state rather than an invisible one, and there
 * is no tick to put beside it.
 *
 * (AGENTS.md names four of these. The engine reads eight, because credit days,
 * the decision maker and the application became columns after that paragraph
 * was written. The screen follows the ENGINE — a screen that followed the prose
 * would draw a tick over a column, which is the exact state both exist to stop.
 * The four that remain are genuine ticks: price discussed, delivery discussed,
 * they agreed to test, the next step is agreed. Nothing is stored about those
 * but that somebody says they happened, and inventing a column to hold a
 * sentence nobody asked for would be worse than the tick.)
 *
 * **The list comes from `checklistFor`, which is what the GATE refuses on.** Not
 * a copy: a screen holding its own is how somebody ticks to the bottom and is
 * refused anyway, which is the failure that makes people stop trusting a
 * checklist at all. The verdict at the top is `gateTo`'s, computed on the
 * server, and this screen never re-derives one.
 * ------------------------------------------------------------------------- */

/** Where an answer is stored, which decides which action writes it. */
type Target = "prospect" | "tick" | "profile";

type FieldKind = "text" | "long" | "int" | "litres" | "money" | "bool" | "date" | "product";

type FieldSpec = {
  target: Target;
  key: string;
  kind: FieldKind;
  /** The unit or the shape of the answer, under the box. Never a placeholder. */
  hint?: string;
};

/**
 * Condition id → the column that answers it.
 *
 * Read off `lead-gates.ts` one condition at a time rather than guessed at from
 * the names: `competitor_identified` is satisfied by `lead_competitor` and
 * `monthly_requirement` by `lead_monthly_volume_litres`, and neither pairing is
 * derivable from the id. A condition MISSING from this map is drawn as a bare
 * tick, which is the safe direction — a tick where a column existed is a weaker
 * record, and a column named wrongly writes an answer into the wrong place.
 */
const SHOP_FIELDS: Record<string, FieldSpec[]> = {
  /* The one condition with two halves: the gate wants the NUMBER and the tick
     that somebody checked it, because a GSTIN typed off a letterhead and a
     GSTIN verified against the portal are different assertions. */
  gst_verified: [
    { target: "prospect", key: "gstin", kind: "text", hint: "15 characters, as printed" },
    { target: "tick", key: "gst_verified", kind: "bool", hint: "Checked against the portal" },
  ],
  monthly_requirement: [
    { target: "prospect", key: "monthlyLitres", kind: "litres", hint: "Litres a month" },
  ],
  monthly_potential: [
    {
      target: "prospect",
      key: "potentialPaise",
      kind: "money",
      hint: "Somebody's estimate of a month, and it is stored as a judgement with a date on it",
    },
  ],
  required_product: [{ target: "prospect", key: "requiredProductId", kind: "product" }],
  competitor_identified: [
    { target: "prospect", key: "competitor", kind: "text", hint: "Whose product, in their words" },
  ],
  credit_days: [{ target: "prospect", key: "creditDaysWanted", kind: "int", hint: "Days" }],
  decision_maker: [
    { target: "prospect", key: "decisionMaker", kind: "text", hint: "Who signs off a purchase" },
  ],
  application_understood: [
    {
      target: "prospect",
      key: "application",
      kind: "long",
      hint: "What they will use it on. A trial nobody can judge is stock given away.",
    },
  ],
};

const DISTRIBUTOR_FIELDS: Record<string, FieldSpec[]> = {
  gst_verified: [{ target: "profile", key: "gstVerified", kind: "bool" }],
  pan_verified: [
    { target: "profile", key: "panNumber", kind: "text", hint: "Ten characters" },
    { target: "profile", key: "panVerified", kind: "bool", hint: "Checked, not merely collected" },
  ],
  address_verified: [{ target: "profile", key: "businessAddressVerified", kind: "bool" }],
  business_type: [{ target: "profile", key: "businessType", kind: "text" }],
  years_in_business: [{ target: "profile", key: "yearsInBusiness", kind: "int", hint: "Years" }],
  decision_maker: [{ target: "profile", key: "decisionMaker", kind: "text" }],

  dealer_network: [{ target: "profile", key: "hasDealerNetwork", kind: "bool" }],
  active_dealers: [
    {
      target: "profile",
      key: "activeDealerCount",
      kind: "int",
      hint: "Actually active, not on a list",
    },
  ],
  territory_covered: [{ target: "profile", key: "territoryCovered", kind: "text" }],
  cities_covered: [{ target: "profile", key: "citiesCovered", kind: "long" }],
  sales_team: [{ target: "profile", key: "salesTeamSize", kind: "int", hint: "People selling" }],
  delivery_capability: [{ target: "profile", key: "deliveryCapability", kind: "long" }],
  warehouse: [{ target: "profile", key: "hasWarehouse", kind: "bool" }],
  storage_capacity: [
    { target: "profile", key: "storageCapacityLitres", kind: "litres", hint: "Litres" },
  ],

  product_portfolio: [{ target: "profile", key: "productPortfolio", kind: "long" }],
  competitor_brands: [{ target: "profile", key: "competitorBrands", kind: "long" }],
  monthly_potential: [{ target: "profile", key: "monthlyPotentialPaise", kind: "money" }],
  initial_order_potential: [
    { target: "profile", key: "initialOrderPotentialPaise", kind: "money" },
  ],
  investment_capacity: [{ target: "profile", key: "investmentCapacityPaise", kind: "money" }],
  expected_monthly_purchase: [
    { target: "profile", key: "expectedMonthlyPurchasePaise", kind: "money" },
  ],
  credit_days_required: [
    { target: "profile", key: "creditDaysRequired", kind: "int", hint: "Days" },
  ],
  credit_limit_required: [{ target: "profile", key: "creditLimitRequiredPaise", kind: "money" }],

  proposed_territory: [{ target: "profile", key: "proposedTerritory", kind: "long" }],
  existing_checked: [{ target: "profile", key: "existingDistributorChecked", kind: "bool" }],
  conflict_checked: [
    { target: "profile", key: "territoryConflict", kind: "bool", hint: "Is there a clash?" },
    { target: "profile", key: "territoryConflictNote", kind: "long", hint: "What the clash is" },
  ],
  exclusivity: [{ target: "profile", key: "exclusivityRequested", kind: "bool" }],

  initial_stock: [{ target: "profile", key: "initialStockCommitmentPaise", kind: "money" }],
  monthly_commitment: [{ target: "profile", key: "monthlyPurchaseCommitmentPaise", kind: "money" }],
  dealer_development: [{ target: "profile", key: "dealerDevelopmentCommitment", kind: "long" }],
  expected_start: [{ target: "profile", key: "expectedStartDate", kind: "date" }],
};

const GROUP_TITLE: Record<string, string> = {
  legal: "Business and legal",
  capability: "Distribution capability",
  commercial: "Commercial capability",
  territory: "Territory",
  commitment: "Commitment",
};

/**
 * Every stored answer, flattened onto one map.
 *
 * The three targets are an implementation detail of WHERE an answer is written,
 * and this screen asks one question of one map. The page builds it: the §6
 * columns keyed as `saveProspectFields` keys them, the checklist ticks keyed on
 * their own condition id, and the distributor profile merged in.
 */
export type QualifyValues = Record<string, string | number | boolean | null>;

export function QualifyScreen({
  customerId,
  leadName,
  detail,
  salesType,
  stage,
  conditions,
  verdict,
  opensRung,
  values,
  profile,
  requiredProductName,
  canWork,
}: {
  customerId: string;
  leadName: string;
  detail: string;
  salesType: "direct" | "third_party" | "distributor" | null;
  stage: LeadStage;
  /** `checklistFor`'s own list. Never a copy typed into this screen. */
  conditions: readonly Condition[];
  /** `gateTo`'s verdict for the rung this checklist opens, from the server. */
  verdict: GateVerdict | null;
  opensRung: LeadStage | null;
  values: QualifyValues;
  profile: DistributorProfile | null;
  requiredProductName: string | null;
  canWork: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const distributor = salesType === "distributor";
  const fieldMap = distributor ? DISTRIBUTOR_FIELDS : SHOP_FIELDS;

  const stored = React.useMemo<QualifyValues>(
    () => ({ ...values, ...((profile ?? {}) as QualifyValues) }),
    [values, profile],
  );

  /* Only what somebody has TOUCHED is sent. A patch of everything on screen
     would overwrite an answer established last week with whatever this form
     happens to hold, and several of these are asked across two visits. */
  const [draft, setDraft] = React.useState<Record<string, string | boolean | null>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function set(key: string, value: string | boolean | null) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function current(spec: FieldSpec): string | boolean | null {
    if (spec.key in draft) return draft[spec.key];
    const v = stored[spec.key];
    if (v === null || v === undefined) return spec.kind === "bool" ? null : "";
    if (spec.kind === "bool") return Boolean(v);
    /* Paise in, rupees on the screen. `money()` is the only formatter and it
       is for reading; a box somebody types into needs the bare number. */
    if (spec.kind === "money") return String(Math.round(Number(v) / 100));
    return String(v);
  }

  function tickValue(id: string): boolean {
    const v = id in draft ? draft[id] : stored[id];
    return v === true;
  }

  /** Answered by the same reading the gate uses: a value, not a mark. */
  function answered(c: Condition): boolean {
    const specs = fieldMap[c.id];
    if (!specs) return tickValue(c.id);
    return specs.every((s) => {
      const v = current(s);
      /* A stated NO is an answer. A candidate with no godown has answered the
         question and one nobody asked has not, which is the distinction a
         checkbox cannot hold and the reason the control below has three
         states. `verdict.missing` remains the authority on what BLOCKS; this
         only decides what is drawn as done. */
      if (s.kind === "bool") return v !== null && v !== undefined;
      return typeof v === "string" && v.trim().length > 0;
    });
  }

  const missingIds = new Set((verdict?.missing ?? []).map((m) => m.id));
  const specsByKey = React.useMemo(() => {
    const out = new Map<string, FieldSpec>();
    for (const list of Object.values(fieldMap)) for (const s of list) out.set(s.key, s);
    return out;
  }, [fieldMap]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const prospect: Record<string, unknown> = {};
      const ticks: Record<string, boolean | string> = {};
      const patch: Record<string, unknown> = {};

      for (const [key, raw] of Object.entries(draft)) {
        const spec = specsByKey.get(key);
        if (!spec) {
          /* A bare tick, keyed on the condition id itself. */
          ticks[key] = raw === true;
          continue;
        }
        const value = coerce(spec, raw);
        if (spec.target === "prospect") prospect[key] = value;
        else if (spec.target === "profile") patch[key] = value;
        else ticks[key] = raw === true;
      }

      /*
       * The three patches are assembled by key because the FIELD MAP is what
       * decides where an answer lands, and a map cannot be a typed literal. The
       * casts name the action's own parameter type rather than silencing the
       * compiler with `never` — a cast that quiets an error across a naming
       * boundary is the bug and not the fix, and every one of these keys is
       * checked again by the action's own schema before a row is written.
       */
      const results = [];
      if (Object.keys(prospect).length) {
        results.push(
          await saveProspectFields(
            customerId,
            prospect as Parameters<typeof saveProspectFields>[1],
          ),
        );
      }
      if (Object.keys(ticks).length) {
        results.push(await saveLeadQualification(customerId, ticks));
      }
      if (Object.keys(patch).length) {
        results.push(await saveDistributorProfile(customerId, patch as DistributorProfilePatch));
      }

      if (!results.length) {
        setError("Nothing has been changed yet.");
        return;
      }
      const failed = results.find((r) => !r.ok);
      if (failed && !failed.ok) {
        setError(failed.error);
        return;
      }
      setDraft({});
      toast.push("Saved.");
      router.refresh();
    } finally {
      /* Cleared whatever happened, so a rejected promise cannot leave the
         button dead until somebody reloads the page. */
      setBusy(false);
    }
  }

  const dirty = Object.keys(draft).length;

  return (
    <div className="p-6">
      <ScreenHeader
        title="Qualification"
        subtitle={
          <>
            <Link href={`/sales/leads/${customerId}`} className="no-underline">
              {leadName}
            </Link>
            {detail ? ` · ${detail}` : ""} · {salesTypeLabel(salesType)} · {stageLabel(stage)}
          </>
        }
        actions={
          <Link
            href={`/sales/leads/${customerId}`}
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ← Back to the record
          </Link>
        }
      />

      {conditions.length === 0 ? (
        <Empty
          title="Nothing to qualify on this ladder"
          body="This lead was raised before the funnel existed, so it climbs the six rungs it was raised on and no checklist applies to it. Nothing backfills a sales type — guessing which of three ladders somebody was on is a decision dressed up as a migration, and the ladder is what decides which gates apply."
          action={
            <Link
              href={`/sales/leads/${customerId}`}
              className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
            >
              Back to the record
            </Link>
          }
        />
      ) : (
        <>
          {verdict && opensRung ? (
            verdict.open ? (
              <Banner
                tone="info"
                title={`Everything this asks for is answered — ${stageLabel(opensRung)} is open`}
                body="The move itself is made on the record, where the ladder is."
              />
            ) : (
              <Banner
                tone="warn"
                title={`${plural(verdict.missing.length, "thing")} still to do before ${stageLabel(opensRung)}`}
                body={
                  <ul className="m-0 mt-0.5 list-none p-0">
                    {verdict.missing.map((m) => (
                      <li key={m.id}>· {m.says}</li>
                    ))}
                  </ul>
                }
              />
            )
          ) : null}

          <p className="mb-3 max-w-[760px] text-[13px] text-pretty text-muted">
            {conditions.filter(answered).length} of {conditions.length} answered. This is the same
            list the gate refuses on, so there is no way to finish it and still be turned down —
            and every condition with a column behind it is drawn with its field rather than a box
            to tick, because a tick beside an empty field is the state this engine exists to stop.
          </p>

          {groupsOf(conditions).map(([group, list]) => (
            <section
              key={group ?? "all"}
              className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4"
            >
              {group ? (
                <div className="mb-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  {GROUP_TITLE[group] ?? group}
                </div>
              ) : null}

              <div className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-2">
                {list.map((c) => {
                  const specs = fieldMap[c.id];
                  const ok = answered(c);
                  const blocking = missingIds.has(c.id);
                  return (
                    <div
                      key={c.id}
                      className={cx(
                        "border-l-[3px] pl-3",
                        ok ? "border-success" : blocking ? "border-warn" : "border-divider",
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[14px] font-medium text-ink">{c.says}</span>
                        {blocking ? <Pill tone="warn">Holding the gate</Pill> : null}
                      </div>

                      {!specs ? (
                        <label className="mt-1.5 flex cursor-pointer items-start gap-2 text-[13px] text-body">
                          <input
                            type="checkbox"
                            className="mt-[3px] h-[15px] w-[15px] accent-[#6835FB]"
                            disabled={!canWork}
                            checked={tickValue(c.id)}
                            onChange={(e) => set(c.id, e.target.checked)}
                          />
                          <span>
                            Yes — this was done. Nothing is stored about it but that somebody says
                            so, which is all there is to store.
                          </span>
                        </label>
                      ) : (
                        <div className="mt-1.5 flex flex-col gap-2">
                          {specs.map((s) => (
                            <FieldControl
                              key={s.key}
                              spec={s}
                              value={current(s)}
                              disabled={!canWork}
                              customerId={customerId}
                              productName={s.kind === "product" ? requiredProductName : null}
                              onChange={(v) => set(s.key, v)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}

          {error ? (
            <p className="mb-3 text-[13px] text-danger" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              tone="primary"
              disabled={!canWork || busy || !dirty}
              title={
                !canWork
                  ? "Working a lead is the salesman's and the manager's. Yours is not one of the hats that carries it."
                  : !dirty
                    ? "Nothing has been changed yet."
                    : undefined
              }
              onClick={save}
            >
              {busy ? "Saving…" : dirty ? `Save ${plural(dirty, "answer")}` : "Save"}
            </Button>
            <span className="max-w-[560px] text-[13px] text-pretty text-muted">
              Only what has been changed is sent. Several of these are asked on a second visit, and
              a form that posted everything on screen would erase what somebody established last
              week.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ parts */

/** §11's five groups, in the order the conditions already carry. */
function groupsOf(conditions: readonly Condition[]): Array<[string | null, Condition[]]> {
  const out: Array<[string | null, Condition[]]> = [];
  for (const c of conditions) {
    const key = c.group ?? null;
    const last = out[out.length - 1];
    if (last && last[0] === key) last[1].push(c);
    else out.push([key, [c]]);
  }
  return out;
}

/**
 * Money arrives as RUPEES and leaves as paise; a litre is a litre.
 *
 * The conversion is here rather than at each call site because there are seven
 * money fields on the distributor form, and one of them getting it wrong is a
 * credit limit a hundred times too large sitting on the row that decides
 * whether an appointment needs a second signature.
 */
function coerce(spec: FieldSpec, raw: string | boolean | null): unknown {
  if (spec.kind === "bool") return raw === true;
  const text = typeof raw === "string" ? raw.trim() : "";
  /* Empty means "answered as nothing" and is written as null. It is a
     different instruction from leaving the field out of the patch, which means
     "not answered on this form", and a form that could only express the second
     would leave a competitor named in error on the record for ever. */
  if (!text) return null;
  if (spec.kind === "money") return parseRupees(text);
  if (spec.kind === "int" || spec.kind === "litres") {
    const n = Number(text);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return text;
}

function FieldControl({
  spec,
  value,
  disabled,
  customerId,
  productName,
  onChange,
}: {
  spec: FieldSpec;
  value: string | boolean | null;
  disabled: boolean;
  customerId: string;
  productName: string | null;
  onChange: (v: string | boolean | null) => void;
}) {
  if (spec.kind === "bool") {
    /*
     * THREE STATES, because two of them are not the same. "Not answered" and
     * "no" are different facts — a candidate with no godown has answered the
     * question and a candidate nobody has asked has not. A checkbox can say two
     * of the three, and the one it loses is the one the gate is about.
     */
    return (
      <div className="flex flex-wrap items-center gap-3">
        {[
          { v: true, label: "Yes" },
          { v: false, label: "No" },
        ].map((o) => (
          <label
            key={String(o.v)}
            className="flex cursor-pointer items-center gap-1.5 text-[13px] text-body"
          >
            <input
              type="radio"
              className="h-[14px] w-[14px] accent-[#6835FB]"
              disabled={disabled}
              checked={value === o.v}
              onChange={() => onChange(o.v)}
            />
            {o.label}
          </label>
        ))}
        {value === null || value === undefined ? (
          <span className="text-[12px] text-muted">Nobody has answered this</span>
        ) : null}
        {spec.hint ? <span className="text-[12px] text-muted">{spec.hint}</span> : null}
      </div>
    );
  }

  if (spec.kind === "product") {
    return (
      <ProductField
        customerId={customerId}
        productId={typeof value === "string" && value ? value : null}
        productName={productName}
        disabled={disabled}
        onPick={(id) => onChange(id)}
      />
    );
  }

  const text = typeof value === "string" ? value : "";
  const rupees = spec.kind === "money" ? parseRupees(text) : null;

  return (
    <div>
      {spec.kind === "long" ? (
        <Textarea
          rows={2}
          disabled={disabled}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          type={spec.kind === "date" ? "date" : "text"}
          inputMode={
            spec.kind === "int" || spec.kind === "litres" || spec.kind === "money"
              ? "numeric"
              : undefined
          }
          disabled={disabled}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {spec.kind === "money" ? (
        <span className="mt-0.5 block text-[12px] text-muted">
          Rupees{spec.hint ? ` — ${spec.hint}` : ""}
          {rupees != null ? ` · ${money(rupees)}` : ""}
        </span>
      ) : spec.hint ? (
        <span className="mt-0.5 block text-[12px] text-muted">{spec.hint}</span>
      ) : null}
    </div>
  );
}

/**
 * Which of ours they need, searched rather than listed.
 *
 * Two hundred SKUs is a search box's job and not a list's — the catalogue is
 * never shipped to the browser, so this asks `/api/product-search` a keystroke
 * at a time exactly as the order form does. The name already on the lead is
 * kept and shown, so a picker nobody has searched yet still says what the
 * answer currently is rather than reading as empty.
 *
 * An empty list means THREE different things and says which: still searching,
 * nothing matched, and nothing typed yet. A list that means "wait" and one that
 * means "we do not sell that" must never look alike.
 */
function ProductField({
  customerId,
  productId,
  productName,
  disabled,
  onPick,
}: {
  customerId: string;
  productId: string | null;
  productName: string | null;
  disabled: boolean;
  onPick: (id: string | null) => void;
}) {
  const [query, setQuery] = React.useState("");
  /*
   * THE RESULT CARRIES THE QUERY IT ANSWERS, which is what lets everything
   * below be derived rather than stored.
   *
   * The obvious shape is `rows` plus a `state`, cleared in an effect whenever
   * the box is emptied. The React Compiler lint refuses that and is right to:
   * a `setState` in an effect body is a second render on every keystroke, and
   * this one ran on a component inside a twelve-condition form. Worse, it is a
   * copy of a fact the query string already holds — "there is nothing to show
   * because nobody has typed two characters" is not state, it is arithmetic.
   *
   * Keeping the query beside its rows also fixes the flicker for free: a
   * result for "thin" is not shown under "thinner", because the two strings do
   * not match, so it reads as still searching rather than as a wrong answer.
   */
  const [result, setResult] = React.useState<{
    query: string;
    rows: Array<{ productId: string; displayName: string; subtitle: string | null }>;
  } | null>(null);
  const [pickedName, setPickedName] = React.useState<string | null>(productName);

  const q = query.trim();
  const searching = q.length >= 2;
  const rows = result && result.query === q ? result.rows : [];
  const state: "idle" | "searching" | "done" = !searching
    ? "idle"
    : result?.query === q
      ? "done"
      : "searching";

  React.useEffect(() => {
    if (q.length < 2) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/product-search?q=${encodeURIComponent(q)}&customerId=${encodeURIComponent(customerId)}`,
        );
        const body = (await res.json()) as {
          products?: Array<{ productId: string; displayName: string; subtitle: string | null }>;
        };
        if (live) setResult({ query: q, rows: body.products ?? [] });
      } catch {
        /* A search that did not answer is an empty list for THIS query, and
         * the screen says "nothing matched" rather than sitting on a spinner. */
        if (live) setResult({ query: q, rows: [] });
      }
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, customerId]);

  return (
    <div>
      <div className="mb-1 text-[13px] text-body">
        {pickedName ? (
          <>
            <span className="font-medium text-ink">{pickedName}</span>
            {disabled ? null : (
              <button
                type="button"
                className="ml-2 cursor-pointer border-0 bg-transparent p-0 text-[12px] text-muted underline"
                onClick={() => {
                  setPickedName(null);
                  onPick(null);
                }}
              >
                change
              </button>
            )}
          </>
        ) : (
          <span className="text-muted">
            {productId
              ? "A product is set on this lead that the catalogue could not name."
              : "Nothing chosen"}
          </span>
        )}
      </div>

      {pickedName ? null : (
        <>
          <Input
            disabled={disabled}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search the catalogue"
          />
          <div className="mt-1 text-[12px] text-muted">
            {query.trim().length < 2
              ? "Type two letters to search the catalogue."
              : state === "searching"
                ? "Searching…"
                : rows.length === 0
                  ? "Nothing in the catalogue matched that."
                  : plural(rows.length, "match", "matches")}
          </div>
          {rows.length ? (
            <ul className="mt-1 mb-0 max-h-[180px] list-none overflow-y-auto rounded-[4px] border border-line p-0">
              {rows.map((r) => (
                <li key={r.productId} className="border-b border-divider last:border-b-0">
                  <button
                    type="button"
                    className="w-full cursor-pointer border-0 bg-transparent px-2.5 py-1.5 text-left hover:bg-canvas"
                    onClick={() => {
                      setPickedName(r.displayName);
                      onPick(r.productId);
                      setQuery("");
                    }}
                  >
                    <span className="block text-[13px] text-ink">{r.displayName}</span>
                    {r.subtitle ? (
                      <span className="block text-[12px] text-muted">{r.subtitle}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}
