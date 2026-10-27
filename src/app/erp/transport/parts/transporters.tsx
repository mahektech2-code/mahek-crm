"use client";

import { useMemo, useState } from "react";
import { DialogBody, DialogFooter, DialogHeader, ErpDialog, TabBar, DialogTitle } from "../../_ui/dialog";
import { Button, Card, Checkbox, controlClass, cx, Field, Input, SectionLabel } from "@/components/ui/primitives";
import { Badge } from "../../_ui/badge";
import { gridHeadClass, IconButton, labelClass, LinkButton, linkClass, SubTitle } from "../../_ui/look";
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
      <Card className="overflow-clip">
        <div className={cx("grid gap-3 px-4 py-2", COLS, gridHeadClass)}>
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
                    <span className="block truncate text-meta text-muted">
                      {t.gstin ? <span className="font-mono">{t.gstin}</span> : null}
                      {t.gstin && t.consignmentLabel ? " · " : null}
                      {t.consignmentLabel}
                    </span>
                  ) : null}
                  {!t.active ? <Badge label="Not in use" tone="muted" /> : t.trackingUrl ? <span className="text-meta text-success">Online tracking</span> : null}
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
const incomplete = (g: { placeId: string | null }, byId: PlaceLookup) => !placeChain(g.placeId, byId).area;

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
      <span className="block text-meta text-muted">
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
  const [tab, setTab] = useState<"details" | "godowns">("details");
  if (!t) return null;
  return (
    <ErpDialog onClose={onClose} label="Transporter" size="md">
          <DialogHeader onClose={onClose}>
            <SectionLabel>Transporter</SectionLabel>
            <div className="mt-0.5 flex items-center gap-2">
              <DialogTitle>{t.name}</DialogTitle>
              {!t.active ? <Badge label="Not in use" tone="muted" /> : null}
            </div>
          </DialogHeader>
          <TabBar
            tabs={[
              { key: "details", label: "Details" },
              { key: "godowns", label: "Godowns", count: t.godowns.length },
            ]}
            active={tab}
            onChange={(k) => setTab(k as "details" | "godowns")}
          />
          <DialogBody>
            {tab === "details" ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
              <Fact k="GST number">{t.gstin ? <span className="font-mono">{t.gstin}</span> : null}</Fact>
              <Fact k="Consignment number is called">{t.consignmentLabel}</Fact>
              <Fact k="Online tracking">
                {t.trackingUrl ? (
                  <a href={t.trackingUrl.replace("{lr}", "")} target="_blank" rel="noreferrer" className={linkClass("brand", "break-all")}>
                    {t.trackingUrl}
                  </a>
                ) : null}
              </Fact>
              <Fact k="With them now">{load?.active ? `${load.active} bill${load.active === 1 ? "" : "s"}${load.road ? ` · ${load.road} on the road` : ""}` : "Nothing"}</Fact>
            </dl>
            ) : null}

            {tab === "godowns" ? (
            <section>
              {t.godowns.length ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
                  {t.godowns.map((g, i) => (
                    <div key={g.id} className="rounded-card border border-line">
                      <div className="border-b border-divider bg-canvas px-3 py-2">
                        <SubTitle className="mb-0">{g.label || `Godown ${i + 1}`}</SubTitle>
                        <div className="text-meta text-muted">{placePath(g.placeId, byId) || "Town not picked"}</div>
                        <div className="mt-0.5 text-meta">
                          {g.gstin ? <span className="font-mono text-body">GST {g.gstin}</span> : <span className="text-muted">No GST number</span>}
                          {incomplete(g, byId) ? <span className="text-warn-ink"> · City and area not picked yet</span> : null}
                        </div>
                        {g.lat != null && g.lng != null ? (
                          <a href={`https://www.google.com/maps?q=${g.lat},${g.lng}`} target="_blank" rel="noreferrer" className={linkClass("brand", "mt-0.5 block text-meta")}>
                            Pin {g.lat.toFixed(5)}, {g.lng.toFixed(5)} — open the map
                          </a>
                        ) : (
                          <div className="mt-0.5 text-meta text-muted">No pin yet</div>
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
                        <div className="px-3 py-2 text-meta text-muted">Nobody added here yet.</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-card border border-dashed border-line px-3 py-4 text-center text-meta text-muted">No godowns added yet.</div>
              )}
            </section>
            ) : null}
          </DialogBody>
          {canWrite ? (
            <DialogFooter>
              <Button variant="primary" onClick={() => onEdit(t)}>
                Edit
              </Button>
            </DialogFooter>
          ) : null}
    </ErpDialog>
  );
}

function Fact({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={labelClass}>{k}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children ?? <span className="text-muted">—</span>}</dd>
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
  const [tab, setTab] = useState<"company" | "godowns">("company");
  const labelOptions = v.consignmentLabel && !labels.includes(v.consignmentLabel) ? [...labels, v.consignmentLabel] : labels;

  const gst = checkGstin(v.gstin);
  const gstBad = !!gst && gst.check === "invalid";

  /** Which draft a server error like `g3.place.city` is about. */
  const problemAt = problem ? Number(/^g(\d+)\./.exec(problem.field)?.[1] ?? 0) - 1 : -1;

  const save = () =>
    run(
      () => erpLogisticsTransporter({ id: t?.id ?? null, ...v, gstin: gst?.gstin ?? null, godowns: godowns.map(asInput) }),
      (r) => {
        if (r.ok) return onClose();
        const fe = r.fieldErrors?.[0];
        setProblem(fe ? { field: fe.field, message: fe.message } : null);
        /* A godown's error is on the Godowns tab: go to it, or nobody sees it. */
        if (fe) setTab(/^g\d+\./.test(fe.field) ? "godowns" : "company");
      },
    );

  const errAt = (field: string) => (problem && problem.field.startsWith(field) ? problem.message : null);
  const open = editing === "new" ? null : godowns.find((g) => g.key === editing) ?? null;

  return (
    <>
      <ErpDialog onClose={onClose} size="md" label={t ? `Edit ${t.name}` : "Add a transporter"}>
        <DialogHeader onClose={onClose}>
          <DialogTitle>{t ? `Edit ${t.name}` : "Add a transporter"}</DialogTitle>
        </DialogHeader>
        <TabBar
          tabs={[
            { key: "company", label: "Company" },
            { key: "godowns", label: "Godowns", count: godowns.length },
          ]}
          active={tab}
          onChange={(x) => setTab(x as "company" | "godowns")}
        />
        <DialogBody>
          {tab === "company" ? (
          <section>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name (as it is written on bills and LRs)" error={errAt("name")} className="col-span-2">
                <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
              </Field>
              <Field
                label="Head office GST number"
                error={gstBad ? "This number does not check out. Check it against their bill." : null}
                hint={gst?.check === "corrected" ? `Will be saved as ${gst.gstin}.` : "Optional. Each godown can carry its own GST number below."}
              >
                <Input
                  value={v.gstin}
                  onChange={(e) => setV({ ...v, gstin: e.target.value.toUpperCase() })}
                  placeholder="27ABCDE1234F1Z5"
                  maxLength={20}
                  invalid={gstBad}
                  className="font-mono"
                />
              </Field>
              <Field label="Their consignment number is called">
                {adding ? (
                  <span className="flex gap-1.5">
                    <Input
                      autoFocus
                      value={v.consignmentLabel}
                      onChange={(e) => setV({ ...v, consignmentLabel: e.target.value })}
                      placeholder="e.g. Docket Number"
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
                    className={controlClass({ className: "h-8.5" })}
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
              </Field>
              <Field label="Online tracking page" error={errAt("trackingUrl")} className="col-span-2">
                <Input value={v.trackingUrl} onChange={(e) => setV({ ...v, trackingUrl: e.target.value })} placeholder="https://… with {lr} where the LR number goes" />
              </Field>
              <Checkbox label="In use" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} className="col-span-2" />
            </div>
          </section>
          ) : null}

          {tab === "godowns" ? (
          <section>
            <div className="mb-2.5 border-b border-divider pb-1.5">
              <SectionLabel>Godowns</SectionLabel>
              <div className="mt-0.5 text-meta text-muted">Each godown is a state, district, city and area, with its GST number if it has one, its pin and the people to ring there.</div>
            </div>
            <div className="space-y-2">
              {godowns.map((g, gi) => {
                const wrong = problemAt === gi ? problem?.message : null;
                const path = pickPath(g.place, byId);
                const owes = !g.place.area;
                const people = g.people.filter((p) => p.name.trim() || p.phones.some((x) => x.trim()));
                return (
                  <div key={g.key} className={cx("flex items-start gap-3 rounded-card border px-3 py-2.5", wrong ? "border-danger" : "border-line")}>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-ink">{g.label.trim() || `Godown ${gi + 1}`}</div>
                      <div className="truncate text-meta text-body">{path || "No place picked"}</div>
                      <div className="mt-0.5 text-meta text-muted">
                        {g.gstin.trim() ? <span className="font-mono text-body">GST {g.gstin.trim()}</span> : null}
                        {g.gstin.trim() ? " · " : null}
                        {people.length ? `${people.length} ${people.length === 1 ? "person" : "people"}` : "Nobody to ring yet"}
                        {g.pin.trim() ? " · pinned" : ""}
                      </div>
                      {wrong ? <div className="mt-1 text-meta text-danger">{wrong}</div> : owes ? <div className="mt-1 text-meta text-warn-ink">Needs its city and area before it saves.</div> : null}
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
          ) : null}
        </DialogBody>
        <DialogFooter left={problem && tab === "company" && /^g\d+\./.test(problem.field) ? <span className="text-danger">A godown needs fixing — see Godowns.</span> : null}>
          <Button onClick={onClose}>Cancel</Button>
          {tab === "company" ? (
            <Button onClick={() => setTab("godowns")}>Next: godowns</Button>
          ) : null}
          <Button variant="primary" disabled={pending || !v.name.trim() || gstBad} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </ErpDialog>
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

  const title = draft.id || draft.label ? `Godown ${number}${draft.label ? ` — ${draft.label}` : ""}` : "Add a godown";
  return (
    <ErpDialog onClose={onClose} label={title} width={640} tall={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <Field label="Godown name">
          <Input value={g.label} onChange={(e) => set({ label: e.target.value })} placeholder="e.g. Bhiwandi main godown" autoFocus />
        </Field>

        <div>
          <SectionLabel className="mb-1">Where it is — all four are needed</SectionLabel>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
            {GODOWN_PLACE_KINDS.map((kind) => (
              <PlaceRungField key={kind} kind={kind} pick={g.place} tree={tree} byId={byId} error={errAt(`place.${kind}`)} onChange={(place) => set({ place })} />
            ))}
          </div>
        </div>

        <Field label="GST number at this godown (optional)">
          <Input
            value={g.gstin}
            onChange={(e) => set({ gstin: e.target.value.toUpperCase() })}
            placeholder={stateName ? `Starts with the code for ${stateName}` : "27ABCDE1234F1Z5"}
            maxLength={20}
            invalid={!!(gstLive || errAt("gstin"))}
            className="font-mono"
          />
          {gstLive || errAt("gstin") ? (
            <span className="mt-1 block text-meta text-danger">{gstLive ?? errAt("gstin")}</span>
          ) : registered ? (
            <span className="mt-1 block text-meta text-success">Registered in {registered}.</span>
          ) : (
            <span className="mt-1 block text-meta text-muted">Optional. If given, GST is registered per state, so its first two digits must be the code for the state picked above.</span>
          )}
        </Field>

        <div>
          <SectionLabel className="mb-1">Location pin</SectionLabel>
          <PinField value={g.pin} error={!!errAt("pin")} onChange={(pin) => set({ pin })} />
          {errAt("pin") ? <span className="mt-1 block text-meta text-danger">{errAt("pin")}</span> : <span className="mt-1 block text-meta text-muted">Latitude, longitude — pick it on the map, type it, or use this device&apos;s location when standing in the godown.</span>}
        </div>

        <div>
          <SectionLabel className="mb-1.5">People at this godown</SectionLabel>
          <div className="space-y-2">
            {g.people.map((p, pi) => {
              const pErr = errAt(`c${pi + 1}`);
              return (
                <div key={p.key}>
                  <div className="grid grid-cols-[1fr_1fr_auto] items-start gap-2">
                    <Input value={p.name} onChange={(e) => setP(p.key, { name: e.target.value })} placeholder="Name" aria-label="Name" invalid={!!pErr} />
                    {/* One number on the form; any further numbers a person was saved with ride along unseen. */}
                    <Input
                      value={p.phones[0] ?? ""}
                      onChange={(e) => setP(p.key, { phones: [e.target.value, ...p.phones.slice(1)] })}
                      inputMode="tel"
                      placeholder="Phone number"
                      aria-label="Phone number"
                      invalid={!!pErr}
                    />
                    <IconButton label="Remove this person" tone="danger" className="text-base" onClick={() => set({ people: g.people.filter((x) => x.key !== p.key) })}>
                      ×
                    </IconButton>
                  </div>
                  {pErr ? <span className="mt-1 block text-meta text-danger">{pErr}</span> : null}
                </div>
              );
            })}
          </div>
          <LinkButton className="mt-2 text-meta" onClick={() => set({ people: [...g.people, blankPerson()] })}>
            + Add a person
          </LinkButton>
        </div>
        {problem && !/\.(place|gstin|pin|c\d)/.test(problem.field) ? <div className="text-meta text-danger">{problem.message}</div> : null}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={done}>
          Done
        </Button>
      </DialogFooter>
    </ErpDialog>
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
      <Field label={label} error={error} hint={`Added under ${rungName(aboveRung ?? undefined, byId)} when you save.`} className="min-w-0">
        <span className="flex gap-1.5">
          <Input
            value={rung?.name ?? ""}
            onChange={(e) => onChange(setRung(pick, kind, { name: e.target.value }))}
            placeholder={`New ${word} — type its name`}
            aria-label={`${label} (not listed)`}
            invalid={!!error}
            autoFocus={!typedAbove}
          />
          {!typedAbove ? (
            <Button size="sm" variant="ghost" onClick={() => onChange(setRung(pick, kind, null))} title="Pick from the list instead">
              List
            </Button>
          ) : null}
        </span>
      </Field>
    );

  const opts = placeChoices(tree, kind, pick);
  const extraStates = kind === "state" ? unlistedStates(tree) : [];
  const value = rung?.id ?? (rung?.name ? `state:${rung.name}` : "");
  return (
    <Field label={label} error={error} className="min-w-0">
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
        className={controlClass({ invalid: !!error, className: "h-8.5 pr-7 disabled:bg-canvas disabled:text-muted" })}
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
    </Field>
  );
}
