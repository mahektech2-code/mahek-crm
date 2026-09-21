"use client";

/* ---------------------------------------------------------------------------
 * TURNING A READ DOCUMENT INTO A PRICE LIST.
 *
 * This is the one write in the module with consequences a reviewer cannot see
 * from the form: a published list is what the order screen prices from, what a
 * salesman quotes off, and what the variance report measures against. So it is
 * TWO STEPS, and the second is not a confirmation dialog — it is the whole
 * decision said back IN WORDS: how many rates, how many cells left out, the
 * date it takes effect from, what it supersedes and who it applies to.
 *
 * A review nobody reads is a review in name only. The first page is filled in
 * from the header the parser read and the tokens in the filename, because the
 * usual answer should be sitting there already; the second page is where
 * somebody who has been publishing these all afternoon catches the one where
 * the effective date came off the wrong line.
 *
 * "Include the cells worth checking" is off unless there are any. A suggested
 * match is the parser's opinion, and publishing on an opinion is a decision
 * somebody should take deliberately, with the count in front of them.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  Select,
  cx,
} from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { publishDocument } from "@/lib/actions/price-lists";
import {
  DELIVERY_BASIS_LABEL,
  FREIGHT_TERM_LABEL,
  TAX_BASIS_LABEL,
} from "@/lib/price-list-labels";
import type { DocumentView, PricingOptions } from "@/lib/price-list-views";
import type { PriceDeliveryBasis, PriceFreightTerm } from "@/db/schema";
import { longDate, periodLabel } from "@/lib/format";

const DELIVERY_BASES: PriceDeliveryBasis[] = ["for_mumbai", "for_godown", "door_delivery", "ex_factory"];
const FREIGHT_TERMS: PriceFreightTerm[] = ["to_pay", "paid", "not_stated"];

type ScopeDraft = {
  key: string;
  kind: "everybody" | "state" | "customer";
  value: string;
  label: string;
  parentKey: string;
};

type CustomerHitLite = { id: string; name: string; city: string };

export function PublishDocumentModal({
  open,
  onClose,
  basePath,
  document,
  options,
  todayIso,
}: {
  open: boolean;
  onClose: () => void;
  basePath: string;
  document: DocumentView;
  options: PricingOptions;
  todayIso: string;
}) {
  if (!open) return null;
  return (
    <Body
      key={document.id}
      onClose={onClose}
      basePath={basePath}
      document={document}
      options={options}
      todayIso={todayIso}
    />
  );
}

/** "Odisha To Pay — August 2026", from whatever the filename and the header gave up. */
function suggestedName(document: DocumentView): string {
  const hints = document.filenameHints;
  const header = document.header;
  const term = hints?.freightTerm ?? header?.freightTerm ?? null;
  const left = [
    hints?.region ?? hints?.customer ?? null,
    term && term !== "not_stated" ? FREIGHT_TERM_LABEL[term] : null,
  ]
    .filter(Boolean)
    .join(" ");
  const when = hints?.monthIso
    ? periodLabel(hints.monthIso)
    : header?.effectiveFrom
      ? longDate(header.effectiveFrom)
      : null;
  if (left && when) return `${left} — ${when}`;
  if (left) return left;
  if (when) return `Price list — ${when}`;
  return document.filename.replace(/\.[a-z0-9]+$/i, "");
}

