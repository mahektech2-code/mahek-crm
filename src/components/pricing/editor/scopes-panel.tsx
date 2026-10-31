"use client";

/* ---------------------------------------------------------------------------
 * WHO THE LIST PRICES — said before it is saved, not after.
 *
 * A published list naming nobody prices nobody and looks exactly like one
 * that works, which is the failure this whole module was built around. So the
 * editor asks the question as one of its steps rather than leaving it to a
 * second screen after the save, and says in words what each row means.
 *
 * TWO KINDS OF ROW. "Includes" puts shops on the list — a place, a salesman,
 * a customer type, one shop, or everybody. "Except" takes a few back OFF: a
 * shop by name, a salesman's shops, an area, a city, a district or a beat
 * the includes would otherwise reach. A left-out shop goes to Standard unless
 * another list names it.
 *
 * ONE LIST PER SHOP. While the rules are being written the step reads what
 * they would reach (`previewListRules`) and lists every shop already on
 * another price list. Each is answered here: keep it where it is (this list
 * leaves it out — a row added under Except) or move it here (it leaves its
 * old list when this one is published). Publishing with a shop unanswered is
 * refused on the server, so the box is the way through rather than a warning.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { Badge, Button, Callout, Field, Input, Select } from "@/components/ui/primitives";
import type { PriceScopeKind } from "@/db/schema";
import {
  EXCLUDE_KIND_HINT,
  EXCLUDE_KIND_ORDER,
  SCOPE_KIND_HINT,
  SCOPE_KIND_LABEL,
  SCOPE_KIND_ORDER,
} from "@/lib/price-list-labels";
import type { CustomerHit, PlaceOption, PricingOptions } from "@/lib/price-list-views";
import type { EditorMove, EditorScope } from "@/components/pricing/editor/editor-state";
import { previewListRules, type RulesPreview } from "@/lib/actions/price-one-list";
import { ClashBox, ReachStrip } from "@/components/pricing/one-list/clash-box";
import type { ClashView } from "@/lib/services/price-one-list-service";

const FREIGHT_WORDS = { any: "whoever pays transport", to_pay: "customers who pay their own transport", paid: "customers whose transport we pay" } as const;

export function ScopesPanel({
  scopes,
  onChange,
  options,
  mode,
  listId,
  supersedesId,
  freightTerm,
  moves,
  onMoves,
}: {
  scopes: EditorScope[];
  onChange: (next: EditorScope[]) => void;
  options: PricingOptions;
  mode: "create" | "update" | "version";
  /** The list as saved — a draft being edited, or the published list a version is made from. */
  listId: string | null;
  supersedesId: string | null;
  freightTerm: "to_pay" | "paid" | "not_stated";
  moves: EditorMove[];
  onMoves: (next: EditorMove[]) => void;
}) {
  const [leaving, setLeaving] = React.useState(false);
  const [kind, setKind] = React.useState<PriceScopeKind>("state");
  const [value, setValue] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [parentKey, setParentKey] = React.useState("");
  const [freight, setFreight] = React.useState<EditorScope["freightTermMatch"]>("any");
  const [q, setQ] = React.useState("");
  const [hits, setHits] = React.useState<CustomerHit[]>([]);

  const including = scopes.filter((s) => !s.excluded);
  const excluding = scopes.filter((s) => s.excluded);

  /* ---- what these rules would do, read whenever they change ---------- */
  const question = JSON.stringify({ scopes, moves: moves.map((m) => [m.customerId, m.fromBookId]), listId, supersedesId, freightTerm });
  const [answer, setAnswer] = React.useState<{ q: string; preview: RulesPreview | null; error: string | null } | null>(null);
  React.useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      const r = await previewListRules({
        listId,
        supersedesId: supersedesId || null,
        freightTerm,
        rows: scopes.map((s) => ({
          scopeKind: s.kind,
          scopeValue: s.value,
          scopeLabel: s.label,
          parentKey: s.parentKey,
          freightTermMatch: s.freightTermMatch,
          priority: s.priority ?? 0,
          validFrom: s.validFrom ?? null,
          validTo: s.validTo ?? null,
          excluded: !!s.excluded,
        })),
        moves: moves.map((m) => ({ customerId: m.customerId, fromBookId: m.fromBookId })),
      });
      if (!live) return;
      setAnswer({ q: question, preview: r.ok ? r.data : null, error: r.ok ? null : r.error });
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `question` is the whole of what the preview depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question]);
  const current = answer && answer.q === question ? answer : null;
  const preview = current?.preview ?? answer?.preview ?? null;

  /* ---- answering a clash --------------------------------------------- */
  function keep(shops: ClashView[]) {
    const add: EditorScope[] = shops
      .filter((c) => !scopes.some((s) => s.excluded && s.kind === "customer" && s.value === c.customerId))
      .map((c) => ({
        key: `exclude:customer:${c.customerId}`,
        kind: "customer",
        value: c.customerId,
        label: c.name,
        parentKey: "",
        freightTermMatch: "any",
        excluded: true,
      }));
    if (add.length) onChange([...scopes, ...add]);
  }
  function move(shops: ClashView[]) {
    const next = [...moves];
    for (const c of shops) {
      for (const o of c.others) {
        if (next.some((m) => m.customerId === c.customerId && m.fromBookId === o.bookId)) continue;
        next.push({ customerId: c.customerId, fromBookId: o.bookId, name: c.name, fromName: o.listName });
      }
    }
    onMoves(next);
  }

  /* ---- adding a row --------------------------------------------------- */
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

  function reset() {
    setValue("");
    setLabel("");
    setParentKey("");
    setQ("");
    setHits([]);
  }

  function switchTo(leave: boolean) {
    setLeaving(leave);
    setKind(leave ? "customer" : "state");
    reset();
  }

  function add() {
    if (kind !== "everybody" && !value) return;
    const key = `${leaving ? "exclude" : "include"}:${kind}:${value}:${parentKey}:${leaving ? "any" : freight}`;
    if (scopes.some((s) => s.key === key)) return;
    onChange([
      ...scopes,
      {
        key,
        kind,
        value: kind === "everybody" ? "" : value,
        label: kind === "everybody" ? "Everybody" : label || value,
        parentKey,
        freightTermMatch: leaving ? "any" : freight,
        excluded: leaving || undefined,
      },
    ]);
    reset();
  }

  const pickPlace = (key: string) => {
    const hit = places[kind]?.find((p) => p.key === key);
    setValue(key);
    setLabel(hit ? (hit.parentLabel ? `${hit.label}, ${hit.parentLabel}` : hit.label) : key);
    setParentKey(hit?.parentKey ?? "");
  };

  const kinds = leaving ? EXCLUDE_KIND_ORDER : SCOPE_KIND_ORDER;
  const hint = leaving ? EXCLUDE_KIND_HINT[kind] : SCOPE_KIND_HINT[kind];

  return (
    <div className="mx-auto grid max-w-[1180px] gap-6 lg:grid-cols-[1fr_400px]">
      <div className="space-y-3.5">
        <div>
          <h3 className="text-sm font-semibold text-ink">Who this list applies to</h3>
          <p className="text-[13px] text-muted">
            {mode === "version"
              ? "Carried over from the version this replaces. A shop can be on one price list only; shops on no list are priced from Standard."
              : "A shop can be on one price list only. Shops on no list are priced from Standard."}
          </p>
        </div>

        {scopes.length ? (
          <ReachStrip
            reached={preview?.reached ?? 0}
            leftOut={preview?.leftOut ?? 0}
            priced={preview?.priced ?? 0}
            clashes={preview?.clashes.length ?? 0}
            loading={!current}
          />
        ) : null}

        {including.length === 0 ? (
          <Callout tone="warn">Nobody yet. If it is published like this, no shop will be priced from it.</Callout>
        ) : (
          <div>
            <div className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">Includes</div>
            <ul className="divide-y divide-divider rounded-[6px] border border-line">
              {including.map((s) => (
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
          </div>
        )}

        {excluding.length ? (
          <div>
            <div className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">Except — left out</div>
            <ul className="divide-y divide-divider rounded-[6px] border border-line">
              {excluding.map((s) => (
                <li key={s.key} className="flex items-center gap-3 px-3 py-2.5">
                  <Badge tone="danger">{SCOPE_KIND_LABEL[s.kind]}</Badge>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{s.label}</span>
                    <span className="block text-[12px] text-muted">Goes to Standard unless another list names it</span>
                  </span>
                  <button type="button" onClick={() => onChange(scopes.filter((x) => x.key !== s.key))} className="cursor-pointer text-[13px] text-danger hover:underline">
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {moves.length ? (
          <div>
            <div className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">Moving here when published</div>
            <ul className="divide-y divide-divider rounded-[6px] border border-line">
              {moves.map((m) => (
                <li key={`${m.customerId}:${m.fromBookId}`} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    <span className="font-medium text-ink">{m.name}</span>
                    <span className="text-muted"> · leaves {m.fromName}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onMoves(moves.filter((x) => !(x.customerId === m.customerId && x.fromBookId === m.fromBookId)))}
                    className="cursor-pointer text-[13px] text-danger hover:underline"
                  >
                    Undo
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {preview ? (
          <ClashBox clashes={preview.clashes} enforced={preview.enforced} onKeep={keep} onMove={move} />
        ) : current?.error ? (
          <Callout tone="warn">{current.error}</Callout>
        ) : null}
      </div>

      <aside className="h-fit rounded-[6px] border border-line bg-canvas p-4">
        <div className="mb-3 text-sm font-semibold text-ink">Add somebody</div>
        <div className="mb-3 grid grid-cols-2 overflow-hidden rounded-[6px] border border-line text-[13px] font-semibold">
          <button
            type="button"
            className={leaving ? "cursor-pointer bg-surface py-1.5 text-body" : "cursor-pointer bg-brand py-1.5 text-white"}
            onClick={() => switchTo(false)}
          >
            Include
          </button>
          <button
            type="button"
            className={leaving ? "cursor-pointer bg-danger py-1.5 text-white" : "cursor-pointer bg-surface py-1.5 text-body"}
            onClick={() => switchTo(true)}
          >
            Leave out
          </button>
        </div>
        {leaving ? (
          <p className="mb-3 text-[12px] text-muted">
            Pick shops this list would reach and leave them out. They go to Standard unless another list names them.
          </p>
        ) : null}
        <div className="space-y-3">
          <Field label="By" hint={hint}>
            <Select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as PriceScopeKind);
                reset();
              }}
              className="w-full"
            >
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {k === "customer" ? "Shop" : SCOPE_KIND_LABEL[k]}
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
            <Field label="Salesman" hint={leaving ? undefined : "Every shop in their book."}>
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
            <Field label="Shop">
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

          {leaving ? null : (
            <Field label="Transport">
              <Select value={freight} onChange={(e) => setFreight(e.target.value as EditorScope["freightTermMatch"])} className="w-full">
                <option value="any">Any customer</option>
                <option value="to_pay">Only customers who pay their own transport</option>
                <option value="paid">Only customers whose transport we pay</option>
              </Select>
            </Field>
          )}

          <Button variant={leaving ? "danger" : "primary"} className="w-full" onClick={add} disabled={kind !== "everybody" && !value}>
            {leaving ? `Leave out this ${kind === "customer" ? "shop" : SCOPE_KIND_LABEL[kind].toLowerCase()}` : `Add ${kind === "everybody" ? "everybody" : SCOPE_KIND_LABEL[kind].toLowerCase()}`}
          </Button>
        </div>
      </aside>
    </div>
  );
}
