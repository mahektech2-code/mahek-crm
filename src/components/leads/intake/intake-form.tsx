"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Input, Select, cx } from "@/components/ui/primitives";
import { VoiceTextarea } from "@/components/ui/dictate";
import { useToast } from "@/components/ui/toast";
import { offeredSalesTypes, salesTypeLabel, type LeadSalesType } from "@/lib/lead-labels";
import { captureLead } from "@/lib/actions/lead-intake";
import type { NextActionOwner } from "@/lib/services/lead-intake-service";
import { Banner, Button, ScreenHeader } from "@/components/console/parts";
import { useInLeadHub } from "@/components/leads/hub/hub-context";
import { ProductCombobox } from "@/components/products/product-combobox";
import { IntakeAssistant } from "@/components/leads/intake/intake-assistant";
import { cleanDecimal } from "@/lib/format";

/* ---------------------------------------------------------------------------
 * Screen 5's form.
 *
 * It is a PAGE and not a modal. A dialog is a form people abandon half way
 * through, and the half they abandon is whatever sits below the fold.
 *
 * **THE SALES TYPE IS ASKED FIRST AND ALONE.** Not as the first field of a long
 * form, but as the whole of the screen until it is answered, because it decides
 * which LADDER the lead climbs and therefore which gates will apply to it for
 * the rest of its life. Asked as field one of fourteen it is a dropdown people
 * tab past; asked alone it is a question people answer.
 *
 * **"Not Decided" is on that list deliberately.** Null is the fourth
 * answer: a lead with no sales type climbs the original six rungs, and nothing
 * in MahekOne backfills one, because guessing which of three ladders somebody
 * was on is a decision dressed up as a migration. A form that forced a choice
 * would produce exactly that guess, one row at a time, from whoever happened to
 * pick up the telephone.
 *
 * The three hints are `SALES_TYPES`' own, verbatim. They name the chain — who
 * ends up holding the invoice — rather than defining the term, which is what
 * somebody on a call actually needs to tell them apart.
 * ------------------------------------------------------------------------- */

/**
 * What the account IS in the trade, in words.
 *
 * A local map, and it should not be: the stored enum is not a label, and this
 * is the fourth screen in MahekOne that would need these four words. There is
 * no shared map for `customer_type` anywhere — `lead-labels.ts` holds the
 * funnel's whole vocabulary and would be its home, and this module may not edit
 * it. Reported rather than left implicit.
 */
const CUSTOMER_TYPE_CODES = ["dealer", "manufacturer", "distributor", "retailer"] as const;

const CUSTOMER_TYPES: Array<{
  code: (typeof CUSTOMER_TYPE_CODES)[number];
  label: string;
  hint: string;
}> = [
  { code: "dealer", label: "Dealer", hint: "Buys to sell over a counter." },
  { code: "manufacturer", label: "Manufacturer", hint: "Buys to consume in their own process." },
  { code: "distributor", label: "Distributor", hint: "Buys to sell on to others." },
  { code: "retailer", label: "Retailer", hint: "Sells to the public." },
];

type Answer = LeadSalesType | "undecided";

