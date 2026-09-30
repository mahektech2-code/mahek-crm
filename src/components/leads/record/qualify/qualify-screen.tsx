"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { money, parseRupees, stamp } from "@/lib/format";
import { cx, Input, Textarea } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { salesTypeLabel, stageLabel, type LeadStage } from "@/lib/lead-labels";
import type { Condition, GateVerdict } from "@/lib/engines/lead-gates";
import { saveLeadQualification, saveProspectFields } from "@/lib/actions/leads";
import { validateGstin } from "@/lib/actions/lead-gst";
import { confirmLeadFigures } from "@/lib/actions/lead-figures";
import { nameLeadDistributor } from "@/lib/actions/lead-distributor-link";
import { resubmitForReview, reviewLeadQualification } from "@/lib/actions/lead-qualification-review";
import {
  saveDistributorProfile,
  type DistributorProfilePatch,
} from "@/lib/actions/distributor-appointment";
import type { DistributorProfile } from "@/lib/services/lead-record-service";
import { Banner, Button, Empty, Pill, ScreenHeader } from "@/components/console/parts";
import { plural } from "@/components/console/words";
import { ProductField } from "@/components/products/product-field";

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
  /** A ceiling for a number box, matching the server's own range. */
  max?: number;
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
  /* GST is a NUMBER the Telecaller writes and a validation the Telecaller also
     records. The validation is NOT a tick: the gate reads `customers.gst_verified`
     (with who and when), so the control for it is a real action further down,
     and this box is only the number. Changing the number clears the validation. */
  gst_verified: [
    { target: "prospect", key: "gstin", kind: "text", hint: "15 characters, as printed. Changing it clears any validation." },
  ],
  application_understood: [
    {
      target: "prospect",
      key: "application",
      kind: "long",
      hint: "What they will use it on. A trial nobody can judge is stock given away.",
    },
  ],
  credit_days: [
    { target: "prospect", key: "creditDaysWanted", kind: "int", hint: "Days, 0 to 365", max: 365 },
  ],
  /* The decision maker is a Prospect answer and is SHOWN, not asked again. What
     this condition wants is the person who PLACES the order, where that is not
     the decision maker — either named, or a statement that it is the same
     person. */
  buyer_confirmed: [
    { target: "prospect", key: "buyer", kind: "text", hint: "Who places the order, if that is not the decision maker" },
    { target: "tick", key: "buyer_confirmed", kind: "bool", hint: "The decision maker also places the order" },
  ],
  /* price_discussed, delivery_discussed, agrees_to_test and next_step_agreed have
     no column: they are genuine ticks, drawn as ticks. The monthly requirement,
     the potential, the product and the competitor are NOT here — they are
     Prospect figures, confirmed as a group below, and the gate stopped asking
     for them at Qualification. */
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

/**
 * §5.3 — what the sales manager has said about this checklist, as it stands.
 *
 * One object rather than four loose props because the four are only ever read
 * together and three of them are meaningless without the first: a note with no
 * verdict is a sentence nobody can place, and a date with no note is a fact
 * about when somebody looked rather than what they found. `verdict` null is a
 * checklist nobody has reviewed, which is most of the book and does NOT block.
 */
export type QualificationReview = {
  verdict: "verified" | "incomplete" | "clarification" | null;
  note: string | null;
  at: Date | string | null;
  byName: string | null;
};

