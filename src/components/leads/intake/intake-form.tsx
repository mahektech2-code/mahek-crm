"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Field, Input, Select, Textarea, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { offeredSalesTypes, salesTypeLabel, type LeadSalesType } from "@/lib/lead-labels";
import { captureLead } from "@/lib/actions/lead-intake";
import type {
  LeadSourceOption,
  NextActionOwner,
} from "@/lib/services/lead-intake-service";
import { Banner, Button, Pill, ScreenHeader } from "@/components/console/parts";
import { plural } from "@/components/console/words";

/* ---------------------------------------------------------------------------
 * Screen 5's form.
 *
 * It is a PAGE and not a modal. Fourteen fields in a dialog is a form people
 * abandon half way through — and the half they abandon is the half below the
 * fold, which here is the next action, which is the one §24 will not let a
 * lead live without.
 *
 * **THE SALES TYPE IS ASKED FIRST AND ALONE.** Not as the first field of a long
 * form, but as the whole of the screen until it is answered, because it decides
 * which LADDER the lead climbs and therefore which gates will apply to it for
 * the rest of its life. Asked as field one of fourteen it is a dropdown people
 * tab past; asked alone it is a question people answer.
 *
 * **"Not decided yet" is on that list deliberately.** Null is the fourth
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
  sources,
  sourceOptions,
  owners,
  today,
  requireNextAction,
  canWork,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  sources: LeadSourceOption[];
  /** The configured ten. A picker, not a suggestion — see the block below. */
  sourceOptions: { code: string; label: string }[];
  owners: NextActionOwner[];
  /** Asia/Kolkata, resolved on the server — never read from a browser clock. */
  today: string;
  requireNextAction: boolean;
  canWork: boolean;
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
    ownerId: "",
    notes: "",
    nextAction: "",
    nextActionDate: today,
    nextActionOwnerId: "",
    nextActionOutcome: "",
  });

  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  async function submit(allowDuplicate: boolean) {
    setBusy(true);
    setErrors({});
    try {
      const litres = f.monthlyLitres.replace(/[\s,]/g, "");
      const result = await captureLead({
        salesType: answer === "undecided" || answer === null ? null : answer,
        name: f.name,
        companyName: f.companyName || undefined,
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
        requirement: f.requirement || undefined,
        application: f.application || undefined,
        ownerId: f.ownerId || null,
        notes: f.notes || undefined,
        nextAction: f.nextAction
          ? {
              action: f.nextAction,
              date: f.nextActionDate,
              ownerId: f.nextActionOwnerId,
              outcome: f.nextActionOutcome || undefined,
            }
          : undefined,
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

  if (done) {
    return (
      <div>
        <ScreenHeader
          title="Lead raised"
          subtitle={`${done.name} is on the book, at the foot of the ladder that was chosen. What happens to it next is whatever was owed on it — which is §24's whole point, and why this form asks for one in the same breath as the lead.`}
        />
        <Card className="p-6">
          <div className="flex flex-wrap gap-2">
            <Link
              href={leadHref(workspace, `leads/${done.id}`)}
              className="inline-flex h-9 items-center rounded-[4px] border border-brand bg-brand px-4 text-sm font-medium text-white no-underline hover:bg-brand-hover hover:no-underline"
            >
              Open the lead
            </Link>
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
                setF((s) => ({
                  ...s,
                  name: "",
                  companyName: "",
                  contactPerson: "",
                  phone: "",
                  address: "",
                  monthlyLitres: "",
                  competitor: "",
                  requirement: "",
                  application: "",
                  notes: "",
                  nextAction: "",
                  nextActionOutcome: "",
                }));
              }}
            >
              Raise another
            </Button>
            <Link
              href={leadHref(workspace, "leads")}
              className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
            >
              All leads
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <ScreenHeader
        title="Capture a lead"
        subtitle="Somebody rang, or a form came in. This is where that becomes a record instead of a note in a book — and it is the only way into the funnel that does not need a handset or a spreadsheet."
        actions={
          <Link
            href={leadHref(workspace, "leads/intake/bulk")}
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            A whole file of them
          </Link>
        }
      />

      {!canWork ? (
        <Banner
          tone="danger"
          title="You cannot raise a lead"
          body="Capturing one takes the lead.work capability, which every telecaller and field salesman holds. The form below is drawn so you can see what it asks; the save will be refused."
        />
      ) : null}

      {/* ───────────────────────────────── step one, and nothing else with it */}
      <Card className="mb-4 p-6">
        <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          First, and on its own
        </div>
        <h2 className="text-lg font-semibold text-ink">How would we sell to them?</h2>
        <p className="mt-1 max-w-[720px] text-[13px] text-pretty text-muted">
          This decides which ladder the lead climbs, and therefore which gates it
          has to pass on the way up. It is asked before anything else because a
          lead half way up the distributor ladder does not become a shop later by
          somebody tapping a different chip.
        </p>

        {/*
          OFFERED rather than all of them, and Distributor is the one missing.
          Mahek does not appoint distributors through MahekOne, so starting a
          lead on that ladder parked it behind a nine-step approval nobody in
          the building could complete — see the note on the entry itself in
          `lead-labels.ts`. Leads already on it keep everything they have; this
          list is only about what a lead may be STARTED on.
        */}
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {offeredSalesTypes().map((t) => (
            <button
              key={t.code}
              type="button"
              onClick={() => setAnswer(t.code)}
              className={cx(
                "rounded-[6px] border px-4 py-3 text-left",
                answer === t.code
                  ? "border-brand bg-brand-soft"
                  : "border-line bg-surface hover:bg-canvas",
              )}
            >
              <div className="text-sm font-semibold text-ink">{t.label}</div>
              <div className="mt-0.5 text-[13px] text-muted">{t.hint}</div>
            </button>
          ))}

          {/*
            THE FOURTH ANSWER, and it is a real one. A lead with no sales type
            climbs the original six rungs — `new · contacted · qualified ·
            negotiation · won · lost` — and nothing ever fills one in on its
            behalf. Leaving it off this list would not stop people being unsure;
            it would make them pick the commonest option to get past the screen.
          */}
          <button
            type="button"
            onClick={() => setAnswer("undecided")}
            className={cx(
              "rounded-[6px] border px-4 py-3 text-left",
              answer === "undecided"
                ? "border-brand bg-brand-soft"
                : "border-line bg-surface hover:bg-canvas",
            )}
          >
            <div className="text-sm font-semibold text-ink">Nobody has decided yet</div>
            <div className="mt-0.5 text-[13px] text-muted">
              It climbs the original six rungs until somebody sets one. Nothing
              guesses on your behalf.
            </div>
          </button>
        </div>
      </Card>

      {answer === null ? (
        <Card className="p-6 text-[15px] text-muted">
          The rest of the form opens once that is answered.
        </Card>
      ) : (
        <>
          {duplicate ? (
            <Banner
              tone="danger"
              title="That telephone number is already on the book"
              body={
                <>
                  {duplicate}{" "}
                  <span className="text-muted">
                    Two counters of one business under one number is a real thing;
                    a second record for one shop is not something anybody can undo
                    from a screen.
                  </span>
                </>
              }
              action={
                <Button
                  tone="danger"
                  disabled={busy}
                  title={busy ? "Saving…" : undefined}
                  onClick={() => submit(true)}
                >
                  It is a different shop — raise it anyway
                </Button>
              }
            />
          ) : null}

          <Card className="mb-4 p-6">
            <div className="mb-4 flex items-center gap-2">
              <h2 className="text-lg font-semibold text-ink">Who are they?</h2>
              <Pill tone="brand">
                {answer === "undecided"
                  ? "No ladder chosen"
                  : salesTypeLabel(answer)}
              </Pill>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Shop or business name" error={errors.name}>
                <Input
                  value={f.name}
                  invalid={Boolean(errors.name)}
                  onChange={(e) => set("name")(e.target.value)}
                  placeholder="As it is written above the door"
                />
              </Field>
              <Field
                label="Registered name"
                hint="Where it differs from the name on the shop front."
                error={errors.companyName}
              >
                <Input
                  value={f.companyName}
                  onChange={(e) => set("companyName")(e.target.value)}
                />
              </Field>
              <Field label="Person you spoke to" error={errors.contactPerson}>
                <Input
                  value={f.contactPerson}
                  onChange={(e) => set("contactPerson")(e.target.value)}
                />
              </Field>
              <Field label="Mobile" error={errors.phone}>
                <Input
                  value={f.phone}
                  invalid={Boolean(errors.phone)}
                  onChange={(e) => set("phone")(e.target.value)}
                  placeholder="10 digits"
                  inputMode="tel"
                />
              </Field>
              <Field label="Town" error={errors.city}>
                <Input
                  value={f.city}
                  invalid={Boolean(errors.city)}
                  onChange={(e) => set("city")(e.target.value)}
                />
              </Field>
              <Field
                label="Address"
                hint="What there is of it. A lead has no pin until somebody stands in the shop."
                error={errors.address}
              >
                <Input value={f.address} onChange={(e) => set("address")(e.target.value)} />
              </Field>
            </div>
          </Card>

          <Card className="mb-4 p-6">
            <h2 className="mb-1 text-lg font-semibold text-ink">
              Where did it come from, and what are they?
            </h2>
            <p className="mb-4 max-w-[720px] text-[13px] text-pretty text-muted">
              Ten answers and no eleventh, because the question this list exists
              to answer is which channels actually produce customers &mdash; and
              free text cannot answer it. &ldquo;Website&rdquo;,
              &ldquo;website enquiry&rdquo; and &ldquo;Web&rdquo; are three bars
              on that chart and one channel in real life. If a channel is
              genuinely missing, it is added to the list rather than typed into
              a box: Settings &rarr; Lead sources.
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Source" error={errors.source}>
                <Select
                  value={f.source}
                  onChange={(e) => {
                    set("source")(e.target.value);
                    /* Cleared when the answer moves off Other, so a detail
                       typed and then reconsidered is not saved against a
                       source it does not describe. Nothing is cleared on the
                       SAVED record — see the column's own note. */
                    if (e.target.value !== "other") set("sourceDetail")("");
                  }}
                >
                  <option value="">Pick one&hellip;</option>
                  {sourceOptions.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>

              {/*
                * ONLY UNDER "OTHER", and required there.
                *
                * Mahek asked for it, and the reason is what Other does to a
                * coded list left alone: it is the easiest answer on the
                * dropdown, it costs nothing to pick, and a year later it is
                * the biggest bar on the chart with nothing behind it. Made to
                * cost a sentence it gets picked when it is true — and the
                * sentences are what say which eleventh source is worth adding.
                *
                * Drawn conditionally rather than always-present-and-disabled:
                * a field that is dead on nine answers out of ten is furniture,
                * and people stop reading furniture.
                */}
              {f.source === "other" ? (
                <Field
                  label="Source details"
                  hint="Where did this one actually come from? One line is enough."
                  error={errors.sourceDetail}
                >
                  <Input
                    value={f.sourceDetail}
                    invalid={Boolean(errors.sourceDetail)}
                    onChange={(e) => set("sourceDetail")(e.target.value)}
                    placeholder="A builder on the site next door sent him"
                  />
                </Field>
              ) : null}

              <Field
                label="What kind of account"
                hint="What they ARE in the trade. Not the same question as the ladder above — a dealer can be sold to directly or through a distributor."
                error={errors.customerType}
              >
                <Select
                  value={f.customerType}
                  onChange={(e) => set("customerType")(e.target.value)}
                >
                  <option value="">Not stated</option>
                  {CUSTOMER_TYPES.map((t) => (
                    <option key={t.code} value={t.code}>
                      {t.label} — {t.hint}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Whose lead is it"
                hint="Leave it unassigned if nobody has been given it yet. It is said in words on every team list, which a wrong name is not."
                error={errors.ownerId}
              >
                <Select value={f.ownerId} onChange={(e) => set("ownerId")(e.target.value)}>
                  <option value="">Unassigned</option>
                  {owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {sources.length ? (
              <div className="mt-4 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] tracking-[0.04em] text-muted uppercase">
                  Already in use
                </span>
                {sources.slice(0, 8).map((s) => (
                  <button
                    key={s.source}
                    type="button"
                    onClick={() => set("source")(s.source)}
                    className="rounded-[9px] border border-line bg-surface px-2 py-[3px] text-[12px] text-body hover:bg-canvas"
                  >
                    {s.source} · {s.count}
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-4 text-[13px] text-muted">
                No lead on the book carries a source yet, so there is nothing to
                offer — which is itself the finding screen 6 exists to report.
              </p>
            )}
          </Card>

          <Card className="mb-4 p-6">
            <h2 className="mb-1 text-lg font-semibold text-ink">
              What they told you — all of it optional
            </h2>
            <p className="mb-4 max-w-[720px] text-[13px] text-pretty text-muted">
              These four are what the Prospect gate will want later. They are
              asked here because somebody on the telephone sometimes just says
              them, and they are OPTIONAL because this is a call and not a visit
              — the gate demands them at the rung where they matter, and
              demanding them now loses the lead instead of improving it.
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Monthly requirement, in litres"
                hint="Litres and not cans: there is no SKU yet, so a can is a unit nobody has agreed the size of."
                error={errors.monthlyLitres}
              >
                <Input
                  value={f.monthlyLitres}
                  inputMode="numeric"
                  onChange={(e) => set("monthlyLitres")(e.target.value)}
                />
              </Field>
              <Field label="Who they buy from now" error={errors.competitor}>
                <Input
                  value={f.competitor}
                  onChange={(e) => set("competitor")(e.target.value)}
                />
              </Field>
              <Field
                label="What they want"
                hint="In their own words. Turning “thinner for a spray booth” into a SKU on a call is you guessing for them."
                error={errors.requirement}
              >
                <Input
                  value={f.requirement}
                  onChange={(e) => set("requirement")(e.target.value)}
                />
              </Field>
              <Field label="What they use it on" error={errors.application}>
                <Input
                  value={f.application}
                  onChange={(e) => set("application")(e.target.value)}
                />
              </Field>
            </div>

            <div className="mt-4">
              <Field label="Anything else worth writing down" error={errors.notes}>
                <Textarea
                  rows={3}
                  value={f.notes}
                  onChange={(e) => set("notes")(e.target.value)}
                />
              </Field>
            </div>
          </Card>

          <Card className="mb-4 p-6">
            <h2 className="mb-1 text-lg font-semibold text-ink">
              What happens next{requireNextAction ? "" : " (optional here)"}
            </h2>
            <p className="mb-4 max-w-[720px] text-[13px] text-pretty text-muted">
              {requireNextAction
                ? "Four answers rather than a date: the action, the day, the person, and what that person is expected to come back with. A date alone is how a lead sits for six weeks with everybody assuming somebody else is holding it — which is the state §24 exists to prevent, and it is written in the same breath as the lead itself."
                : "leads.requireNextAction is switched off on this deployment, so this is offered rather than demanded. It is still the difference between a lead somebody is working and a lead somebody remembers."}
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="The action" error={errors["nextAction.action"]}>
                <Input
                  value={f.nextAction}
                  invalid={Boolean(errors["nextAction.action"])}
                  onChange={(e) => set("nextAction")(e.target.value)}
                  placeholder="Ring back and ask for the site address"
                />
              </Field>
              <Field label="On what day" error={errors["nextAction.date"]}>
                <Input
                  type="date"
                  value={f.nextActionDate}
                  onChange={(e) => set("nextActionDate")(e.target.value)}
                />
              </Field>
              <Field
                label="Owed by"
                hint="Somebody who can sign in and see it — the action checks, not just this list."
                error={errors["nextAction.ownerId"]}
              >
                <Select
                  value={f.nextActionOwnerId}
                  onChange={(e) => set("nextActionOwnerId")(e.target.value)}
                >
                  <option value="">Nobody chosen</option>
                  {owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} — {plural(o.owed, "lead")} already owed
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="What they come back with"
                hint="Optional. A call that has not happened does not always have a stated objective."
                error={errors["nextAction.outcome"]}
              >
                <Input
                  value={f.nextActionOutcome}
                  onChange={(e) => set("nextActionOutcome")(e.target.value)}
                />
              </Field>
            </div>
          </Card>

          <div className="flex items-center gap-3">
            <Button
              tone="primary"
              disabled={busy || !canWork}
              title={
                !canWork
                  ? "Raising a lead takes the lead.work capability."
                  : busy
                    ? "Saving…"
                    : undefined
              }
              onClick={() => submit(false)}
            >
              {busy ? "Saving…" : "Raise the lead"}
            </Button>
            <span className="text-[13px] text-muted">
              It lands at{" "}
              {answer === "undecided" ? (
                <strong className="font-medium text-ink">New</strong>
              ) : (
                <strong className="font-medium text-ink">Suspect</strong>
              )}
              , the foot of the ladder you chose.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