export function IntakeForm({
  workspace,
  sourceOptions,
  owners,
  canWork,
  canPrioritise,
  distributors,
  defaultOwnerId = "",
  productSearchEnabled = true,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  /** The configured ten. A picker, not a suggestion — see the block below. */
  sourceOptions: { code: string; label: string }[];
  owners: NextActionOwner[];
  canWork: boolean;
  /** `lead.verify` — priority is a manager's word, so nobody else is offered it. */
  canPrioritise: boolean;
  /**
   * Who the owner box opens on: the person raising the lead, when they are the
   * kind of person who works one (holds the Calling desk and is not a manager).
   * Empty otherwise, which is "Unassigned" and is said as such.
   */
  defaultOwnerId?: string;
  /**
   * §23's "Under" — who bills this shop, for the third-party ladder only.
   * The same direct-customer candidates `crm/distributor-picker.tsx` already
   * offers, fetched by the page rather than searched here: this is a plain
   * select, not a typeahead.
   */
  distributors: { id: string; name: string; city: string | null }[];
  /**
   * `products.searchOnOrderForms`, read by the page. When it is off the
   * catalogue endpoint answers an empty list for everything, which would read as
   * "we do not sell that" — so the picker is not drawn and the box says so.
   */
  productSearchEnabled?: boolean;
}) {
  const router = useRouter();
  const { push } = useToast();

  const [answer, setAnswer] = React.useState<Answer | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [duplicate, setDuplicate] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<{ id: string; name: string } | null>(null);

  const [f, setF] = React.useState({
    name: "",
    companyName: "",
    /* OPTIONAL when a lead is raised; it becomes required at Prospect. */
    gstin: "",
    contactPerson: "",
    phone: "",
    city: "",
    address: "",
    source: "",
    sourceDetail: "",
    customerType: "",
    monthlyLitres: "",
    competitor: "",
    requirement: "",
    application: "",
    ownerId: defaultOwnerId,
    notes: "",
    priority: "",
    distributorCustomerId: "",
  });

  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  /* "What product they want" is EITHER words OR a product chosen from the
     catalogue, never both: the server stores whichever it is in the one text
     column. The box shows the chosen product's name, and `requirementProductId`
     says that text is a catalogue pick rather than something typed. */
  const [requirementProductId, setRequirementProductId] = React.useState<string | null>(null);

  async function submit(allowDuplicate: boolean) {
    setBusy(true);
    setErrors({});
    try {
      const litres = f.monthlyLitres.replace(/[\s,]/g, "");
      const result = await captureLead({
        workspace,
        salesType: answer === "undecided" || answer === null ? null : answer,
        name: f.name,
        companyName: f.companyName || undefined,
        /* Asked only of a Direct customer (the block below), so a number typed and then
           hidden by switching the sales type is never sent. */
        gstin: answer === "direct" ? f.gstin.trim() || undefined : undefined,
        contactPerson: f.contactPerson || undefined,
        phone: f.phone,
        city: f.city,
        address: f.address || undefined,
        source: f.source,
        sourceDetail: f.sourceDetail.trim() || undefined,
        /* Narrowed rather than cast. A cast across this boundary is how an
           unknown string reaches an enum column and fails at the database. */
        customerType: CUSTOMER_TYPE_CODES.find((c) => c === f.customerType) ?? null,
        monthlyLitres: litres ? Number(litres) : null,
        competitor: f.competitor || undefined,
        requirement: requirementProductId ? undefined : f.requirement || undefined,
        /* Sent as an id only: the server checks it is a live product and
           writes the catalogue's own name, never one the browser typed. */
        requirementProductId: requirementProductId ?? undefined,
        application: f.application || undefined,
        ownerId: f.ownerId || null,
        notes: f.notes || undefined,
        priority: f.priority ? (f.priority as "high" | "medium" | "low") : null,
        /* Meaningful only on the third-party ladder — the field itself is
           not drawn for any other answer, so there is nothing to send. */
        distributorCustomerId:
          answer === "third_party" ? f.distributorCustomerId || null : null,
        allowDuplicate,
      });

      if (result.ok) {
        setDuplicate(null);
        setDone({ id: result.data.customerId, name: f.name });
        if (result.message) push(result.message);
        router.refresh();
        return;
      }

      /* A duplicate is not a validation failure — it is a question, and it is
         the one thing on this screen that cannot be undone if it is answered
         wrongly. So it is drawn as a banner with the way past it on the banner,
         rather than as red text under the telephone box. */
      if (result.code === "duplicate") setDuplicate(result.error);
      else push(result.error, "error");

      const next: Record<string, string> = {};
      for (const fe of result.fieldErrors ?? []) next[fe.field] = fe.message;
      setErrors(next);
    } finally {
      setBusy(false);
    }
  }

  const inHub = useInLeadHub();
  const typeLabel = answer === null ? null : answer === "undecided" ? "Not decided" : salesTypeLabel(answer);

  if (done) {
    return (
      <div className="mx-auto max-w-[860px]">
        <Card className="flex flex-wrap items-center gap-3 p-5">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-ink">Lead added</div>
            <div className="text-[13px] text-muted">{done.name}</div>
          </div>
          {/*
            Cleared in the handler, never in an effect watching a prop — the
            React Compiler rules forbid the second, and the town, the source
            and the owner are deliberately KEPT: somebody raising four leads
            off one call sheet is in one town, from one source, for one person.
          */}
          <Button
            onClick={() => {
              setDone(null);
              setAnswer(null);
              setRequirementProductId(null);
              setF((s) => ({
                ...s,
                name: "",
                companyName: "",
                gstin: "",
                contactPerson: "",
                phone: "",
                address: "",
                monthlyLitres: "",
                competitor: "",
                requirement: "",
                application: "",
                notes: "",
                priority: "",
                distributorCustomerId: "",
              }));
            }}
          >
            Add another
          </Button>
          <Link href={leadHref(workspace, "leads")} className={SECONDARY}>
            All leads
          </Link>
          <Link href={leadHref(workspace, `leads/${done.id}`)} className={PRIMARY}>
            Open the lead
          </Link>
        </Card>
      </div>
    );
  }

  const saveBlocked = !canWork
    ? "Your access does not include adding leads."
    : answer === null
      ? "Pick how we sell to them first."
      : busy
        ? "Saving…"
        : undefined;

  return (
    <div className="mx-auto max-w-[860px]">
      {inHub ? null : (
        <ScreenHeader
          title="New lead"
          actions={
            <Link href={leadHref(workspace, "leads/intake/bulk")} className={SECONDARY}>
              From a file
            </Link>
          }
        />
      )}

      <Card className="overflow-hidden p-0">
        <div className="flex flex-col gap-[22px] px-[22px] py-5">
          {!canWork ? (
            <Banner tone="danger" title="Your access does not include adding leads" />
          ) : null}

          {/*
            THE SALES TYPE IS ASKED FIRST, and the rest of the form waits for
            it — it decides which ladder the lead climbs. OFFERED rather than
            all of them: Distributor is retired for new leads (see
            `lead-labels.ts`). "Not decided" is the fourth, real answer: a
            lead with no sales type climbs the original six rungs.
          */}
          <div
            role="radiogroup"
            aria-label="How we sell to them"
            className="grid grid-cols-1 gap-2.5 sm:grid-cols-3"
          >
            {[
              ...offeredSalesTypes().map((t) => ({
                code: t.code as Answer,
                label: t.label,
                hint: TYPE_HINT[t.code] ?? t.hint,
              })),
              { code: "undecided" as Answer, label: "Not decided", hint: "Set it later" },
            ].map((t) => {
              const on = answer === t.code;
              return (
                <button
                  key={t.code}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setAnswer(t.code)}
                  className={cx(
                    "flex flex-col gap-0.5 rounded-[8px] border px-3.5 py-3 text-left",
                    on
                      ? "border-brand bg-brand-soft shadow-[inset_0_0_0_1px_var(--color-brand)]"
                      : "border-line bg-surface hover:border-line-strong",
                  )}
                >
                  <strong className="text-sm font-semibold text-ink">{t.label}</strong>
                  <span className="text-[13px] text-muted">{t.hint}</span>
                </button>
              );
            })}
          </div>

          {answer === null ? null : (
            <>
              {/*
                THE CUSTOMER'S GST NUMBER — a Direct customer is the one we bill, so
                this is where the number belongs. OPTIONAL here (a first call often
                has none); it becomes REQUIRED when the lead is made a Prospect.
                The one `customers.gstin` column, never a copy.
              */}
              {answer === "direct" ? (
                <section>
                  <SectionTitle>Customer</SectionTitle>
                  <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-3">
                    <F label="GST number" error={errors.gstin}>
                      <Input
                        value={f.gstin}
                        onChange={(e) => set("gstin")(e.target.value)}
                        placeholder="Optional now · needed at Prospect"
                        maxLength={20}
                        invalid={Boolean(errors.gstin)}
                      />
                    </F>
                  </div>
                </section>
              ) : null}
              {duplicate ? (
                <Banner
                  tone="danger"
                  fact
                  title="That mobile number is already on the book"
                  body={duplicate}
                  action={
                    <Button
                      tone="danger"
                      disabled={busy}
                      title={busy ? "Saving…" : undefined}
                      onClick={() => submit(true)}
                    >
                      It is a different shop — add it anyway
                    </Button>
                  }
                />
              ) : null}

              {/*
                THE VOICE ASSISTANT proposes; it does not save. It is handed the
                current text of each box (so it never overwrites one), one setter
                into this form's own state, and whether "Under" is drawn — and
                nothing else: not the sales type, not submit, not the owner, not
                the priority, not the duplicate override.
              */}
              {canWork ? (
                <IntakeAssistant
                  workspace={workspace}
                  offerUnder={answer === "third_party"}
                  current={{
                    name: f.name,
                    contactPerson: f.contactPerson,
                    phone: f.phone,
                    companyName: f.companyName,
                    city: f.city,
                    address: f.address,
                    customerType: f.customerType,
                    monthlyLitres: f.monthlyLitres,
                    competitor: f.competitor,
                    requirement: f.requirement,
                    application: f.application,
                    notes: f.notes,
                    source: f.source,
                    sourceDetail: f.sourceDetail,
                    distributorCustomerId: f.distributorCustomerId,
                  }}
                  onFill={(key, value) => {
                    /* A product chosen from the catalogue wins over words the
                       assistant heard: the box is locked while one is chosen. */
                    if (key === "requirement" && requirementProductId) return;
                    set(key)(value);
                    /* The same rule the Source box applies when it changes. */
                    if (key === "source" && value !== "other") set("sourceDetail")("");
                  }}
                />
              ) : null}

              <section>
                <SectionTitle>Who</SectionTitle>
                <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-3">
                  <F label="Shop name" required error={errors.name} className="sm:col-span-2">
                    <Input
                      value={f.name}
                      invalid={Boolean(errors.name)}
                      onChange={(e) => set("name")(e.target.value)}
                      placeholder="As written above the door"
                    />
                  </F>
                  <F label="Mobile" required error={errors.phone}>
                    <Input
                      value={f.phone}
                      invalid={Boolean(errors.phone)}
                      onChange={(e) => set("phone")(e.target.value)}
                      placeholder="10 digits"
                      inputMode="tel"
                    />
                  </F>
                  <F label="Contact person" error={errors.contactPerson}>
                    <Input
                      value={f.contactPerson}
                      onChange={(e) => set("contactPerson")(e.target.value)}
                    />
                  </F>
                  <F label="Town" required error={errors.city}>
                    <Input
                      value={f.city}
                      invalid={Boolean(errors.city)}
                      onChange={(e) => set("city")(e.target.value)}
                    />
                  </F>
                  <F label="Address" error={errors.address}>
                    <Input
                      value={f.address}
                      onChange={(e) => set("address")(e.target.value)}
                      placeholder="Street, area"
                    />
                  </F>
                  <F label="Registered name" error={errors.companyName}>
                    <Input
                      value={f.companyName}
                      onChange={(e) => set("companyName")(e.target.value)}
                      placeholder="If different"
                    />
                  </F>
                  <F label="Source" required error={errors.source}>
                    <Select
                      value={f.source}
                      onChange={(e) => {
                        set("source")(e.target.value);
                        /* Cleared when the answer moves off Other, so a detail
                           typed and then reconsidered is not saved against a
                           source it does not describe. */
                        if (e.target.value !== "other") set("sourceDetail")("");
                      }}
                    >
                      <option value="">Pick one</option>
                      {sourceOptions.map((o) => (
                        <option key={o.code} value={o.code}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </F>
                  <F label="Owner" error={errors.ownerId}>
                    <Select value={f.ownerId} onChange={(e) => set("ownerId")(e.target.value)}>
                      <option value="">Unassigned</option>
                      {owners.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </Select>
                  </F>
                  {/*
                    §23 — WHO BILLS THIS SHOP, asked only on the ladder it means
                    anything on. A picker, not a permission: the action checks
                    the same eligibility again.
                  */}
                  {answer === "third_party" ? (
                    <F label="Under" error={errors.distributorCustomerId}>
                      <Select
                        value={f.distributorCustomerId}
                        onChange={(e) => set("distributorCustomerId")(e.target.value)}
                      >
                        <option value="">Unassigned</option>
                        {distributors.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                            {d.city ? ` — ${d.city}` : ""}
                          </option>
                        ))}
                      </Select>
                    </F>
                  ) : null}
                  {/* Only under Other, and required there — an empty Other is
                      the biggest bar on the chart a year later. */}
                  {f.source === "other" ? (
                    <F label="Source details" required error={errors.sourceDetail} className="sm:col-span-3">
                      <Input
                        value={f.sourceDetail}
                        invalid={Boolean(errors.sourceDetail)}
                        onChange={(e) => set("sourceDetail")(e.target.value)}
                      />
                    </F>
                  ) : null}
                </div>
              </section>

              <section>
                <SectionTitle>What they need</SectionTitle>
                <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-3">
                  <F label="Business type" error={errors.customerType}>
                    <Select
                      value={f.customerType}
                      onChange={(e) => set("customerType")(e.target.value)}
                    >
                      <option value="">Not stated</option>
                      {CUSTOMER_TYPES.map((t) => (
                        <option key={t.code} value={t.code} title={t.hint}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                  </F>
                  <F label="Litres a month" error={errors.monthlyLitres}>
                    <Input
                      value={f.monthlyLitres}
                      inputMode="decimal"
                      onChange={(e) => set("monthlyLitres")(cleanDecimal(e.target.value))}
                    />
                  </F>
                  <F label="Buying from now" error={errors.competitor}>
                    <Input
                      value={f.competitor}
                      onChange={(e) => set("competitor")(e.target.value)}
                    />
                  </F>
                  <F
                    label="Product"
                    error={errors.requirement ?? errors.requirementProductId}
                    className="sm:col-span-2"
                  >
                    {/*
                      ONE FIELD: the active catalogue to pick from, or words.
                      Typing drops a pick; a pick is stored by NAME in the same
                      column the words go in, and the server writes the
                      catalogue's own spelling. With product search switched
                      off the endpoint answers nothing, so plain words instead.
                    */}
                    {productSearchEnabled ? (
                      <ProductCombobox
                        text={f.requirement}
                        productId={requirementProductId}
                        invalid={Boolean(errors.requirement || errors.requirementProductId)}
                        placeholder="Search Mahek products"
                        onText={(t) => {
                          setRequirementProductId(null);
                          set("requirement")(t);
                        }}
                        onPick={(p) => {
                          setRequirementProductId(p ? p.productId : null);
                          set("requirement")(p ? p.name : "");
                        }}
                      />
                    ) : (
                      <>
                        <Input
                          value={f.requirement}
                          invalid={Boolean(errors.requirement)}
                          onChange={(e) => set("requirement")(e.target.value)}
                          placeholder="What they want"
                        />
                        <div className="mt-1 text-[12px] text-muted">
                          Product search is switched off, so type what they want in your own words.
                        </div>
                      </>
                    )}
                  </F>
                  <F label="Used on" error={errors.application}>
                    <Input
                      value={f.application}
                      onChange={(e) => set("application")(e.target.value)}
                      placeholder="e.g. Furniture polish"
                    />
                  </F>
                  <F
                    label="Note"
                    error={errors.notes}
                    className={canPrioritise ? "sm:col-span-2" : "sm:col-span-3"}
                  >
                    <VoiceTextarea
                      rows={2}
                      value={f.notes}
                      onChange={(e) => set("notes")(e.target.value)}
                      onDictate={set("notes")}
                    />
                  </F>
                  {/* Priority is a manager's word (`lead.verify`). */}
                  {canPrioritise ? (
                    <F label="Priority" error={errors.priority}>
                      <Select value={f.priority} onChange={(e) => set("priority")(e.target.value)}>
                        <option value="">Not set</option>
                        <option value="high">High</option>
                        <option value="medium">Medium</option>
                        <option value="low">Low</option>
                      </Select>
                    </F>
                  ) : null}
                </div>
              </section>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5 border-t border-divider bg-canvas px-[22px] py-4">
          <span className="flex-1 text-[13px] text-muted">
            {/* A lead with no sales type starts on the original ladder's first
                rung; the two offered ladders start at Suspect. */}
            {answer === null ? null : answer === "undecided" ? "Starts at New" : "Starts at Suspect"}
            {typeLabel && answer !== "undecided" ? ` · ${typeLabel}` : null}
          </span>
          <Link href={leadHref(workspace, "leads")} className={SECONDARY}>
            Cancel
          </Link>
          <Button
            tone="primary"
            disabled={Boolean(saveBlocked)}
            title={saveBlocked}
            onClick={() => submit(false)}
          >
            {busy ? "Saving…" : "Add lead"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

const SECONDARY =
  "inline-flex h-9 items-center rounded-[6px] border border-line bg-surface px-3.5 text-sm font-medium text-body no-underline hover:bg-canvas hover:text-ink hover:no-underline";
const PRIMARY =
  "inline-flex h-9 items-center rounded-[6px] border border-brand bg-brand px-4 text-sm font-medium text-white no-underline hover:bg-brand-hover hover:text-white hover:no-underline";

/** Short enough for a card; the full sentence stays on `SALES_TYPES`. */
const TYPE_HINT: Partial<Record<LeadSalesType, string>> = {
  direct: "We bill them",
  third_party: "A distributor bills them",
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 mb-2.5 text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">
      {children}
    </p>
  );
}

/** A labelled control in this form's own, lighter style. */
function F({
  label,
  required = false,
  error,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cx("block min-w-0", className)}>
      <span className="mb-1 block text-[13px] font-medium text-body">
        {label}
        {required ? <span className="ml-0.5 text-danger">*</span> : null}
      </span>
      <span className="block [&>select]:w-full">{children}</span>
      {error ? <span className="mt-1 block text-[12.5px] text-danger">{error}</span> : null}
    </label>
  );
}
