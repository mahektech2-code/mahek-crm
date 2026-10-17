"use client";

/* ---------------------------------------------------------------------------
 * WHO THE LIST PRICES — said before it is saved, not after.
 *
 * A published list naming nobody prices nobody and looks exactly like one
 * that works, which is the failure this whole module was built around. So the
 * editor asks the question as one of its steps rather than leaving it to a
 * second screen after the save, and says in words what each row means.
 *
 * Narrowest wins when two lists could both apply to a shop: a named customer
 * over a salesman over a beat, an area, a city, a district, a state, a
 * customer type, and everybody last. The hint beside each kind says so.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { Badge, Button, Callout, Field, Input, Select } from "@/components/ui/primitives";
import type { PriceScopeKind } from "@/db/schema";
import { SCOPE_KIND_HINT, SCOPE_KIND_LABEL, SCOPE_KIND_ORDER } from "@/lib/price-list-labels";
import type { CustomerHit, PlaceOption, PricingOptions } from "@/lib/price-list-views";
import type { EditorScope } from "@/components/pricing/editor/editor-state";

const FREIGHT_WORDS = { any: "whoever pays transport", to_pay: "customers who pay their own transport", paid: "customers whose transport we pay" } as const;

export function ScopesPanel({
  scopes,
  onChange,
  options,
  mode,
}: {
  scopes: EditorScope[];
  onChange: (next: EditorScope[]) => void;
  options: PricingOptions;
  mode: "create" | "update" | "version";
}) {
  const [kind, setKind] = React.useState<PriceScopeKind>("state");
  const [value, setValue] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [parentKey, setParentKey] = React.useState("");
  const [freight, setFreight] = React.useState<EditorScope["freightTermMatch"]>("any");
  const [q, setQ] = React.useState("");
  const [hits, setHits] = React.useState<CustomerHit[]>([]);

  const places: Partial<Record<PriceScopeKind, PlaceOption[]>> = {
    state: options.places.states,
    district: options.places.districts,
    city: options.places.cities,
    area: options.places.areas,
  };

  async function search(text: string) {
    setQ(text);
    if (text.trim().length < 2) return setHits([]);
    try {
      const r = await fetch(`/api/price-lists/customers/search?q=${encodeURIComponent(text)}`, { cache: "no-store" });
      const body = (await r.json()) as { customers?: CustomerHit[] };
      setHits(body.customers ?? []);
    } catch {
      setHits([]);
    }
  }

  function add() {
    if (kind !== "everybody" && !value) return;
    const key = `${kind}:${value}:${parentKey}:${freight}`;
    if (scopes.some((s) => `${s.kind}:${s.value}:${s.parentKey}:${s.freightTermMatch}` === key)) return;
    onChange([
      ...scopes,
      { key, kind, value: kind === "everybody" ? "" : value, label: kind === "everybody" ? "Everybody" : label || value, parentKey, freightTermMatch: freight },
    ]);
    setValue("");
    setLabel("");
    setParentKey("");
    setQ("");
    setHits([]);
  }

  const pickPlace = (key: string) => {
    const hit = places[kind]?.find((p) => p.key === key);
    setValue(key);
    setLabel(hit ? (hit.parentLabel ? `${hit.label}, ${hit.parentLabel}` : hit.label) : key);
    setParentKey(hit?.parentKey ?? "");
  };

  return (
    <div className="mx-auto grid max-w-[1100px] gap-6 lg:grid-cols-[1fr_400px]">
      <div>
        <h3 className="text-sm font-semibold text-ink">Who this list applies to</h3>
        <p className="mb-3 text-[13px] text-muted">
          {mode === "version"
            ? "Carried over from the version this replaces. Change it here if the new version should reach somebody else."
            : "Nothing is priced from a list until it names somebody. Everybody is a real answer."}
        </p>
        {scopes.length === 0 ? (
          <Callout tone="warn">Nobody yet. If it is published like this, no shop will be priced from it.</Callout>
        ) : (
          <ul className="divide-y divide-divider rounded-[6px] border border-line">
            {scopes.map((s) => (
              <li key={s.key} className="flex items-center gap-3 px-3 py-2.5">
                <Badge tone="brand">{SCOPE_KIND_LABEL[s.kind]}</Badge>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{s.kind === "everybody" ? "Every shop" : s.label}</span>
                  <span className="block text-[12px] text-muted">For {FREIGHT_WORDS[s.freightTermMatch]}</span>
                </span>
                <button type="button" onClick={() => onChange(scopes.filter((x) => x.key !== s.key))} className="cursor-pointer text-[13px] text-danger hover:underline">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <aside className="rounded-[6px] border border-line bg-canvas p-4">
        <div className="mb-3 text-sm font-semibold text-ink">Add somebody</div>
        <div className="space-y-3">
          <Field label="By" hint={SCOPE_KIND_HINT[kind]}>
            <Select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as PriceScopeKind);
                setValue("");
                setLabel("");
                setParentKey("");
              }}
              className="w-full"
            >
              {SCOPE_KIND_ORDER.map((k) => (
                <option key={k} value={k}>
                  {SCOPE_KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>

          {places[kind] ? (
            <Field label={SCOPE_KIND_LABEL[kind]}>
              <Select value={value} onChange={(e) => pickPlace(e.target.value)} className="w-full">
                <option value="">Choose…</option>
                {places[kind]!.map((p) => (
                  <option key={`${p.key}:${p.parentKey}`} value={p.key}>
                    {p.label}
                    {p.parentLabel ? `, ${p.parentLabel}` : ""} — {p.shops} shop{p.shops === 1 ? "" : "s"}
                  </option>
                ))}
              </Select>
            </Field>
          ) : kind === "beat" ? (
            <Field label="Beat">
              <Input
                list="pl-beats"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setLabel(e.target.value);
                }}
              />
              <datalist id="pl-beats">
                {options.beats.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </Field>
          ) : kind === "customer_type" ? (
            <Field label="Customer type">
              <Select
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setLabel(e.target.value);
                }}
                className="w-full"
              >
                <option value="">Choose…</option>
                {options.customerTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
          ) : kind === "salesman" ? (
            <Field label="Salesman" hint="Every shop in their book.">
              <Select
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setLabel(options.salesmen.find((s) => s.id === e.target.value)?.name ?? "");
                }}
                className="w-full"
              >
                <option value="">Choose…</option>
                {options.salesmen.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : kind === "customer" ? (
            <Field label="Customer">
              <Input value={q} onChange={(e) => void search(e.target.value)} placeholder="Type two letters of the shop's name" />
              {value ? <div className="mt-1 text-[13px] text-body">Chosen: {label}</div> : null}
              {hits.length ? (
                <ul className="mt-1 max-h-[180px] overflow-auto rounded-[4px] border border-line bg-surface">
                  {hits.map((h) => (
                    <li key={h.id}>
                      <button
                        type="button"
                        className="w-full cursor-pointer px-2.5 py-1.5 text-left text-[13px] hover:bg-canvas"
                        onClick={() => {
                          setValue(h.id);
                          setLabel(h.name);
                          setHits([]);
                          setQ(h.name);
                        }}
                      >
                        <span className="font-medium text-ink">{h.name}</span>
                        <span className="text-muted"> · {h.city}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Field>
          ) : null}

          <Field label="Transport">
            <Select value={freight} onChange={(e) => setFreight(e.target.value as EditorScope["freightTermMatch"])} className="w-full">
              <option value="any">Any customer</option>
              <option value="to_pay">Only customers who pay their own transport</option>
              <option value="paid">Only customers whose transport we pay</option>
            </Select>
          </Field>

          <Button variant="primary" className="w-full" onClick={add} disabled={kind !== "everybody" && !value}>
            Add {kind === "everybody" ? "everybody" : SCOPE_KIND_LABEL[kind].toLowerCase()}
          </Button>
        </div>
      </aside>
    </div>
  );
}
