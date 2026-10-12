"use client";

import { useMemo, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import { Badge, Button, Card, controlClass, cx } from "@/components/ui/primitives";
import { erpLogisticsTransporter } from "@/lib/actions/erp-logistics";
import { checkGstin } from "@/lib/engines/lead-scan";
import type { Transporter, TransporterGodown } from "@/lib/erp/logistics";
import {
  GODOWN_PLACE_KINDS,
  cleanGodowns,
  godownGstProblem,
  lookup,
  pickOf,
  pickPath,
  placeChain,
  placeChoices,
  placePath,
  rungName,
  setRung,
  unlistedStates,
  type PlaceLookup,
  type PlaceOption,
  type PlacePick,
} from "@/lib/erp/transporter-godowns";
import { gstState } from "@/lib/engines/lead-scan";
import { PLACE_FILTER_LABELS } from "@/lib/place-filters";
import { PLACE_KINDS, type PlaceKind } from "@/lib/place-parse";
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

const COLS = "grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_96px_96px]";

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
          {rows.length ? `${rows.length} transporter${rows.length === 1 ? "" : "s"} · ${rows.reduce((n, t) => n + t.godowns.length, 0)} godowns` : null}
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

/** The godown's city — the rung people say a godown is "in" — falling back to the district for one saved before the city was asked. */
function townOf(g: TransporterGodown, byId: PlaceLookup): string {
  const chain = placeChain(g.placeId, byId);
  return (chain.city && byId.get(chain.city)?.name) || (chain.district && byId.get(chain.district)?.name) || g.address || "Town not picked";
}

/** Whether a stored godown still owes the fields the dialog now requires. */
const incomplete = (g: { placeId: string | null; gstin: string | null }, byId: PlaceLookup) => !placeChain(g.placeId, byId).area || !g.gstin;

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
                        <div className="mt-0.5 text-xs">
                          {g.gstin ? <span className="font-mono text-body">GST {g.gstin}</span> : <span className="text-warning">No GST number yet</span>}
                          {incomplete(g, byId) && g.gstin ? <span className="text-warning"> · City and area not picked yet</span> : null}
                        </div>
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
type DraftGodown = { key: string; id: string | null; label: string; place: PlacePick; gstin: string; address: string; pin: string; people: DraftPerson[] };

let seq = 0;
const k = () => `d${++seq}`;
const blankPerson = (): DraftPerson => ({ key: k(), id: null, name: "", role: "", phones: [""] });
const blankGodown = (): DraftGodown => ({ key: k(), id: null, label: "", place: {}, gstin: "", address: "", pin: "", people: [blankPerson()] });

/** A typed pin as the save takes it. An unreadable one never gets here — the godown dialog stops on it first. */
function pinOf(text: string): { lat: number | null; lng: number | null } {
  const p = text.trim() ? parsePin(text) : null;
  return p ? { lat: p.lat, lng: p.lng } : { lat: null, lng: null };
}

/** A draft godown as the save (and the dialog's own check) takes it. */
const asInput = (g: DraftGodown) => ({
  id: g.id,
  label: g.label,
  place: g.place,
  gstin: g.gstin,
  address: g.address,
  ...pinOf(g.pin),
  contacts: g.people.map((p) => ({ id: p.id, name: p.name, role: p.role, phones: p.phones })),
});

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
    (t?.godowns ?? []).map((g) => ({
      key: k(),
      id: g.id,
      label: g.label ?? "",
      place: pickOf(g.placeId, byId),
      gstin: g.gstin ?? "",
      address: g.address ?? "",
      pin: g.lat != null && g.lng != null ? `${g.lat.toFixed(6)}, ${g.lng.toFixed(6)}` : "",
      people: g.contacts.length ? g.contacts.map((c) => ({ key: k(), id: c.id, name: c.name ?? "", role: c.role ?? "", phones: c.phones.length ? c.phones : [""] })) : [blankPerson()],
    })),
  );
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);
  const [adding, setAdding] = useState(false);
  /** The godown open in its own dialog: an existing draft's key, or "new". */
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const labelOptions = v.consignmentLabel && !labels.includes(v.consignmentLabel) ? [...labels, v.consignmentLabel] : labels;

  const cls = controlClass({ className: "mt-1 block h-8.5" });
  const gst = checkGstin(v.gstin);
  const gstBad = !!gst && gst.check === "invalid";

  /** Which draft a server error like `g3.place.city` is about. */
  const problemAt = problem ? Number(/^g(\d+)\./.exec(problem.field)?.[1] ?? 0) - 1 : -1;

  const save = () =>
    run(
      () => erpLogisticsTransporter({ id: t?.id ?? null, ...v, gstin: gst?.gstin ?? null, godowns: godowns.map(asInput) }),
      (r) => {
        if (r.ok) onClose();
        else setProblem(r.fieldErrors?.[0] ? { field: r.fieldErrors[0].field, message: r.fieldErrors[0].message } : null);
      },
    );

  const errAt = (field: string) => (problem && problem.field.startsWith(field) ? problem.message : null);
  const open = editing === "new" ? null : godowns.find((g) => g.key === editing) ?? null;

  return (
    <>
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
                Head office GST number
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
                ) : (
                  <span className="mt-1 block">Optional. Each godown carries its own GST number below.</span>
                )}
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
            <SectionTitle hint="Each godown is a state, district, city and area, with its own GST number, its pin and the people to ring there.">Godowns</SectionTitle>
            <div className="space-y-2">
              {godowns.map((g, gi) => {
                const wrong = problemAt === gi ? problem?.message : null;
                const path = pickPath(g.place, byId);
                const owes = !g.place.area || !g.gstin.trim();
                const people = g.people.filter((p) => p.name.trim() || p.phones.some((x) => x.trim()));
                return (
                  <div key={g.key} className={cx("flex items-start gap-3 rounded-card border px-3 py-2.5", wrong ? "border-danger" : "border-line")}>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-ink">{g.label.trim() || `Godown ${gi + 1}`}</div>
                      <div className="truncate text-xs text-body">{path || "No place picked"}</div>
                      <div className="mt-0.5 text-xs">
                        {g.gstin.trim() ? <span className="font-mono text-body">GST {g.gstin.trim()}</span> : null}
                        {g.gstin.trim() ? " · " : null}
                        {people.length ? `${people.length} ${people.length === 1 ? "person" : "people"}` : "Nobody to ring yet"}
                        {g.pin.trim() ? " · pinned" : ""}
                      </div>
                      {wrong ? <div className="mt-1 text-danger">{wrong}</div> : owes ? <div className="mt-1 text-warning">Needs {[!g.place.area && "its city and area", !g.gstin.trim() && "a GST number"].filter(Boolean).join(" and ")} before it saves.</div> : null}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button size="sm" onClick={() => setEditing(g.key)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setGodowns((gs) => gs.filter((x) => x.key !== g.key))} title="Remove this godown">
                        Remove
                      </Button>
                    </div>
                  </div>
                );
              })}
              {!godowns.length ? <div className="rounded-card border border-dashed border-line px-3 py-4 text-center text-meta text-muted">No godowns yet.</div> : null}
              <Button size="sm" onClick={() => setEditing("new")}>
                + Add a godown
              </Button>
            </div>
          </section>
        </div>
      </Modal>
      {editing ? (
        <GodownDialog
          key={editing}
          draft={open ?? blankGodown()}
          number={open ? godowns.indexOf(open) + 1 : godowns.length + 1}
          tree={tree}
          byId={byId}
          serverProblem={open && problemAt === godowns.indexOf(open) ? problem : null}
          onClose={() => setEditing(null)}
          onDone={(d) => {
            setGodowns((gs) => (open ? gs.map((x) => (x.key === d.key ? d : x)) : [...gs, d]));
            if (open && problemAt === godowns.indexOf(open)) setProblem(null);
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * One godown, in its own dialog: its name, the four rungs of where it is,
 * its GST number, its pin and its people. "Done" checks it with the same
 * `cleanGodowns` the save runs, so a godown that closes here is one the save
 * will take; nothing is written until the transporter is saved.
 */
function GodownDialog({
  draft,
  number,
  tree,
  byId,
  serverProblem,
  onClose,
  onDone,
}: {
  draft: DraftGodown;
  number: number;
  tree: PlaceOption[];
  byId: PlaceLookup;
  serverProblem: { field: string; message: string } | null;
  onClose: () => void;
  onDone: (g: DraftGodown) => void;
}) {
  const [g, setG] = useState(draft);
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(serverProblem ? { field: serverProblem.field.replace(/^g\d+/, "g1"), message: serverProblem.message } : null);
  const cls = controlClass({ className: "mt-1 block h-8.5" });
  const set = (patch: Partial<DraftGodown>) => setG((x) => ({ ...x, ...patch }));
  const setP = (pKey: string, patch: Partial<DraftPerson>) => set({ people: g.people.map((p) => (p.key === pKey ? { ...p, ...patch } : p)) });
  const errAt = (field: string) => (problem && problem.field.startsWith(`g1.${field}`) ? problem.message.replace(/^[^:]*: /, "") : null);

  const stateName = rungName(g.place.state, byId);
  const gstLive = g.gstin.trim().length >= 15 ? godownGstProblem(g.gstin, stateName) : null;
  const registered = g.gstin.trim().length >= 15 && !gstLive ? gstState(g.gstin.trim().toUpperCase()) : null;

  const done = () => {
    if (g.pin.trim() && !parsePin(g.pin)) return setProblem({ field: "g1.pin", message: "Write the pin as latitude, longitude — like 19.209400, 73.093900 — or pick it on the map" });
    const c = cleanGodowns([asInput(g)], tree);
    if (!c.ok) return setProblem(c);
    onDone(g);
  };

  return (
    <Modal
      open
      onClose={onClose}
      width={640}
      title={draft.id || draft.label ? `Godown ${number}${draft.label ? ` — ${draft.label}` : ""}` : "Add a godown"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={done}>
            Done
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-xs text-muted">
        <label className="block">
          Godown name
          <input value={g.label} onChange={(e) => set({ label: e.target.value })} placeholder="e.g. Bhiwandi main godown" className={cls} autoFocus />
        </label>

        <div>
          <div className="mb-1 text-xs font-medium text-body">Where it is — all four are needed</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
            {GODOWN_PLACE_KINDS.map((kind) => (
              <PlaceRungField key={kind} kind={kind} pick={g.place} tree={tree} byId={byId} error={errAt(`place.${kind}`)} onChange={(place) => set({ place })} />
            ))}
          </div>
        </div>

        <label className="block">
          GST number at this godown
          <input
            value={g.gstin}
            onChange={(e) => set({ gstin: e.target.value.toUpperCase() })}
            placeholder={stateName ? `Starts with the code for ${stateName}` : "27ABCDE1234F1Z5"}
            maxLength={20}
            className={cx(cls, "font-mono", (gstLive || errAt("gstin")) && "border-danger")}
          />
          {gstLive || errAt("gstin") ? (
            <span className="mt-1 block text-danger">{gstLive ?? errAt("gstin")}</span>
          ) : registered ? (
            <span className="mt-1 block text-success">Registered in {registered}.</span>
          ) : (
            <span className="mt-1 block">GST is registered per state, so its first two digits must be the code for the state picked above.</span>
          )}
        </label>

        <div>
          <div className="mb-1">Location pin</div>
          <PinField value={g.pin} error={!!errAt("pin")} onChange={(pin) => set({ pin })} />
          {errAt("pin") ? <span className="mt-1 block text-danger">{errAt("pin")}</span> : <span className="mt-1 block">Latitude, longitude — pick it on the map, type it, or use this device&apos;s location when standing in the godown.</span>}
        </div>

        <div>
          <div className="mb-1.5 text-xs font-medium text-body">People at this godown</div>
          <div className="space-y-2">
            {g.people.map((p, pi) => {
              const pErr = errAt(`c${pi + 1}`);
              return (
                <div key={p.key}>
                  <div className="grid grid-cols-[1fr_1fr_auto] items-start gap-2">
                    <input value={p.name} onChange={(e) => setP(p.key, { name: e.target.value })} placeholder="Name" aria-label="Name" className={cx(cls, "mt-0", pErr && "border-danger")} />
                    {/* One number on the form; any further numbers a person was saved with ride along unseen. */}
                    <input
                      value={p.phones[0] ?? ""}
                      onChange={(e) => setP(p.key, { phones: [e.target.value, ...p.phones.slice(1)] })}
                      inputMode="tel"
                      placeholder="Phone number"
                      aria-label="Phone number"
                      className={cx(cls, "mt-0", pErr && "border-danger")}
                    />
                    <button
                      type="button"
                      onClick={() => set({ people: g.people.filter((x) => x.key !== p.key) })}
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
          <button type="button" onClick={() => set({ people: [...g.people, blankPerson()] })} className="mt-2 text-xs font-medium text-brand">
            + Add a person
          </button>
        </div>
        {problem && !/\.(place|gstin|pin|c\d)/.test(problem.field) ? <div className="text-danger">{problem.message}</div> : null}
      </div>
    </Modal>
  );
}

/**
 * One rung of where a godown is. A list of what is filed under the rung
 * above, with "+ Add … not listed" at its foot; once added, a box to type the
 * name in. Under a rung that was itself added there is nothing filed yet, so
 * the box is all there is. A state is never typed — the list ends with the
 * rest of the country.
 */
function PlaceRungField({ kind, pick, tree, byId, error, onChange }: { kind: PlaceKind; pick: PlacePick; tree: PlaceOption[]; byId: PlaceLookup; error: string | null; onChange: (p: PlacePick) => void }) {
  const cls = controlClass({ className: "mt-1 block h-8.5" });
  const label = PLACE_FILTER_LABELS[kind];
  const above = PLACE_KINDS[PLACE_KINDS.indexOf(kind) - 1];
  const aboveRung = above ? pick[above] : null;
  const off = !!above && !aboveRung;
  const rung = pick[kind];
  const typedAbove = !!aboveRung && !aboveRung.id;
  const typing = kind !== "state" && (typedAbove || (!!rung && !rung.id));
  const word = label.toLowerCase();

  if (typing)
    return (
      <label className="min-w-0">
        {label}
        <span className="mt-1 flex gap-1.5">
          <input
            value={rung?.name ?? ""}
            onChange={(e) => onChange(setRung(pick, kind, { name: e.target.value }))}
            placeholder={`New ${word} — type its name`}
            aria-label={`${label} (not listed)`}
            className={cx(cls, "mt-0", error && "border-danger")}
            autoFocus={!typedAbove}
          />
          {!typedAbove ? (
            <Button size="sm" variant="ghost" onClick={() => onChange(setRung(pick, kind, null))} title="Pick from the list instead">
              List
            </Button>
          ) : null}
        </span>
        <span className={cx("mt-1 block", error ? "text-danger" : "")}>{error ?? `Added under ${rungName(aboveRung ?? undefined, byId)} when you save.`}</span>
      </label>
    );

  const opts = placeChoices(tree, kind, pick);
  const extraStates = kind === "state" ? unlistedStates(tree) : [];
  const value = rung?.id ?? (rung?.name ? `state:${rung.name}` : "");
  return (
    <label className="min-w-0">
      {label}
      <select
        value={value}
        disabled={off}
        aria-label={label}
        onChange={(e) => {
          const val = e.target.value;
          if (val === "__add") onChange(setRung(pick, kind, { name: "" }));
          else if (val.startsWith("state:")) onChange(setRung(pick, kind, { name: val.slice(6) }));
          else onChange(setRung(pick, kind, val ? { id: val } : null));
        }}
        className={cx(cls, "pr-7 disabled:bg-canvas disabled:text-muted", error && "border-danger")}
      >
        <option value="">{off ? `Pick the ${PLACE_FILTER_LABELS[above].toLowerCase()} first` : `Pick a ${word}`}</option>
        {opts.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
        {extraStates.length ? (
          <optgroup label="Rest of the country">
            {extraStates.map((s) => (
              <option key={s} value={`state:${s}`}>
                {s}
              </option>
            ))}
          </optgroup>
        ) : null}
        {kind !== "state" && !off ? <option value="__add">+ Add a {word} not listed…</option> : null}
      </select>
      {error ? <span className="mt-1 block text-danger">{error}</span> : null}
    </label>
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
