"use client";

import { useMemo, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { MultiSelect } from "@/components/ui/multi-select";
import { Badge, Button, Card } from "@/components/ui/primitives";
import { erpLogisticsTransporter } from "@/lib/actions/erp-logistics";
import { checkGstin } from "@/lib/engines/lead-scan";
import type { Transporter } from "@/lib/erp/logistics";
import { ancestorsOf, leaves, lookup, optionsFor, placePath, repick, withAncestors, type PlaceLookup, type PlaceOption } from "@/lib/erp/transporter-places";
import { PLACE_FILTER_LABELS } from "@/lib/place-filters";
import { PLACE_KINDS, type PlaceKind } from "@/lib/place-parse";
import { CallLink, Empty, useAct } from "./common";

/**
 * The transport companies logistics rings, with their numbers, their GST
 * number, where they keep godowns and — where the company has one — the page
 * that tracks an LR online. Bills and LRs carry the transporter as a name, so
 * a name here is what gives a card its call button.
 */
type Load = { active: number; road: number };

const COLS = "grid-cols-[minmax(170px,1.3fr)_minmax(130px,1fr)_minmax(120px,1fr)_minmax(160px,1.4fr)_110px_70px]";

export function Transporters({ rows, tree, labels, load, canWrite }: { rows: Transporter[]; tree: PlaceOption[]; labels: string[]; load: Record<string, Load>; canWrite: boolean }) {
  const [edit, setEdit] = useState<Partial<Transporter> | null>(null);
  const byId = useMemo(() => lookup(tree), [tree]);
  return (
    <div className="space-y-3">
      {canWrite ? (
        <div className="flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setEdit({ active: true, placeIds: [] })}>
            Add transporter
          </Button>
        </div>
      ) : null}
      <Card className="overflow-hidden">
        <div className={`grid ${COLS} gap-3 border-b border-divider bg-canvas px-4 py-2 text-[12px] font-medium text-muted`}>
          <span>Transporter</span>
          <span>Phone</span>
          <span>Contact</span>
          <span>Godowns</span>
          <span>With them now</span>
          <span />
        </div>
        {rows.length ? (
          rows.map((t) => {
            const l = load[t.name.toLowerCase()] ?? { active: 0, road: 0 };
            return (
              <div key={t.id} className={`grid ${COLS} items-center gap-3 border-b border-divider px-4 py-2.5 text-sm last:border-0`}>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{t.name}</span>
                  {t.gstin || t.consignmentLabel ? (
                    <span className="block truncate text-[12px] text-muted">
                      {t.gstin ? <span className="font-mono">{t.gstin}</span> : null}
                      {t.gstin && t.consignmentLabel ? " · " : null}
                      {t.consignmentLabel}
                    </span>
                  ) : null}
                  {!t.active ? <Badge tone="muted">Not in use</Badge> : t.trackingUrl ? <span className="text-[12px] text-success">Online tracking</span> : null}
                </span>
                <span className="min-w-0">
                  <CallLink phone={t.phone} name={t.name} />
                  {t.altPhone ? <span className="block text-[12px] text-muted">{t.altPhone}</span> : null}
                </span>
                <span className="truncate text-[13px] text-body">{t.contactPerson ?? "—"}</span>
                <GodownCell t={t} byId={byId} />
                <span className="text-[13px] text-body">{l.active ? `${l.active} bill${l.active === 1 ? "" : "s"}${l.road ? ` · ${l.road} on road` : ""}` : "—"}</span>
                <span className="text-right">
                  {canWrite ? (
                    <Button size="sm" variant="ghost" onClick={() => setEdit(t)}>
                      Edit
                    </Button>
                  ) : null}
                </span>
              </div>
            );
          })
        ) : (
          <Empty>No transporters yet. Add the companies you send goods with.</Empty>
        )}
      </Card>
      {edit ? <EditTransporter key={edit.id ?? "new"} t={edit} tree={tree} labels={labels} byId={byId} onClose={() => setEdit(null)} /> : null}
    </div>
  );
}

/** The godowns as places, the first two named; the full paths ride on the hover. */
function GodownCell({ t, byId }: { t: Transporter; byId: PlaceLookup }) {
  const ids = t.placeIds.filter((id) => byId.has(id));
  if (!ids.length) {
    return t.address ? (
      <span className="truncate text-[13px] text-muted" title="Typed before godowns were picked from the place list — edit to pick it">
        {t.address} <span className="text-[11px]">(typed)</span>
      </span>
    ) : (
      <span className="text-[13px] text-muted">—</span>
    );
  }
  const names = ids.map((id) => byId.get(id)?.name ?? "").sort((a, b) => a.localeCompare(b));
  return (
    <span className="truncate text-[13px] text-body" title={ids.map((id) => placePath(id, byId)).join("\n")}>
      {names.slice(0, 2).join(", ")}
      {names.length > 2 ? <span className="text-muted"> +{names.length - 2}</span> : null}
    </span>
  );
}

const ANY: Record<PlaceKind, string> = { state: "Any state", district: "Any district", city: "Any city", area: "Any area" };

function EditTransporter({ t, tree, labels, byId, onClose }: { t: Partial<Transporter>; tree: PlaceOption[]; labels: string[]; byId: PlaceLookup; onClose: () => void }) {
  const { run, pending } = useAct();
  const [v, setV] = useState({ name: t.name ?? "", gstin: t.gstin ?? "", consignmentLabel: t.consignmentLabel ?? "", phone: t.phone ?? "", altPhone: t.altPhone ?? "", contactPerson: t.contactPerson ?? "", trackingUrl: t.trackingUrl ?? "", active: t.active ?? true });
  /** A name somebody is typing that is not on the list yet. */
  const [adding, setAdding] = useState(false);
  const labelOptions = v.consignmentLabel && !labels.includes(v.consignmentLabel) ? [...labels, v.consignmentLabel] : labels;
  const [picks, setPicks] = useState<string[]>(() => withAncestors(t.placeIds ?? [], byId));
  const cls = "mt-1 block h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand";
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });

  const gst = checkGstin(v.gstin);
  const gstBad = !!gst && gst.check === "invalid";
  const godowns = leaves(picks, byId).sort((a, b) => placePath(a, byId).localeCompare(placePath(b, byId)));

  /** Taking a godown off also takes the path above it, unless another godown still sits under that path. */
  function drop(id: string) {
    const rest = picks.filter((p) => p !== id);
    const stillUnder = new Set(leaves(rest, byId).flatMap((l) => (l === id ? [] : [l, ...ancestorsOf(l, byId)])));
    setPicks(rest.filter((p) => !ancestorsOf(id, byId).includes(p) || stillUnder.has(p)));
  }

  const save = () =>
    run(() => erpLogisticsTransporter({ id: t.id ?? null, ...v, gstin: gst?.gstin ?? null, placeIds: godowns }), (r) => r.ok && onClose());

  return (
    <Modal
      open
      onClose={onClose}
      width={640}
      title={t.id ? `Edit ${t.name}` : "Add a transporter"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={pending || !v.name.trim() || gstBad} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-[12px] text-muted">
        <div className="grid grid-cols-2 gap-3">
          <label className="col-span-2">
            Name (as it is written on bills and LRs)
            <input value={v.name} onChange={set("name")} className={cls} />
          </label>
          <label>
            GST number
            <input
              value={v.gstin}
              onChange={(e) => setV({ ...v, gstin: e.target.value.toUpperCase() })}
              placeholder="27ABCDE1234F1Z5"
              maxLength={20}
              className={`${cls} font-mono ${gstBad ? "border-danger" : ""}`}
            />
            {gstBad ? (
              <span className="mt-1 block text-danger">This number does not check out. Check it against their bill.</span>
            ) : gst?.check === "corrected" ? (
              <span className="mt-1 block">Will be saved as {gst.gstin}.</span>
            ) : null}
          </label>
          <label>
            Their consignment number is called
            {adding ? (
              <span className="mt-1 flex gap-1.5">
                <input
                  autoFocus
                  value={v.consignmentLabel}
                  onChange={set("consignmentLabel")}
                  placeholder="e.g. Docket Number"
                  className={`${cls} mt-0`}
                />
                <Button
                  size="sm"
                  onClick={() => {
                    setAdding(false);
                    if (!v.consignmentLabel.trim()) setV({ ...v, consignmentLabel: t.consignmentLabel ?? "" });
                  }}
                >
                  Done
                </Button>
              </span>
            ) : (
              <select
                value={v.consignmentLabel}
                onChange={(e) => {
                  if (e.target.value === "__add") {
                    setAdding(true);
                    setV({ ...v, consignmentLabel: "" });
                  } else setV({ ...v, consignmentLabel: e.target.value });
                }}
                className={cls}
              >
                <option value="">Not set</option>
                {labelOptions.map((l) => (
                  <option key={l} value={l}>
                    {l}
                    {labels.includes(l) ? "" : " (new)"}
                  </option>
                ))}
                <option value="__add">+ Add another…</option>
              </select>
            )}
          </label>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <label>
            Contact person
            <input value={v.contactPerson} onChange={set("contactPerson")} className={cls} />
          </label>
          <label>
            Phone
            <input value={v.phone} onChange={set("phone")} inputMode="tel" className={cls} />
          </label>
          <label>
            Second phone
            <input value={v.altPhone} onChange={set("altPhone")} inputMode="tel" className={cls} />
          </label>
        </div>

        <div className="border-t border-divider pt-4">
          <div className="text-sm font-medium text-ink">Godowns</div>
          <div className="mt-0.5">Pick every place they keep a godown. A state alone means anywhere in it.</div>
          <div className="mt-3 grid grid-cols-4 gap-2">
            {PLACE_KINDS.map((kind) => (
              <div key={kind} className="min-w-0">
                <span className="block">{PLACE_FILTER_LABELS[kind]}</span>
                <div className="mt-1 [&>span]:block [&>span>button]:h-9 [&>span>button]:w-full [&>span>button]:justify-between">
                  <MultiSelect
                    label={PLACE_FILTER_LABELS[kind]}
                    placeholder={ANY[kind]}
                    options={optionsFor(kind, picks, tree, byId)}
                    selected={picks.filter((id) => byId.get(id)?.kind === kind)}
                    onChange={(next) => setPicks(repick(kind, next, picks, byId))}
                    everythingIsAll={false}
                  />
                </div>
              </div>
            ))}
          </div>
          {godowns.length ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {godowns.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 rounded-full border border-line bg-canvas py-0.5 pl-2.5 pr-1 text-[12px] text-body">
                  {placePath(id, byId)}
                  <button type="button" onClick={() => drop(id)} className="rounded-full px-1 text-muted hover:text-ink" aria-label={`Remove ${placePath(id, byId)}`}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : t.address ? (
            <div className="mt-3">Typed before: {t.address}. Pick it above so it is on the list.</div>
          ) : null}
        </div>

        <div className="space-y-3 border-t border-divider pt-4">
          <label className="block">
            Online tracking page
            <input value={v.trackingUrl} onChange={set("trackingUrl")} placeholder="https://… with {lr} where the LR number goes" className={cls} />
          </label>
          <label className="flex items-center gap-2 text-sm text-body">
            <input type="checkbox" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} className="accent-[#6835FB]" /> In use
          </label>
        </div>
      </div>
    </Modal>
  );
}
