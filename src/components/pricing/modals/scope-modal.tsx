"use client";

/* ---------------------------------------------------------------------------
 * WHO A LIST IS FOR — one scope row, added or corrected.
 *
 * A list with no scopes prices nobody, which is the commonest way a list is
 * published and then does nothing. This is where that is answered: a state, a
 * district, a city, an area, a beat, a customer type, a salesman, one named
 * shop, or everybody — narrowest first in the picker, because the usual answer
 * is a place and "everybody" is the fallback somebody keeps exactly one of.
 *
 * A PLACE IS PICKED UNDER ITS PARENT, which is what keeps two cities of one
 * name apart — the resolution engine compares a city's parent against the
 * shop's district and state, and an empty parent reads as "this place wherever
 * it is". Each place carries how many shops are behind it, because the book's
 * city column holds whatever the sheet typed and the one somebody means is the
 * one with two hundred shops under it rather than the postal address below it.
 *
 * THE FREIGHT TERM IS PART OF THE MATCH. "Odisha Paid" and "Odisha To Pay" are
 * one region and two answers to who pays the transport, so a scope may insist
 * on one of them; "any" takes the list's own term, which is the usual answer.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { Button, Field, Input, Radio, Select, cx } from "@/components/ui/primitives";
import type { PriceScopeKind } from "@/db/schema";
import type { CustomerHit, PlaceOption, PricingOptions, ScopeView } from "@/lib/price-list-views";
import {
  EXCLUDE_KIND_HINT,
  EXCLUDE_KIND_ORDER,
  FREIGHT_TERM_HINT,
  SCOPE_KIND_HINT,
  SCOPE_KIND_LABEL,
  SCOPE_KIND_ORDER,
} from "@/lib/price-list-labels";
import { addScope, updateScope, type ClashAnswer } from "@/lib/actions/price-lists";
import { previewListRules, type RulesPreview } from "@/lib/actions/price-one-list";
import { ClashBox } from "@/components/pricing/one-list/clash-box";
import type { ClashView } from "@/lib/services/price-one-list-service";

const DATE_CLASS =
  "h-8.5 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand";

/** Which kinds are a place picked under a wider place. */
const PARENT_OF: Partial<Record<PriceScopeKind, "states" | "districts" | "cities">> = {
  district: "states",
  city: "states",
  area: "cities",
};

export function ScopeModal(props: {
  open: boolean;
  onClose: () => void;
  priceListId: string;
  scope: ScopeView | null;
  options: PricingOptions;
  /** Open on "Leave out" rather than "Include". */
  leaving?: boolean;
}) {
  if (!props.open) return null;
  return <ScopeBody key={`${props.scope?.id ?? "new"}:${props.leaving ? "out" : "in"}`} {...props} />;
}