function Body({
  onClose,
  basePath,
  document,
  options,
  todayIso,
}: {
  onClose: () => void;
  basePath: string;
  document: DocumentView;
  options: PricingOptions;
  todayIso: string;
}) {
  const router = useRouter();
  const { run } = useToast();
  const header = document.header;
  const hints = document.filenameHints;

  const [step, setStep] = React.useState<1 | 2>(1);
  const [name, setName] = React.useState(suggestedName(document));
  const [refNo, setRefNo] = React.useState(header?.refNo ?? "");
  const [effectiveFrom, setEffectiveFrom] = React.useState(header?.effectiveFrom ?? todayIso);
  const [validityDays, setValidityDays] = React.useState(
    header?.validityDays !== null && header?.validityDays !== undefined ? String(header.validityDays) : "",
  );
  const [taxBasis, setTaxBasis] = React.useState<"inclusive" | "exclusive">(header?.taxBasis ?? "inclusive");
  const [gstBp, setGstBp] = React.useState(header?.gstBp !== null && header?.gstBp !== undefined ? String(header.gstBp) : "");
  const [deliveryBasis, setDeliveryBasis] = React.useState<string>(header?.deliveryBasis ?? "");
  const [freightTerm, setFreightTerm] = React.useState<PriceFreightTerm>(
    hints?.freightTerm ?? header?.freightTerm ?? "not_stated",
  );
  const [signatory, setSignatory] = React.useState(header?.signatory ?? "");
  const [notes, setNotes] = React.useState("");

  const published = options.lists.filter((l) => l.status === "published");
  const [supersedesId, setSupersedesId] = React.useState<string>(() => {
    const tokens = [hints?.region, hints?.customer].filter((t): t is string => !!t).map((t) => t.toLowerCase());
    if (!tokens.length) return "";
    const hit = published.find((l) => tokens.some((t) => l.name.toLowerCase().includes(t)));
    return hit?.id ?? "";
  });

  const [includeSuggested, setIncludeSuggested] = React.useState(document.suggestedCount > 0);
  const [publishNow, setPublishNow] = React.useState(true);

  const [scopes, setScopes] = React.useState<ScopeDraft[]>(() => {
    const region = hints?.region?.toLowerCase() ?? null;
    if (region) {
      const state = options.places.states.find((s) => s.label.toLowerCase() === region);
      if (state) {
        return [{ key: state.key, kind: "state", value: state.key, label: state.label, parentKey: "" }];
      }
    }
    return [{ key: "everybody", kind: "everybody", value: "", label: "Everybody", parentKey: "" }];
  });

  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  const rateCount = document.matchedCount + (includeSuggested ? document.suggestedCount : 0);
  const leftOut = document.rowCount - rateCount;

  function next() {
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = "A list needs a name people will recognise.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) found.effectiveFrom = "That is not a date.";
    if (!scopes.length) found.scopes = "Say who this applies to. Everybody is a real answer.";
    setErrors(found);
    if (Object.keys(found).length === 0) setStep(2);
  }

  async function publish() {
    setBusy(true);
    try {
      const result = await run(
        publishDocument(document.id, {
          name: name.trim(),
          refNo: refNo.trim() || null,
          effectiveFrom,
          validityDays: validityDays.trim() ? Number(validityDays) : null,
          taxBasis,
          gstBp: gstBp.trim() ? Number(gstBp) : undefined,
          deliveryBasis: (deliveryBasis || null) as PriceDeliveryBasis | null,
          freightTerm,
          notes: notes.trim() || null,
          termsText: header?.termsText ?? null,
          signatory: signatory.trim() || null,
          supersedesId: supersedesId || null,
          publishNow,
          includeSuggested,
          scopes: scopes.map((s) => ({
            scopeKind: s.kind,
            scopeValue: s.value,
            scopeLabel: s.label,
            parentKey: s.parentKey,
            freightTermMatch: "any" as const,
          })),
        }),
      );
      if (result.ok) {
        onClose();
        router.push(`${basePath}/${result.data.priceListId}`);
      } else if (result.fieldErrors) {
        setErrors(Object.fromEntries(result.fieldErrors.map((f) => [f.field, f.message])));
        setStep(1);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={step === 1 ? "Publish as a price list" : "Before it goes live"}
      width={640}
      footer={
        step === 1 ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={next}>
              Review
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void publish()}>
              {busy ? "Publishing…" : publishNow ? "Publish" : "Save as a draft"}
            </Button>
          </>
        )
      }
    >
      {step === 1 ? (
        <div className="space-y-3.5">
          <Field label="Name" error={errors.name ?? null} hint="What somebody will look for it under.">
            <Input value={name} invalid={!!errors.name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <div className="grid grid-cols-2 gap-3.5">
            <Field label="Ref no" hint="The number printed on the document, if it has one.">
              <Input value={refNo} onChange={(e) => setRefNo(e.target.value)} placeholder="PL0105" />
            </Field>
            <Field label="Effective from" error={errors.effectiveFrom ?? null}>
              <input
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                className="h-8.5 w-full rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3.5">
            <Field label="Tax basis">
              <Select value={taxBasis} onChange={(e) => setTaxBasis(e.target.value as "inclusive" | "exclusive")}>
                <option value="inclusive">{TAX_BASIS_LABEL.inclusive}</option>
                <option value="exclusive">{TAX_BASIS_LABEL.exclusive}</option>
              </Select>
            </Field>
            <Field label="GST basis points" hint="1800 is 18%. Left empty it takes the configured rate.">
              <Input
                value={gstBp}
                inputMode="numeric"
                onChange={(e) => setGstBp(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="1800"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3.5">
            <Field label="Delivery basis">
              <Select value={deliveryBasis} onChange={(e) => setDeliveryBasis(e.target.value)}>
                <option value="">Not stated</option>
                {DELIVERY_BASES.map((b) => (
                  <option key={b} value={b}>
                    {DELIVERY_BASIS_LABEL[b]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Validity in days" hint="Empty means it runs until something supersedes it.">
              <Input
                value={validityDays}
                inputMode="numeric"
                onChange={(e) => setValidityDays(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="90"
              />
            </Field>
          </div>

          <div>
            <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
              Who pays the transport
            </span>
            <div className="flex gap-4">
              {FREIGHT_TERMS.map((term) => (
                <label key={term} className="flex cursor-pointer items-center gap-2 text-sm text-body">
                  <input
                    type="radio"
                    name="freight"
                    className="h-[15px] w-[15px] accent-[#6835FB]"
                    checked={freightTerm === term}
                    onChange={() => setFreightTerm(term)}
                  />
                  {FREIGHT_TERM_LABEL[term]}
                </label>
              ))}
            </div>
          </div>

          <Field label="Signatory" hint="Whose name is at the foot of the document.">
            <Input value={signatory} onChange={(e) => setSignatory(e.target.value)} />
          </Field>

          <Field label="Supersedes" hint="The list this one replaces. It is withdrawn as this one goes live.">
            <Select value={supersedesId} onChange={(e) => setSupersedesId(e.target.value)}>
              <option value="">Nothing — this is a new list</option>
              {published.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} (v{l.version}, from {longDate(l.effectiveFrom)})
                </option>
              ))}
            </Select>
          </Field>

          <ScopeEditor
            scopes={scopes}
            onChange={setScopes}
            states={options.places.states}
            error={errors.scopes ?? null}
          />

          <Field label="Notes" hint="Anything the next person should know. Optional.">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>

          <div className="space-y-2 border-t border-divider pt-3">
            <Checkbox
              label={
                document.suggestedCount > 0
                  ? `Include the ${document.suggestedCount} ${document.suggestedCount === 1 ? "cell" : "cells"} worth checking`
                  : "Include the cells worth checking"
              }
              checked={includeSuggested}
              disabled={document.suggestedCount === 0}
              title={document.suggestedCount === 0 ? "There are none on this document." : undefined}
              onChange={(e) => setIncludeSuggested(e.target.checked)}
            />
            <Checkbox
              label="Publish now"
              checked={publishNow}
              onChange={(e) => setPublishNow(e.target.checked)}
            />
            <p className="text-[11px] text-muted">
              Left unticked it is saved as a draft: nothing prices off it and nothing is withdrawn until
              somebody publishes it.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[15px] leading-[22px] text-ink">
            Will create <strong>{name.trim()}</strong> with{" "}
            <strong>
              {rateCount} {rateCount === 1 ? "rate" : "rates"}
            </strong>
            {leftOut > 0 ? (
              <>
                , {leftOut} {leftOut === 1 ? "cell" : "cells"} left out
              </>
            ) : null}
            , effective {longDate(effectiveFrom)}
            {supersedesId ? (
              <>, superseding {published.find((l) => l.id === supersedesId)?.name ?? "the current list"}</>
            ) : null}
            , applying to {scopes.map((s) => s.label).join(" · ")}.
          </p>

          <ul className="space-y-1 rounded-[4px] border border-line bg-canvas px-3.5 py-3 text-[13px] text-body">
            <li>
              {TAX_BASIS_LABEL[taxBasis]}
              {gstBp.trim() ? ` at ${(Number(gstBp) / 100).toFixed(0)}%` : " at the configured rate"}
              {deliveryBasis ? ` · ${DELIVERY_BASIS_LABEL[deliveryBasis as PriceDeliveryBasis]}` : null}
              {freightTerm !== "not_stated" ? ` · ${FREIGHT_TERM_LABEL[freightTerm]}` : null}
            </li>
            <li>
              {validityDays.trim()
                ? `Valid for ${validityDays} days from the effective date.`
                : "No validity stated — it runs until something supersedes it."}
            </li>
            <li>
              {includeSuggested
                ? "The cells the parser only suggested are included."
                : "Only the cells that matched outright are included."}
            </li>
          </ul>

          {!publishNow ? (
            <div className="rounded-[4px] border border-warn-line border-l-[3px] border-l-warn bg-warn-soft px-3.5 py-2.5 text-[13px] text-body">
              This will be saved as a DRAFT. Nothing prices off it until somebody publishes it.
            </div>
          ) : null}

          {leftOut > 0 ? (
            <div className="rounded-[4px] border border-line bg-surface px-3.5 py-2.5 text-[13px] text-muted">
              The {leftOut} left out stay on the document. Publishing does not throw them away, and a second
              version can carry them once somebody has matched them.
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ scopes */

function ScopeEditor({
  scopes,
  onChange,
  states,
  error,
}: {
  scopes: ScopeDraft[];
  onChange: (next: ScopeDraft[]) => void;
  states: PricingOptions["places"]["states"];
  error: string | null;
}) {
  const [kind, setKind] = React.useState<"state" | "customer" | "everybody">("state");
  const [stateKey, setStateKey] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<CustomerHitLite[]>([]);

  /* Debounced, because a customer picker that asks on every keystroke asks
     eight times for a name somebody typed in one go. */
  React.useEffect(() => {
    if (kind !== "customer") return;
    const term = query.trim();
    let live = true;
    const timer = setTimeout(async () => {
      if (term.length < 2) {
        if (live) setHits([]);
        return;
      }
      try {
        const response = await fetch(`/api/price-lists/customers/search?q=${encodeURIComponent(term)}`);
        if (!response.ok) return;
        const body = (await response.json()) as { customers?: CustomerHitLite[] };
        if (live) setHits(body.customers ?? []);
      } catch {
        /* A picker that could not reach the server offers nothing, and says so
           by offering nothing rather than by claiming the name does not exist. */
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [kind, query]);

  function add(draft: ScopeDraft) {
    if (scopes.some((s) => s.key === draft.key)) return;
    onChange([...scopes, draft]);
  }

  return (
    <div>
      <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
        Who it applies to
      </span>

      <div className="mb-2 flex flex-wrap gap-1.5">
        {scopes.length === 0 ? (
          <span className="text-[13px] text-muted">Nobody yet.</span>
        ) : (
          scopes.map((s) => (
            <span
              key={s.key}
              className={cx(
                "inline-flex items-center gap-1.5 rounded-[3px] border border-line bg-canvas px-2 py-1 text-[13px] text-body",
              )}
            >
              <Badge tone={s.kind === "everybody" ? "muted" : "brand"}>
                {s.kind === "state" ? "State" : s.kind === "customer" ? "Customer" : "All"}
              </Badge>
              {s.label}
              <button
                type="button"
                className="cursor-pointer text-muted hover:text-danger"
                onClick={() => onChange(scopes.filter((x) => x.key !== s.key))}
                aria-label={`Remove ${s.label}`}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>

      <div className="flex items-center gap-2">
        <Select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as typeof kind);
            setHits([]);
          }}
        >
          <option value="state">A state</option>
          <option value="customer">One customer</option>
          <option value="everybody">Everybody</option>
        </Select>

        {kind === "state" ? (
          <>
            <Select value={stateKey} onChange={(e) => setStateKey(e.target.value)} className="flex-1">
              <option value="">Choose a state</option>
              {states.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label} ({s.shops})
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              disabled={!stateKey}
              title={stateKey ? undefined : "Choose a state first."}
              onClick={() => {
                const state = states.find((s) => s.key === stateKey);
                if (!state) return;
                add({ key: state.key, kind: "state", value: state.key, label: state.label, parentKey: "" });
                setStateKey("");
              }}
            >
              Add
            </Button>
          </>
        ) : kind === "everybody" ? (
          <Button
            size="sm"
            onClick={() => add({ key: "everybody", kind: "everybody", value: "", label: "Everybody", parentKey: "" })}
          >
            Add everybody
          </Button>
        ) : (
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for a shop by name"
            className="flex-1"
          />
        )}
      </div>

      {kind === "customer" && hits.length ? (
        <div className="mt-2 max-h-[160px] overflow-y-auto rounded-[4px] border border-line">
          {hits.map((hit) => (
            <button
              key={hit.id}
              type="button"
              className="block w-full cursor-pointer border-b border-divider px-3 py-2 text-left last:border-0 hover:bg-canvas"
              onClick={() => {
                add({ key: hit.id, kind: "customer", value: hit.id, label: hit.name, parentKey: "" });
                setQuery("");
                setHits([]);
              }}
            >
              <span className="block text-[13px] text-ink">{hit.name}</span>
              <span className="block text-[11px] text-muted">{hit.city}</span>
            </button>
          ))}
        </div>
      ) : null}

      {error ? <span className="mt-1 block text-[13px] text-danger">{error}</span> : null}
      <p className="mt-1 text-[11px] text-muted">
        A customer beats a state, and a state beats everybody. Keeping one list for everybody is what stops a
        shop resolving to no price at all.
      </p>
    </div>
  );
}