export function QualifyScreen({
  workspace,
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
  review,
  canReview,
  access,
  decisionMaker,
  gst,
  canValidateGst,
  figures,
  thirdParty,
  complete,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
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
  /** §5.3 — the manager's standing verdict, drawn for everybody. */
  review: QualificationReview;
  /**
   * `lead.verify`, resolved on the server. It decides whether the VERDICT
   * control is drawn; it decides nothing about the block, which is enforced by
   * `reviewLeadQualification` and by the gate engine. A hidden control is not a
   * permission.
   */
  canReview: boolean;
  /**
   * WHETHER QUALIFICATION CAN BE WRITTEN AT ALL, from `qualificationAccess` — the
   * same sentence the actions refuse with. At Prospect it is false and every box
   * below is drawn disabled under "waiting for the Sales Manager".
   */
  access: { writable: boolean; reason: string | null };
  /** The Prospect answer, shown so it is not asked again. */
  decisionMaker: string | null;
  gst: { hasNumber: boolean; verified: boolean; at: Date | string | null; byName: string | null };
  /** The two questions `validateGstin` asks, resolved on the server. */
  canValidateGst: boolean;
  figures: {
    litres: number | null;
    potentialPaise: number | null;
    productName: string | null;
    competitor: string | null;
    confirmedAt: Date | string | null;
    confirmedByName: string | null;
    stale: boolean;
  };
  thirdParty: {
    applies: boolean;
    distributors: string[];
    options: { id: string; name: string; city: string | null }[];
  };
  /** Everything the Telecaller owns is answered (the review conditions left out). */
  complete: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  /* Can this person write, HERE, NOW — the capability AND the rung. */
  const editable = canWork && access.writable;

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

  /**
   * DONE IS THE GATE'S ANSWER, not this screen's. A condition is drawn as met
   * only if the server-side verdict says nothing is missing on it — so a box
   * that looks complete while the backend disagrees (the old GST "checked" tick
   * was exactly that) cannot exist. What a person has typed and not saved is the
   * one thing the gate cannot know about, and it is drawn as unsaved rather than
   * as either answer.
   */
  function unsaved(c: Condition): boolean {
    const specs = fieldMap[c.id];
    return (specs ?? [{ key: c.id }]).some((sp) => sp.key in draft);
  }
  function answered(c: Condition): boolean {
    if (unsaved(c)) return false;
    if (verdict) return !(verdict.missing ?? []).some((m) => m.id === c.id);
    return answeredLocally(c);
  }

  /** The old local reading, kept only for the case where no verdict was computed. */
  function answeredLocally(c: Condition): boolean {
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
            <Link href={leadHref(workspace, `leads/${customerId}`)} className="no-underline">
              {leadName}
            </Link>
            {detail ? ` · ${detail}` : ""} · {salesTypeLabel(salesType)} · {stageLabel(stage)}
          </>
        }
        actions={
          <Link
            href={leadHref(workspace, `leads/${customerId}`)}
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
              href={leadHref(workspace, `leads/${customerId}`)}
              className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
            >
              Back to the record
            </Link>
          }
        />
      ) : (
        <>
          {/*
            * THE MANAGER'S VERDICT IS DRAWN FIRST, and above the gate's own
            * banner rather than under it.
            *
            * The gate's sentence says a manager marked this incomplete; it
            * cannot say what he wrote, because `lead-gates.ts` is pure, runs on
            * the handset, and takes the verdict without the note. So a salesman
            * reading only the gate learns that his lead has stopped and not one
            * word about what to do — which is the exact failure the blocking
            * version of this rule had to avoid. Drawn first because it is the
            * answer to the question the banner under it raises.
            */}
          {!access.writable ? (
            <Banner tone="info" title="Qualification is not open yet" body={access.reason} />
          ) : null}

          <ReviewNotice review={review} />

          {editable && complete && (review.verdict === "incomplete" || review.verdict === "clarification") ? (
            <Resubmit customerId={customerId} />
          ) : null}

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

          {canReview && access.writable ? (
            /* Keyed on the verdict that is stored, so a manager who has just
               sent this back gets a REMOUNT with a cleared note box rather than
               an effect resetting one — the React Compiler rules are on and
               resetting state in an effect on a prop change is what they
               forbid. Every dialog and drawer in this codebase does the same. */
            <ReviewPanel
              key={`${review.verdict ?? "none"}-${String(review.at ?? "")}`}
              customerId={customerId}
              review={review}
            />
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

                      {c.id === "buyer_confirmed" && decisionMaker ? (
                        <p className="mt-1 mb-0 text-[12.5px] text-muted">
                          Decision maker on record: <span className="text-ink">{decisionMaker}</span>
                        </p>
                      ) : null}

                      {!specs ? (
                        <label className="mt-1.5 flex cursor-pointer items-start gap-2 text-[13px] text-body">
                          <input
                            type="checkbox"
                            className="mt-[3px] h-[15px] w-[15px] accent-[#6835FB]"
                            disabled={!editable}
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
                              disabled={!editable}
                              customerId={customerId}
                              productName={s.kind === "product" ? requiredProductName : null}
                              onChange={(v) => set(s.key, v)}
                            />
                          ))}
                        </div>
                      )}

                      {c.id === "gst_verified" ? (
                        <GstValidate
                          customerId={customerId}
                          gst={gst}
                          canValidate={canValidateGst && access.writable}
                          numberUnsaved={"gstin" in draft}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}

          {!distributor ? (
            <>
              <FiguresConfirm
                customerId={customerId}
                figures={figures}
                editable={editable}
                stale={(verdict?.missing ?? []).some((m) => m.id === "figures_fresh")}
              />
              {thirdParty.applies ? (
                <DistributorNaming
                  customerId={customerId}
                  thirdParty={thirdParty}
                  editable={editable}
                  needed={(verdict?.missing ?? []).some((m) => m.id === "distributor_named")}
                />
              ) : null}
            </>
          ) : null}

          {error ? (
            <p className="mb-3 text-[13px] text-danger" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              tone="primary"
              disabled={!editable || busy || !dirty}
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

/**
 * §5.3 — what the sales manager said, quoted, for whoever opens this screen.
 *
 * It is drawn for EVERYBODY and not only for the salesman, because a manager
 * coming back to look again needs to read what he wrote last time before he
 * decides whether it has been answered — and a second copy of the note inside
 * the verdict panel below would be the same sentence twice on one screen.
 *
 * A VERIFIED CHECKLIST IS A LINE AND NOT A BANNER. Nothing is being asked of
 * anybody, and a banner that appears when everything is fine is one people
 * learn to scroll past — which costs exactly nothing until the day it is a
 * refusal. The two negatives are `warn` because they are work waiting, and they
 * are the only reason this component exists.
 */
function ReviewNotice({ review }: { review: QualificationReview }) {
  if (!review.verdict) return null;

  const who = [review.byName, review.at ? stamp(review.at) : null].filter(Boolean).join(" · ");

  if (review.verdict === "verified") {
    return (
      <p className="mb-3 text-[13px] text-muted">
        Checklist verified by your sales manager{who ? ` — ${who}` : ""}.
      </p>
    );
  }

  return (
    <Banner
      tone="warn"
      title={
        review.verdict === "incomplete"
          ? "Your sales manager marked this checklist incomplete"
          : "Your sales manager has asked for a clarification"
      }
      body={
        <>
          {review.note ? <span className="block text-ink">“{review.note}”</span> : null}
          <span className="block">
            {who ? `${who}. ` : ""}This lead is held at Qualification until he looks again — answer
            the note above, then ask him to review it.
          </span>
        </>
      }
    />
  );
}

/**
 * The verdict itself, and it lives HERE rather than on the cross-book desk.
 *
 * The desk at `/leads/qualify/checklist` is where a manager chooses WHICH lead
 * to work — it draws a count, a “ticked but empty” tally and the missing
 * conditions joined into one line. None of that is the material a verdict is
 * formed from. Saying a checklist is not finished is a judgement about the
 * twelve ANSWERS, and this is the only screen in the product that draws them:
 * the litres, the competitor's name, the application, each beside the condition
 * it satisfies. A verdict button on a row showing “7 / 12” would be somebody
 * refusing a lead on a number, which is the shape of review Mahek already has
 * and does not want more of. The desk loses nothing by it — the gate's own
 * sentence is already in its “Stuck behind” column the moment a verdict is
 * outstanding, so a manager working the desk sees which leads he has sent back
 * and opens the one he means.
 *
 * `lead.verify` is checked in the action. This only decides what is drawn.
 */
function ReviewPanel({
  customerId,
  review,
}: {
  customerId: string;
  review: QualificationReview;
}) {
  const router = useRouter();
  const toast = useToast();

  /* The stored note is the starting point rather than an empty box: a manager
     looking again usually wants to restate most of what he said and change one
     clause, and retyping it is how the second refusal ends up shorter and
     vaguer than the first. */
  const [note, setNote] = React.useState(review.note ?? "");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const blocked = review.verdict === "incomplete" || review.verdict === "clarification";

  async function send(verdict: "verified" | "incomplete" | "clarification") {
    setBusy(verdict);
    setError(null);
    try {
      const result = await reviewLeadQualification({ customerId, verdict, note });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.push(result.message ?? "Recorded.");
      router.refresh();
    } finally {
      /* Cleared whatever happened, so a rejected promise cannot leave three
         buttons dead until somebody reloads the page. */
      setBusy(null);
    }
  }

  return (
    <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
      <div className="mb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        Your verdict on this checklist
      </div>

      <p className="mb-3 max-w-[760px] text-[13px] text-pretty text-muted">
        Marking it incomplete or asking for a clarification HOLDS the lead at Qualification until
        you look again — it used to be recorded and change nothing, so a checklist could be sent
        back and go to a sample anyway. Either of those needs a sentence saying what is wrong,
        because that sentence is the whole of what the salesman has to work from, and it reaches
        him as a notification rather than waiting for him to open this screen.
      </p>

      <Textarea
        rows={3}
        maxLength={2000}
        className="mb-3 w-full max-w-[760px]"
        value={note}
        disabled={busy !== null}
        onChange={(e) => setNote(e.target.value)}
        aria-label="What the salesman needs to do"
        placeholder="What is missing, or what needs clarifying"
      />

      {error ? (
        <p className="mb-3 text-[13px] text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button tone="primary" disabled={busy !== null} onClick={() => send("verified")}>
          {busy === "verified" ? "Saving…" : blocked ? "Verified — lift the hold" : "Verified"}
        </Button>
        <Button
          tone="danger"
          disabled={busy !== null || !note.trim()}
          title={note.trim() ? undefined : "Say what is not finished — this holds the lead."}
          onClick={() => send("incomplete")}
        >
          {busy === "incomplete" ? "Saving…" : "Not finished"}
        </Button>
        <Button
          disabled={busy !== null || !note.trim()}
          title={note.trim() ? undefined : "Say what needs clarifying — this holds the lead."}
          onClick={() => send("clarification")}
        >
          {busy === "clarification" ? "Saving…" : "Needs a clarification"}
        </Button>
      </div>
    </section>
  );
}

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
          type={
            spec.kind === "date"
              ? "date"
              : spec.kind === "int" || spec.kind === "litres"
                ? "number"
                : "text"
          }
          min={spec.kind === "int" || spec.kind === "litres" ? 0 : undefined}
          max={spec.max}
          step={spec.kind === "int" || spec.kind === "litres" ? 1 : undefined}
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

/* ------------------------------------------------------------- new parts */

function when(at: Date | string | null): string {
  return at ? stamp(at) : "";
}

/**
 * The GST validation — a real act, recorded against a person and a time.
 *
 * The Telecaller who entered the number validates it (there is no self-check
 * any more), through the action that has always written `customers.gst_verified`
 * and the gate reads. There is no tick to put beside it. It is offered only for
 * a number that is SAVED: validating a number still in the box would certify
 * something the record does not hold.
 */
function GstValidate({
  customerId,
  gst,
  canValidate,
  numberUnsaved,
}: {
  customerId: string;
  gst: { hasNumber: boolean; verified: boolean; at: Date | string | null; byName: string | null };
  canValidate: boolean;
  numberUnsaved: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [refusing, setRefusing] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  async function run(valid: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await validateGstin({ customerId, valid, note: valid ? undefined : note });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setRefusing(false);
      setNote("");
      toast.push(r.message ?? "Recorded.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const status = !gst.hasNumber
    ? "Enter the GST number first."
    : gst.verified
      ? `Validated${gst.byName ? ` by ${gst.byName}` : ""}${gst.at ? ` · ${when(gst.at)}` : ""}.`
      : gst.at
        ? `Refused${gst.byName ? ` by ${gst.byName}` : ""} · ${when(gst.at)}. Correct the number and validate it again.`
        : "Not validated yet.";

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={gst.verified ? "success" : "warn"}>{gst.verified ? "Validated" : "Not validated"}</Pill>
        <span className="text-[12.5px] text-muted">{status}</span>
      </div>
      {canValidate && gst.hasNumber && !numberUnsaved ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button tone="primary" disabled={busy} onClick={() => void run(true)}>
            {gst.verified ? "Validate again" : "It checks out"}
          </Button>
          <Button disabled={busy} onClick={() => setRefusing((v) => !v)}>
            It does not check out
          </Button>
        </div>
      ) : numberUnsaved ? (
        <p className="mt-1 mb-0 text-[12.5px] text-muted">Save the number before validating it.</p>
      ) : null}
      {refusing ? (
        <div className="mt-2">
          <Textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="What is wrong with the number"
            placeholder="What is wrong with it"
          />
          <div className="mt-2">
            <Button tone="danger" disabled={busy || !note.trim()} onClick={() => void run(false)}>
              Record the refusal
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="mt-1 mb-0 text-[13px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The four Prospect figures, SHOWN and stood behind — never re-asked.
 *
 * The monthly requirement, the potential, the product and the competitor were
 * captured once, at Prospect. The gate asks for one thing about them at
 * Qualification: that somebody still stands behind them, persisted as
 * `lead_figures_confirmed_at` and the person who confirmed. This is that action
 * and not a local tick — a tick here would look done while `figures_fresh`
 * refused.
 */
function FiguresConfirm({
  customerId,
  figures,
  editable,
  stale,
}: {
  customerId: string;
  figures: {
    litres: number | null;
    potentialPaise: number | null;
    productName: string | null;
    competitor: string | null;
    confirmedAt: Date | string | null;
    confirmedByName: string | null;
    stale: boolean;
  };
  editable: boolean;
  stale: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await confirmLeadFigures({ customerId });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.push(r.message ?? "Confirmed.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          Figures from the Prospect
        </span>
        {stale ? <Pill tone="warn">Holding the gate</Pill> : <Pill tone="success">Current</Pill>}
      </div>
      <dl className="m-0 mb-2 grid grid-cols-1 gap-x-8 gap-y-1 text-[13px] sm:grid-cols-2">
        <div><dt className="inline text-muted">Monthly litres: </dt><dd className="m-0 inline text-ink">{figures.litres ?? "—"}</dd></div>
        <div><dt className="inline text-muted">Potential: </dt><dd className="m-0 inline text-ink">{figures.potentialPaise != null ? money(figures.potentialPaise) : "—"}</dd></div>
        <div><dt className="inline text-muted">Product: </dt><dd className="m-0 inline text-ink">{figures.productName ?? "—"}</dd></div>
        <div><dt className="inline text-muted">Competitor: </dt><dd className="m-0 inline text-ink">{figures.competitor ?? "—"}</dd></div>
      </dl>
      <p className="mb-2 text-[12.5px] text-muted">
        {figures.confirmedAt
          ? `Confirmed${figures.confirmedByName ? ` by ${figures.confirmedByName}` : ""} · ${when(figures.confirmedAt)}.`
          : "Nobody has confirmed these yet."}{" "}
        They were captured at Prospect and are not asked again — only that they still hold.
      </p>
      <Button tone="primary" disabled={!editable || busy} onClick={() => void confirm()}>
        {busy ? "Saving…" : "They still hold"}
      </Button>
      {error ? (
        <p className="mt-2 mb-0 text-[13px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Who invoices this third-party shop — the Telecaller may NAME one, and only
 * that. Editing or removing an arrangement, and converting an account to or from
 * third-party status, stay with the people who hold `customer.classify`.
 */
function DistributorNaming({
  customerId,
  thirdParty,
  editable,
  needed,
}: {
  customerId: string;
  thirdParty: { distributors: string[]; options: { id: string; name: string; city: string | null }[] };
  editable: boolean;
  needed: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pick, setPick] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const r = await nameLeadDistributor({ customerId, distributorId: pick });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setPick("");
      toast.push(r.message ?? "Named.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          Who invoices this shop
        </span>
        {needed ? <Pill tone="warn">Holding the gate</Pill> : <Pill tone="success">Named</Pill>}
      </div>
      <p className="mb-2 text-[13px] text-body">
        {thirdParty.distributors.length
          ? thirdParty.distributors.join(", ")
          : "Nobody is named. A sample cannot go to a counter nobody bills."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={pick}
          disabled={!editable || busy}
          onChange={(e) => setPick(e.target.value)}
          aria-label="Distributor"
          className="h-9 min-w-[240px] rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
        >
          <option value="">Pick an account we invoice…</option>
          {thirdParty.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.city ? ` · ${o.city}` : ""}
            </option>
          ))}
        </select>
        <Button tone="primary" disabled={!editable || busy || !pick} onClick={() => void add()}>
          {busy ? "Saving…" : "Name this distributor"}
        </Button>
      </div>
      <p className="mt-2 mb-0 text-[12px] text-muted">
        Correcting or removing a distributor once named is a manager&rsquo;s or accounts&rsquo;.
      </p>
      {error ? (
        <p className="mt-2 mb-0 text-[13px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * "I have addressed the note" — for a note answered on the phone rather than in a
 * field. Changing an answer sends the lead back for review on its own; a save that
 * changes nothing deliberately does not (that would make every stray click a new
 * review request while the manager's note is still outstanding), so this is the
 * deliberate way to say it.
 */
function Resubmit({ customerId }: { customerId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await resubmitForReview(customerId);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.push(r.message ?? "Sent back.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-3">
      <Button tone="primary" disabled={busy} onClick={() => void send()}>
        {busy ? "Sending…" : "I have addressed the note — ask for review again"}
      </Button>
      <span className="ml-3 text-[12.5px] text-muted">
        Changing an answer does this by itself; use this when the note was answered without changing one.
      </span>
      {error ? (
        <p className="mt-1 mb-0 text-[13px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