function ScopeBody({
  onClose,
  priceListId,
  scope,
  options,
  leaving: startLeaving,
}: {
  onClose: () => void;
  priceListId: string;
  scope: ScopeView | null;
  options: PricingOptions;
  leaving?: boolean;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const [kind, setKind] = React.useState<PriceScopeKind>(scope?.scopeKind ?? "state");
  const [value, setValue] = React.useState(scope?.scopeValue ?? "");
  const [label, setLabel] = React.useState(scope?.scopeLabel ?? "");
  const [parentKey, setParentKey] = React.useState(scope?.parentKey ?? "");
  const [parentLabel, setParentLabel] = React.useState(scope?.parentLabel ?? "");
  const [freightTermMatch, setFreightTermMatch] = React.useState(scope?.freightTermMatch ?? "any");
  const [priority, setPriority] = React.useState(String(scope?.priority ?? 0));
  const [validFrom, setValidFrom] = React.useState(scope?.validFrom ?? "");
  const [validTo, setValidTo] = React.useState(scope?.validTo ?? "");
  const [placeQuery, setPlaceQuery] = React.useState("");
  const [leaving, setLeaving] = React.useState(scope ? scope.excluded : !!startLeaving);
  const [answers, setAnswers] = React.useState<Record<string, ClashAnswer[]>>({});

  /* What saving this row would do: the list's other rows plus this one. */
  const question = JSON.stringify({ kind, value, parentKey, freightTermMatch, validFrom, validTo, leaving });
  const [preview, setPreview] = React.useState<{ q: string; data: RulesPreview } | null>(null);
  React.useEffect(() => {
    if (leaving || (kind !== "everybody" && !value)) return;
    let live = true;
    const timer = setTimeout(async () => {
      const r = await previewListRules({
        listId: priceListId,
        withSavedRows: true,
        replaceScopeId: scope?.id ?? null,
        rows: [
          {
            scopeKind: kind,
            scopeValue: kind === "everybody" ? "" : value,
            scopeLabel: label || null,
            parentKey,
            freightTermMatch,
            priority: Number(priority) || 0,
            validFrom: validFrom || null,
            validTo: validTo || null,
            excluded: false,
          },
        ],
      });
      if (live && r.ok) setPreview({ q: question, data: r.data });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `question` is what the preview depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question]);
  const clashes = !leaving && preview && preview.q === question ? preview.data.clashes : [];
  const unanswered = clashes.filter((c) => !answers[c.customerId]);

  function answer(shops: ClashView[], kindOfAnswer: "keep" | "move") {
    setAnswers((a) => {
      const next = { ...a };
      for (const c of shops) next[c.customerId] = c.others.map((o) => ({ customerId: c.customerId, answer: kindOfAnswer, otherBookId: o.bookId }));
      return next;
    });
  }

  /** Picking a different kind throws the old answer away — it named a different thing. */
  function pickKind(next: PriceScopeKind) {
    setKind(next);
    setAnswers({});
    setValue("");
    setLabel("");
    setParentKey("");
    setParentLabel("");
    setPlaceQuery("");
  }

  const places: PlaceOption[] | null =
    kind === "state"
      ? options.places.states
      : kind === "district"
        ? options.places.districts
        : kind === "city"
          ? options.places.cities
          : kind === "area"
            ? options.places.areas
            : null;

  const parentSource = PARENT_OF[kind];
  const parents = parentSource ? options.places[parentSource] : null;

  const shown = React.useMemo(() => {
    if (!places) return [];
    const q = placeQuery.trim().toLowerCase();
    return places
      .filter((p) => (parentKey ? p.parentKey === parentKey : true))
      .filter((p) => (q ? p.label.toLowerCase().includes(q) : true))
      .slice(0, 60);
  }, [places, placeQuery, parentKey]);

  async function save() {
    const next: Record<string, string> = {};
    if (kind !== "everybody" && !value.trim()) next.scopeValue = leaving ? "Say who this list leaves out." : "Say which one this list applies to.";
    setErrors(next);
    if (Object.keys(next).length) return;

    const fields = {
      scopeKind: kind,
      scopeValue: kind === "everybody" ? "" : value.trim(),
      scopeLabel: label.trim() || null,
      parentKey,
      parentLabel: parentLabel || null,
      freightTermMatch: leaving ? ("any" as const) : freightTermMatch,
      priority: leaving ? 0 : Number(priority) || 0,
      validFrom: validFrom || null,
      validTo: validTo || null,
      excluded: leaving,
    };
    const given = clashes.flatMap((c) => answers[c.customerId] ?? []);

    setBusy(true);
    try {
      const r = scope
        ? await run(updateScope(scope.id, fields, given))
        : await run(addScope({ priceListId, ...fields }, given));
      if (r.ok) {
        onClose();
        router.refresh();
      } else if (r.fieldErrors) {
        setErrors(Object.fromEntries(r.fieldErrors.map((f) => [f.field, f.message])));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={600}
      title={scope ? (leaving ? "Who this list leaves out" : "Who this list applies to") : leaving ? "Leave somebody out" : "Add who this list applies to"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={leaving ? "danger" : "primary"}
            disabled={busy || (preview?.data.enforced !== false && unanswered.length > 0)}
            onClick={save}
            title={busy ? "Saving…" : unanswered.length ? "Answer every shop already on another list first." : undefined}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        {scope ? null : (
          <div className="grid grid-cols-2 overflow-hidden rounded-[6px] border border-line text-[13px] font-semibold">
            <button
              type="button"
              className={leaving ? "cursor-pointer bg-surface py-1.5 text-body" : "cursor-pointer bg-brand py-1.5 text-white"}
              onClick={() => {
                setLeaving(false);
                pickKind("state");
              }}
            >
              Include
            </button>
            <button
              type="button"
              className={leaving ? "cursor-pointer bg-danger py-1.5 text-white" : "cursor-pointer bg-surface py-1.5 text-body"}
              onClick={() => {
                setLeaving(true);
                pickKind("customer");
              }}
            >
              Leave out
            </button>
          </div>
        )}
        {leaving ? (
          <p className="text-[13px] text-muted">
            The shops picked here are taken off this list. They go to Standard unless another list names them.
          </p>
        ) : null}
        <div>
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Named by
          </span>
          <div className="grid grid-cols-3 gap-x-4 gap-y-1.5">
            {(leaving ? EXCLUDE_KIND_ORDER : SCOPE_KIND_ORDER).map((k) => (
              <Radio
                key={k}
                name="scope-kind"
                checked={kind === k}
                onChange={() => pickKind(k)}
                label={k === "customer" ? "Shop" : SCOPE_KIND_LABEL[k]}
              />
            ))}
          </div>
          <p className="mt-1.5 text-[13px] text-muted">{leaving ? EXCLUDE_KIND_HINT[kind] : SCOPE_KIND_HINT[kind]}</p>
        </div>

        {parents ? (
          <Field label={parentSource === "states" ? "In which state" : "In which city"} hint="Leave it blank to mean this place wherever it is.">
            <Select
              value={parentKey}
              onChange={(e) => {
                const picked = parents.find((p) => p.key === e.target.value) ?? null;
                setParentKey(picked?.key ?? "");
                setParentLabel(picked?.label ?? "");
                setValue("");
                setLabel("");
              }}
            >
              <option value="">Anywhere</option>
              {parents.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label} — {p.shops} shop{p.shops === 1 ? "" : "s"}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {places ? (
          <Field label={SCOPE_KIND_LABEL[kind]} error={errors.scopeValue ?? null}>
            <>
              <Input
                value={placeQuery}
                onChange={(e) => setPlaceQuery(e.target.value)}
                placeholder="Search"
              />
              <div className="mt-1.5 max-h-[200px] overflow-y-auto rounded-[4px] border border-line">
                {shown.length ? (
                  shown.map((p) => (
                    <button
                      key={`${p.parentKey}-${p.key}`}
                      type="button"
                      onClick={() => {
                        setValue(p.key);
                        setLabel(p.label);
                        if (!parentKey && p.parentKey) {
                          setParentKey(p.parentKey);
                          setParentLabel(p.parentLabel ?? "");
                        }
                      }}
                      className={cx(
                        "flex w-full cursor-pointer items-baseline justify-between gap-3 border-b border-divider px-3 py-1.5 text-left last:border-0 hover:bg-canvas",
                        p.key === value ? "bg-brand-soft" : null,
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-ink">{p.label}</span>
                        {p.parentLabel ? (
                          <span className="block truncate text-[12px] text-muted">{p.parentLabel}</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-[12px] text-muted">
                        {p.shops} shop{p.shops === 1 ? "" : "s"}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="px-3 py-2 text-[13px] text-muted">
                    No place on the book matches that.
                  </p>
                )}
              </div>
              {label ? <p className="mt-1.5 text-[13px] text-body">Picked: {label}</p> : null}
            </>
          </Field>
        ) : null}

        {kind === "beat" ? (
          <Field label="Beat" error={errors.scopeValue ?? null} hint="As the beat master spells it.">
            <>
              <Input
                list="pricing-beats"
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                  setValue(e.target.value);
                }}
              />
              <datalist id="pricing-beats">
                {options.beats.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </>
          </Field>
        ) : null}

        {kind === "salesman" ? (
          <Field label="Salesman" error={errors.scopeValue ?? null}>
            <Select
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setLabel(options.salesmen.find((s) => s.id === e.target.value)?.name ?? "");
              }}
            >
              <option value="">Pick somebody</option>
              {options.salesmen.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {kind === "customer_type" ? (
          <Field label="Customer type" error={errors.scopeValue ?? null}>
            <Select
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setLabel(e.target.value);
              }}
            >
              <option value="">Pick one</option>
              {options.customerTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {kind === "customer" ? (
          <CustomerPicker
            error={errors.scopeValue ?? null}
            chosenLabel={label}
            onPick={(hit) => {
              setValue(hit.id);
              setLabel(hit.name);
            }}
          />
        ) : null}

        {leaving ? null : (<div>
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Who pays the transport
          </span>
          <div className="flex flex-wrap items-center gap-5">
            <Radio
              name="freight-match"
              checked={freightTermMatch === "any"}
              onChange={() => setFreightTermMatch("any")}
              label="Whatever the list says"
            />
            <Radio
              name="freight-match"
              checked={freightTermMatch === "to_pay"}
              onChange={() => setFreightTermMatch("to_pay")}
              label="Only shops on To Pay"
            />
            <Radio
              name="freight-match"
              checked={freightTermMatch === "paid"}
              onChange={() => setFreightTermMatch("paid")}
              label="Only shops on Paid"
            />
          </div>
          <p className="mt-1.5 text-[13px] text-muted">
            {freightTermMatch === "any"
              ? "The list's own freight term decides, which is the usual answer."
              : FREIGHT_TERM_HINT[freightTermMatch]}
          </p>
        </div>)}

        <div className="grid grid-cols-3 gap-3">
          {leaving ? <div /> : (
            <Field label="Priority" hint="Higher wins a tie inside one kind.">
              <Input value={priority} inputMode="numeric" onChange={(e) => setPriority(e.target.value)} />
            </Field>
          )}
          <Field label="Valid from" hint="Blank is straight away.">
            <input type="date" className={DATE_CLASS} value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
          </Field>
          <Field label="Valid to" hint="Blank is no end.">
            <input type="date" className={DATE_CLASS} value={validTo} onChange={(e) => setValidTo(e.target.value)} />
          </Field>
        </div>

        {clashes.length > unanswered.length ? (
          <div className="flex items-center gap-2 rounded-[6px] border border-line bg-canvas px-3 py-2 text-[13px]">
            <span className="flex-1 text-body">
              {(() => {
                const done = clashes.filter((c) => answers[c.customerId]);
                const moving = done.filter((c) => answers[c.customerId]?.[0]?.answer === "move").length;
                return `${done.length} answered — ${moving} move here, ${done.length - moving} stay where they are.`;
              })()}
            </span>
            <button type="button" className="cursor-pointer text-danger hover:underline" onClick={() => setAnswers({})}>
              Undo answers
            </button>
          </div>
        ) : null}
        {unanswered.length ? (
          <ClashBox
            clashes={unanswered}
            enforced={preview?.data.enforced ?? true}
            onKeep={(shops) => answer(shops, "keep")}
            onMove={(shops) => answer(shops, "move")}
          />
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * One shop, searched for.
 *
 * The answer is TAGGED WITH THE QUESTION it answers, like the distributor
 * picker: a slow response for an earlier query cannot overwrite a newer one,
 * and "still searching" is derived from the tag rather than from a flag set in
 * the effect body, which the React Compiler rules here forbid.
 */
function CustomerPicker({
  chosenLabel,
  onPick,
  error,
}: {
  chosenLabel: string;
  onPick: (hit: CustomerHit) => void;
  error: string | null;
}) {
  const [query, setQuery] = React.useState("");
  const [answer, setAnswer] = React.useState<{ q: string; hits: CustomerHit[] } | null>(null);

  React.useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/price-lists/customers/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        const data = (await res.json()) as { customers?: CustomerHit[] };
        setAnswer({ q, hits: data.customers ?? [] });
      } catch {
        /* An abort is the next keystroke, not a failure. */
      }
    }, 180);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  const q = query.trim();
  const hits = answer && answer.q === q ? answer.hits : null;

  return (
    <Field label="Customer" error={error} hint="Naming a shop beats every other rule.">
      <>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search for a shop" />
        {q ? (
          <div className="mt-1.5 max-h-[180px] overflow-y-auto rounded-[4px] border border-line">
            {hits === null ? (
              <p className="px-3 py-2 text-[13px] text-muted">Searching…</p>
            ) : hits.length ? (
              hits.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => onPick(h)}
                  className="block w-full cursor-pointer border-b border-divider px-3 py-1.5 text-left last:border-0 hover:bg-canvas"
                >
                  <span className="block text-sm text-ink">{h.name}</span>
                  <span className="block text-[12px] text-muted">
                    {[h.city, h.region].filter(Boolean).join(" · ")}
                  </span>
                </button>
              ))
            ) : (
              <p className="px-3 py-2 text-[13px] text-muted">No shop matches that.</p>
            )}
          </div>
        ) : null}
        {chosenLabel ? <p className="mt-1.5 text-[13px] text-body">Picked: {chosenLabel}</p> : null}
      </>
    </Field>
  );
}
