"use client";

import { useMemo, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import { Badge, Button, Card, controlClass, cx } from "@/components/ui/primitives";
import { erpLogisticsTransporter } from "@/lib/actions/erp-logistics";
import { checkGstin } from "@/lib/engines/lead-scan";
import type { Transporter, TransporterGodown } from "@/lib/erp/logistics";
import { GODOWN_PLACE_KINDS, godownPlace, lookup, pickRung, placeChain, placeChoices, placePath, type PlaceLookup, type PlaceOption } from "@/lib/erp/transporter-godowns";
import { PLACE_FILTER_LABELS } from "@/lib/place-filters";
import { PLACE_KINDS } from "@/lib/place-parse";
import { PinField, parsePin } from "../../_ui/pin-field";
import { CallLink, Empty, useAct } from "./common";

/**
 * The transport companies logistics rings. Each company has its GST number,
 * what it calls its consignment number, its tracking page, and its godowns —
 * one town each, with the people there and up to three numbers per person.
 * Bills and LRs carry the transporter as a name, so a name here is what gives
 * a card its call button.
 */
type Load = { active: number; road: number };

const COLS = "grid-cols-[minmax(180px,1.4fr)_minmax(150px,1.2fr)_minmax(170px,1.2fr)_110px_120px]";

export function Transporters({ rows, tree, labels, load, canWrite }: { rows: Transporter[]; tree: PlaceOption[]; labels: string[]; load: Record<string, Load>; canWrite: boolean }) {
  const byId = useMemo(() => lookup(tree), [tree]);
  const [edit, setEdit] = useState<Transporter | "new" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const seen = rows.find((t) => t.id === open) ?? null;
  const loadOf = (t: Transporter) => load[t.name.toLowerCase()] ?? { active: 0, road: 0 };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-meta text-muted">
          {rows.length} transporter{rows.length === 1 ? "" : "s"} · {rows.reduce((n, t) => n + t.godowns.length, 0)} godowns
        </span>
        {canWrite ? (
          <Button variant="primary" size="sm" onClick={() => setEdit("new")}>
            Add transporter
          </Button>
        ) : null}
      </div>
      <Card className="overflow-hidden">
        <div className={`grid ${COLS} gap-3 border-b border-divider bg-canvas px-4 py-2 text-xs font-medium text-muted`}>
          <span>Transporter</span>
          <span>Godowns</span>
          <span>Main contact</span>
          <span>With them now</span>
          <span />
        </div>
        {rows.length ? (
          rows.map((t) => {
            const l = loadOf(t);
            return (
              <div
                key={t.id}
                onClick={() => setOpen(t.id)}
                className={`grid ${COLS} cursor-pointer items-center gap-3 border-b border-divider px-4 py-2.5 text-sm last:border-0 hover:bg-canvas`}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{t.name}</span>
                  {t.gstin || t.consignmentLabel ? (
                    <span className="block truncate text-xs text-muted">
                      {t.gstin ? <span className="font-mono">{t.gstin}</span> : null}
                      {t.gstin && t.consignmentLabel ? " · " : null}
                      {t.consignmentLabel}
                    </span>
                  ) : null}
                  {!t.active ? <Badge tone="muted">Not in use</Badge> : t.trackingUrl ? <span className="text-xs text-success">Online tracking</span> : null}
                </span>
                <GodownCell t={t} byId={byId} />
                <span className="min-w-0" onClick={(e) => e.stopPropagation()}>
                  {t.contactPerson ? <span className="block truncate text-meta text-body">{t.contactPerson}</span> : null}
                  <CallLink phone={t.phone} name={t.name} />
                </span>
                <span className="text-meta text-body">{l.active ? `${l.active} bill${l.active === 1 ? "" : "s"}${l.road ? ` · ${l.road} on road` : ""}` : "—"}</span>
                <span className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                  <Button size="sm" variant="ghost" onClick={() => setOpen(t.id)}>
                    View
                  </Button>
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
      <TransporterDetails
        t={seen}
        byId={byId}
        load={seen ? loadOf(seen) : null}
        canWrite={canWrite}
        onClose={() => setOpen(null)}
        onEdit={(t) => {
          setOpen(null);
          setEdit(t);
        }}
      />
      {edit ? (
        <EditTransporter
          key={edit === "new" ? "new" : edit.id}
          t={edit === "new" ? null : edit}
          labels={labels}
          tree={tree}
          byId={byId}
          onClose={() => setEdit(null)}
        />
      ) : null}
    </div>
  );
}

const townOf = (g: TransporterGodown, byId: PlaceLookup) => (g.placeId && byId.get(g.placeId)?.name) || g.address || "Town not picked";

/** The godowns' towns, the first two named; the full paths ride on the hover. */
function GodownCell({ t, byId }: { t: Transporter; byId: PlaceLookup }) {
  if (!t.godowns.length) return <span className="text-meta text-muted">None added</span>;
  const names = [...new Set(t.godowns.map((g) => townOf(g, byId)))];
  return (
    <span className="min-w-0" title={t.godowns.map((g) => [g.label, placePath(g.placeId, byId) || g.address].filter(Boolean).join(" — ")).join("\n")}>
      <span className="block truncate text-meta text-body">
        {names.slice(0, 2).join(", ")}
        {names.length > 2 ? <span className="text-muted"> +{names.length - 2}</span> : null}
      </span>
      <span className="block text-xs text-muted">
        {t.godowns.length} godown{t.godowns.length === 1 ? "" : "s"} · {t.godowns.reduce((n, g) => n + g.contacts.length, 0)} people
      </span>
    </span>
  );
}

/* ------------------------------------------------------------- details */

function TransporterDetails({
  t,
  byId,
  load,
  canWrite,
  onClose,
  onEdit,
}: {
  t: Transporter | null;
  byId: PlaceLookup;
  load: Load | null;
  canWrite: boolean;
  onClose: () => void;
  onEdit: (t: Transporter) => void;
}) {
  return (
    <Drawer open={!!t} onClose={onClose} width={560} label="Transporter">
      {t ? (
        <>
          <DrawerHeader onClose={onClose}>
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold text-ink">{t.name}</span>
              {!t.active ? <Badge tone="muted">Not in use</Badge> : null}
            </div>
          </DrawerHeader>
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <Fact k="GST number">{t.gstin ? <span className="font-mono">{t.gstin}</span> : null}</Fact>
              <Fact k="Consignment number is called">{t.consignmentLabel}</Fact>
              <Fact k="Online tracking">
                {t.trackingUrl ? (
                  <a href={t.trackingUrl.replace("{lr}", "")} target="_blank" rel="noreferrer" className="break-all">
                    {t.trackingUrl}
                  </a>
                ) : null}
              </Fact>
              <Fact k="With them now">{load?.active ? `${load.active} bill${load.active === 1 ? "" : "s"}${load.road ? ` · ${load.road} on the road` : ""}` : "Nothing"}</Fact>
            </dl>

            <section>
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-sm font-semibold text-ink">Godowns</h3>
                <span className="text-xs text-muted">{t.godowns.length || "None"}</span>
              </div>
              {t.godowns.length ? (
                <div className="space-y-3">
                  {t.godowns.map((g, i) => (
                    <div key={g.id} className="rounded-card border border-line">
                      <div className="border-b border-divider bg-canvas px-3 py-2">
                        <div className="text-sm font-medium text-ink">{g.label || `Godown ${i + 1}`}</div>
                        <div className="text-xs text-muted">{placePath(g.placeId, byId) || "Town not picked"}</div>
                        {g.lat != null && g.lng != null ? (
                          <a href={`https://www.google.com/maps?q=${g.lat},${g.lng}`} target="_blank" rel="noreferrer" className="mt-0.5 block text-xs">
                            Pin {g.lat.toFixed(5)}, {g.lng.toFixed(5)} — open the map
                          </a>
                        ) : (
                          <div className="mt-0.5 text-xs text-muted">No pin yet</div>
                        )}
                      </div>
                      {g.contacts.length ? (
                        <ul className="divide-y divide-divider">
                          {g.contacts.map((c) => (
                            <li key={c.id} className="flex items-start justify-between gap-3 px-3 py-2">
                              <span className="min-w-0">
                                <span className="block text-meta font-medium text-ink">{c.name || "No name"}</span>
                              </span>
                              <span className="flex shrink-0 flex-col items-end gap-0.5">
                                {c.phones.length ? c.phones.map((p) => <CallLink key={p} phone={p} name={c.name} />) : <span className="text-xs text-muted">No number</span>}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="px-3 py-2 text-xs text-muted">Nobody added here yet.</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-card border border-dashed border-line px-3 py-4 text-center text-meta text-muted">No godowns added yet.</div>
              )}
            </section>
          </div>
          {canWrite ? (
            <div className="flex justify-end border-t border-divider px-5 py-3">
              <Button variant="primary" onClick={() => onEdit(t)}>
                Edit
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </Drawer>
  );
}

function Fact({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="mt-0.5 text-ink">{children ?? <span className="text-muted">—</span>}</dd>
    </div>
  );
}

/* --------------------------------------------------------------- editing */

type DraftPerson = { key: string; id: string | null; name: string; role: string; phones: string[] };
/** `address` is not on the form any more; a godown that has one keeps it, unseen, so saving loses nothing. `pin` is "lat, lng" as typed. */
type DraftGodown = { key: string; id: string | null; label: string; placeId: string | null; address: string; pin: string; people: DraftPerson[] };

let seq = 0;
const k = () => `d${++seq}`;
const blankPerson = (): DraftPerson => ({ key: k(), id: null, name: "", role: "", phones: [""] });
const blankGodown = (): DraftGodown => ({ key: k(), id: null, label: "", placeId: null, address: "", pin: "", people: [blankPerson()] });

/** A typed pin as the save takes it. An unreadable one never gets here — `save` stops on it first. */
function pinOf(text: string): { lat: number | null; lng: number | null } {
  const p = text.trim() ? parsePin(text) : null;
  return p ? { lat: p.lat, lng: p.lng } : { lat: null, lng: null };
}

function EditTransporter({
  t,
  labels,
  tree,
  byId,
  onClose,
}: {
  t: Transporter | null;
  labels: string[];
  tree: PlaceOption[];
  byId: PlaceLookup;
  onClose: () => void;
}) {
  const { run, pending } = useAct();
  const [v, setV] = useState({ name: t?.name ?? "", gstin: t?.gstin ?? "", consignmentLabel: t?.consignmentLabel ?? "", trackingUrl: t?.trackingUrl ?? "", active: t?.active ?? true });
  const [godowns, setGodowns] = useState<DraftGodown[]>(() =>
    t?.godowns.length
      ? t.godowns.map((g) => ({
          key: k(),
          id: g.id,
          label: g.label ?? "",
          placeId: godownPlace(g.placeId, byId),
          address: g.address ?? "",
          pin: g.lat != null && g.lng != null ? `${g.lat.toFixed(6)}, ${g.lng.toFixed(6)}` : "",
          people: g.contacts.length ? g.contacts.map((c) => ({ key: k(), id: c.id, name: c.name ?? "", role: c.role ?? "", phones: c.phones.length ? c.phones : [""] })) : [blankPerson()],
        }))
      : [blankGodown()],
  );
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const labelOptions = v.consignmentLabel && !labels.includes(v.consignmentLabel) ? [...labels, v.consignmentLabel] : labels;

  const cls = controlClass({ className: "mt-1 block h-8.5" });
  const gst = checkGstin(v.gstin);
  const gstBad = !!gst && gst.check === "invalid";

  const setG = (key: string, patch: Partial<DraftGodown>) => setGodowns((gs) => gs.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  const setP = (gKey: string, pKey: string, patch: Partial<DraftPerson>) =>
    setGodowns((gs) => gs.map((g) => (g.key === gKey ? { ...g, people: g.people.map((p) => (p.key === pKey ? { ...p, ...patch } : p)) } : g)));

  const save = () => {
    const bad = godowns.findIndex((g) => g.pin.trim() && !parsePin(g.pin));
    if (bad >= 0) return setProblem({ field: `g${bad + 1}.pin`, message: "Write the pin as latitude, longitude — like 19.209400, 73.093900 — or pick it on the map" });
    return run(
      () =>
        erpLogisticsTransporter({
          id: t?.id ?? null,
          ...v,
          gstin: gst?.gstin ?? null,
          godowns: godowns.map((g) => ({
            id: g.id,
            label: g.label,
            placeId: g.placeId,
            address: g.address,
            ...pinOf(g.pin),
            contacts: g.people.map((p) => ({ id: p.id, name: p.name, role: p.role, phones: p.phones })),
          })),
        }),
      (r) => {
        if (r.ok) onClose();
        else setProblem(r.fieldErrors?.[0] ? { field: r.fieldErrors[0].field, message: r.fieldErrors[0].message } : null);
      },
    );
  };

  const errAt = (field: string) => (problem && problem.field.startsWith(field) ? problem.message : null);

  return (
    <Modal
      open
      onClose={onClose}
      width={780}
      title={t ? `Edit ${t.name}` : "Add a transporter"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={pending || !v.name.trim() || gstBad} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5 text-xs text-muted">
        <section>
          <SectionTitle>Company</SectionTitle>
          <div className="grid grid-cols-2 gap-3">
            <label className="col-span-2">
              Name (as it is written on bills and LRs)
              <input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} className={cls} />
              {errAt("name") ? <span className="mt-1 block text-danger">{errAt("name")}</span> : null}
            </label>
            <label>
              GST number
              <input
                value={v.gstin}
                onChange={(e) => setV({ ...v, gstin: e.target.value.toUpperCase() })}
                placeholder="27ABCDE1234F1Z5"
                maxLength={20}
                className={cx(cls, "font-mono", gstBad && "border-danger")}
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
                    onChange={(e) => setV({ ...v, consignmentLabel: e.target.value })}
                    placeholder="e.g. Docket Number"
                    className={cx(cls, "mt-0")}
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      setAdding(false);
                      if (!v.consignmentLabel.trim()) setV({ ...v, consignmentLabel: t?.consignmentLabel ?? "" });
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
            <label className="col-span-2">
              Online tracking page
              <input value={v.trackingUrl} onChange={(e) => setV({ ...v, trackingUrl: e.target.value })} placeholder="https://… with {lr} where the LR number goes" className={cls} />
              {errAt("trackingUrl") ? <span className="mt-1 block text-danger">{errAt("trackingUrl")}</span> : null}
            </label>
            <label className="col-span-2 flex items-center gap-2 text-sm text-body">
              <input type="checkbox" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} className="accent-brand" /> In use
            </label>
          </div>
        </section>

        <section>
          <SectionTitle hint="One place each — state and district, with its pin on the map — and the people to ring there.">Godowns</SectionTitle>
          <div className="space-y-3">
            {godowns.map((g, gi) => {
              const at = `g${gi + 1}`;
              const townErr = errAt(`${at}.placeId`);
              const pinErr = errAt(`${at}.pin`);
              return (
                <div key={g.key} className={cx("rounded-card border", townErr ? "border-danger" : "border-line")}>
                  <div className="flex items-center justify-between border-b border-divider bg-canvas px-3 py-2">
                    <span className="text-sm font-medium text-ink">Godown {gi + 1}</span>
                    {godowns.length > 1 ? (
                      <button type="button" onClick={() => setGodowns((gs) => gs.filter((x) => x.key !== g.key))} className="text-xs text-muted hover:text-danger">
                        Remove godown
                      </button>
                    ) : null}
                  </div>
                  <div className="space-y-3 px-3 py-3">
                    <label className="block">
                      Godown name
                      <input value={g.label} onChange={(e) => setG(g.key, { label: e.target.value })} placeholder="e.g. Main godown" className={cls} />
                    </label>
                    <div>
                      <div className="grid grid-cols-2 gap-2">
                        {GODOWN_PLACE_KINDS.map((kind) => {
                          const chain = placeChain(g.placeId, byId);
                          const opts = placeChoices(tree, kind, chain);
                          const above = PLACE_KINDS[PLACE_KINDS.indexOf(kind) - 1];
                          const off = !!above && !chain[above];
                          return (
                            <label key={kind} className="min-w-0">
                              {PLACE_FILTER_LABELS[kind]}
                              <select
                                value={chain[kind] ?? ""}
                                disabled={off}
                                aria-label={`${PLACE_FILTER_LABELS[kind]} for godown ${gi + 1}`}
                                onChange={(e) => setG(g.key, { placeId: pickRung(chain, kind, e.target.value || null) })}
                                className={cx(cls, "pr-7 disabled:bg-canvas disabled:text-muted", townErr && !chain[kind] && !off && "border-danger")}
                              >
                                <option value="">{off ? `Pick the ${PLACE_FILTER_LABELS[above].toLowerCase()} first` : opts.length ? `Pick a ${kind}` : "None listed"}</option>
                                {opts.map((o) => (
                                  <option key={o.id} value={o.id}>
                                    {o.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          );
                        })}
                      </div>
                      {townErr ? <span className="mt-1 block text-danger">{townErr}</span> : null}
                    </div>
                    <div>
                      <div className="mb-1">Location pin</div>
                      <PinField value={g.pin} error={!!pinErr} onChange={(pin) => setG(g.key, { pin })} />
                      {pinErr ? <span className="mt-1 block text-danger">{pinErr}</span> : <span className="mt-1 block text-xs text-muted">Latitude, longitude — pick it on the map, type it, or use this device&apos;s location when standing in the godown.</span>}
                    </div>

                    <div>
                      <div className="mb-1.5 text-xs font-medium text-body">People at this godown</div>
                      <div className="space-y-2">
                        {g.people.map((p, pi) => {
                          const pErr = errAt(`${at}.c${pi + 1}`);
                          return (
                            <div key={p.key}>
                              <div className="grid grid-cols-[1fr_1fr_auto] items-start gap-2">
                                <input value={p.name} onChange={(e) => setP(g.key, p.key, { name: e.target.value })} placeholder="Name" aria-label="Name" className={cx(cls, "mt-0", pErr && "border-danger")} />
                                {/* One number on the form; any further numbers a person was saved with ride along unseen. */}
                                <input
                                  value={p.phones[0] ?? ""}
                                  onChange={(e) => setP(g.key, p.key, { phones: [e.target.value, ...p.phones.slice(1)] })}
                                  inputMode="tel"
                                  placeholder="Phone number"
                                  aria-label="Phone number"
                                  className={cx(cls, "mt-0", pErr && "border-danger")}
                                />
                                <button
                                  type="button"
                                  onClick={() => setG(g.key, { people: g.people.filter((x) => x.key !== p.key) })}
                                  className="h-9 px-2 text-[16px] text-muted hover:text-danger"
                                  aria-label="Remove this person"
                                  title="Remove this person"
                                >
                                  ×
                                </button>
                              </div>
                              {pErr ? <span className="mt-1 block text-danger">{pErr}</span> : null}
                            </div>
                          );
                        })}
                      </div>
                      <button type="button" onClick={() => setG(g.key, { people: [...g.people, blankPerson()] })} className="mt-2 text-xs font-medium text-brand">
                        + Add a person
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            <Button size="sm" onClick={() => setGodowns((gs) => [...gs, blankGodown()])}>
              + Add another godown
            </Button>
          </div>
        </section>
      </div>
    </Modal>
  );
}

function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-2.5 border-b border-divider pb-1.5">
      <div className="text-sm font-semibold text-ink">{children}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}
