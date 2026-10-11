"use client";

import { useMemo, useState } from "react";
import { ComboBox } from "@/components/ui/combo-box";
import { Modal } from "@/components/ui/modal";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import { Badge, Button, Card, cx } from "@/components/ui/primitives";
import { erpLogisticsTransporter } from "@/lib/actions/erp-logistics";
import { checkGstin } from "@/lib/engines/lead-scan";
import type { Transporter, TransporterGodown } from "@/lib/erp/logistics";
import { MAX_PHONES, lookup, placePath, townOptions, type PlaceLookup, type PlaceOption } from "@/lib/erp/transporter-godowns";
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
  const towns = useMemo(() => townOptions(tree, byId), [tree, byId]);
  const [edit, setEdit] = useState<Transporter | "new" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const seen = rows.find((t) => t.id === open) ?? null;
  const loadOf = (t: Transporter) => load[t.name.toLowerCase()] ?? { active: 0, road: 0 };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-muted">
          {rows.length} transporter{rows.length === 1 ? "" : "s"} · {rows.reduce((n, t) => n + t.godowns.length, 0)} godowns
        </span>
        {canWrite ? (
          <Button variant="primary" size="sm" onClick={() => setEdit("new")}>
            Add transporter
          </Button>
        ) : null}
      </div>
      <Card className="overflow-hidden">
        <div className={`grid ${COLS} gap-3 border-b border-divider bg-canvas px-4 py-2 text-[12px] font-medium text-muted`}>
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
                    <span className="block truncate text-[12px] text-muted">
                      {t.gstin ? <span className="font-mono">{t.gstin}</span> : null}
                      {t.gstin && t.consignmentLabel ? " · " : null}
                      {t.consignmentLabel}
                    </span>
                  ) : null}
                  {!t.active ? <Badge tone="muted">Not in use</Badge> : t.trackingUrl ? <span className="text-[12px] text-success">Online tracking</span> : null}
                </span>
                <GodownCell t={t} byId={byId} />
                <span className="min-w-0" onClick={(e) => e.stopPropagation()}>
                  {t.contactPerson ? <span className="block truncate text-[13px] text-body">{t.contactPerson}</span> : null}
                  <CallLink phone={t.phone} name={t.name} />
                </span>
                <span className="text-[13px] text-body">{l.active ? `${l.active} bill${l.active === 1 ? "" : "s"}${l.road ? ` · ${l.road} on road` : ""}` : "—"}</span>
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
          towns={towns}
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
  if (!t.godowns.length) return <span className="text-[13px] text-muted">None added</span>;
  const names = [...new Set(t.godowns.map((g) => townOf(g, byId)))];
  return (
    <span className="min-w-0" title={t.godowns.map((g) => [g.label, placePath(g.placeId, byId) || g.address].filter(Boolean).join(" — ")).join("\n")}>
      <span className="block truncate text-[13px] text-body">
        {names.slice(0, 2).join(", ")}
        {names.length > 2 ? <span className="text-muted"> +{names.length - 2}</span> : null}
      </span>
      <span className="block text-[12px] text-muted">
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
                <span className="text-[12px] text-muted">{t.godowns.length || "None"}</span>
              </div>
              {t.godowns.length ? (
                <div className="space-y-3">
                  {t.godowns.map((g, i) => (
                    <div key={g.id} className="rounded-[6px] border border-line">
                      <div className="border-b border-divider bg-canvas px-3 py-2">
                        <div className="text-sm font-medium text-ink">{g.label || `Godown ${i + 1}`}</div>
                        <div className="text-[12px] text-muted">{placePath(g.placeId, byId) || "Town not picked"}</div>
                        {g.address ? <div className="mt-0.5 text-[12px] text-body">{g.address}</div> : null}
                      </div>
                      {g.contacts.length ? (
                        <ul className="divide-y divide-divider">
                          {g.contacts.map((c) => (
                            <li key={c.id} className="flex items-start justify-between gap-3 px-3 py-2">
                              <span className="min-w-0">
                                <span className="block text-[13px] font-medium text-ink">{c.name || "No name"}</span>
                                {c.role ? <span className="block text-[12px] text-muted">{c.role}</span> : null}
                              </span>
                              <span className="flex shrink-0 flex-col items-end gap-0.5">
                                {c.phones.length ? c.phones.map((p) => <CallLink key={p} phone={p} name={c.name} />) : <span className="text-[12px] text-muted">No number</span>}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="px-3 py-2 text-[12px] text-muted">Nobody added here yet.</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-[6px] border border-dashed border-line px-3 py-4 text-center text-[13px] text-muted">No godowns added yet.</div>
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
      <dt className="text-[12px] text-muted">{k}</dt>
      <dd className="mt-0.5 text-ink">{children ?? <span className="text-muted">—</span>}</dd>
    </div>
  );
}

/* --------------------------------------------------------------- editing */

type DraftPerson = { key: string; id: string | null; name: string; role: string; phones: string[] };
type DraftGodown = { key: string; id: string | null; label: string; town: string; placeId: string | null; address: string; people: DraftPerson[] };

let seq = 0;
const k = () => `d${++seq}`;
const blankPerson = (): DraftPerson => ({ key: k(), id: null, name: "", role: "", phones: [""] });
const blankGodown = (): DraftGodown => ({ key: k(), id: null, label: "", town: "", placeId: null, address: "", people: [blankPerson()] });

function EditTransporter({
  t,
  labels,
  towns,
  byId,
  onClose,
}: {
  t: Transporter | null;
  labels: string[];
  towns: { id: string; label: string }[];
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
          town: g.placeId ? placePath(g.placeId, byId) : "",
          placeId: g.placeId,
          address: g.address ?? "",
          people: g.contacts.length ? g.contacts.map((c) => ({ key: k(), id: c.id, name: c.name ?? "", role: c.role ?? "", phones: c.phones.length ? c.phones : [""] })) : [blankPerson()],
        }))
      : [blankGodown()],
  );
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const labelOptions = v.consignmentLabel && !labels.includes(v.consignmentLabel) ? [...labels, v.consignmentLabel] : labels;
  const idOfTown = useMemo(() => new Map(towns.map((o) => [o.label, o.id])), [towns]);
  const townLabels = useMemo(() => towns.map((o) => o.label), [towns]);

  const cls = "mt-1 block h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand";
  const gst = checkGstin(v.gstin);
  const gstBad = !!gst && gst.check === "invalid";

  const setG = (key: string, patch: Partial<DraftGodown>) => setGodowns((gs) => gs.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  const setP = (gKey: string, pKey: string, patch: Partial<DraftPerson>) =>
    setGodowns((gs) => gs.map((g) => (g.key === gKey ? { ...g, people: g.people.map((p) => (p.key === pKey ? { ...p, ...patch } : p)) } : g)));

  const save = () =>
    run(
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
            contacts: g.people.map((p) => ({ id: p.id, name: p.name, role: p.role, phones: p.phones })),
          })),
        }),
      (r) => {
        if (r.ok) onClose();
        else setProblem(r.fieldErrors?.[0] ? { field: r.fieldErrors[0].field, message: r.fieldErrors[0].message } : null);
      },
    );

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
      <div className="space-y-5 text-[12px] text-muted">
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
              <input type="checkbox" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} className="accent-[#6835FB]" /> In use
            </label>
          </div>
        </section>

        <section>
          <SectionTitle hint="One town each, and the people to ring there. Up to three numbers a person.">Godowns</SectionTitle>
          <div className="space-y-3">
            {godowns.map((g, gi) => {
              const at = `g${gi + 1}`;
              const townErr = errAt(`${at}.placeId`);
              return (
                <div key={g.key} className={cx("rounded-[6px] border", townErr ? "border-danger" : "border-line")}>
                  <div className="flex items-center justify-between border-b border-divider bg-canvas px-3 py-2">
                    <span className="text-sm font-medium text-ink">Godown {gi + 1}</span>
                    {godowns.length > 1 ? (
                      <button type="button" onClick={() => setGodowns((gs) => gs.filter((x) => x.key !== g.key))} className="text-[12px] text-muted hover:text-danger">
                        Remove godown
                      </button>
                    ) : null}
                  </div>
                  <div className="space-y-3 px-3 py-3">
                    <div className="grid grid-cols-[1fr_1.4fr] gap-3">
                      <label>
                        Godown name
                        <input value={g.label} onChange={(e) => setG(g.key, { label: e.target.value })} placeholder="e.g. Main godown" className={cls} />
                      </label>
                      <div>
                        Town
                        <div className="mt-1 [&_input]:h-9 [&_input]:w-full">
                          <ComboBox
                            value={g.town}
                            options={townLabels}
                            label={`Town for godown ${gi + 1}`}
                            placeholder="Search a city or area"
                            emptyHint="No town by that name on the list"
                            className="block w-full"
                            onChange={(text) => setG(g.key, { town: text, placeId: idOfTown.get(text) ?? null })}
                          />
                        </div>
                        {townErr ? (
                          <span className="mt-1 block text-danger">{townErr}</span>
                        ) : g.town && !g.placeId ? (
                          <span className="mt-1 block text-warn">Pick the town from the list.</span>
                        ) : null}
                      </div>
                    </div>
                    <label className="block">
                      Address
                      <input value={g.address} onChange={(e) => setG(g.key, { address: e.target.value })} placeholder="Building, street, landmark" className={cls} />
                    </label>

                    <div>
                      <div className="mb-1.5 text-[12px] font-medium text-body">People at this godown</div>
                      <div className="space-y-2">
                        {g.people.map((p, pi) => {
                          const pErr = errAt(`${at}.c${pi + 1}`);
                          return (
                            <div key={p.key} className={cx("rounded-[4px] border bg-surface p-2", pErr ? "border-danger" : "border-divider")}>
                              <div className="grid grid-cols-[1fr_1fr_auto] items-start gap-2">
                                <input value={p.name} onChange={(e) => setP(g.key, p.key, { name: e.target.value })} placeholder="Name" aria-label="Name" className={cx(cls, "mt-0")} />
                                <input value={p.role} onChange={(e) => setP(g.key, p.key, { role: e.target.value })} placeholder="Looks after (booking, delivery…)" aria-label="Looks after" className={cx(cls, "mt-0")} />
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
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                {p.phones.map((ph, i) => (
                                  <span key={i} className="flex items-center">
                                    <input
                                      value={ph}
                                      onChange={(e) => setP(g.key, p.key, { phones: p.phones.map((x, j) => (j === i ? e.target.value : x)) })}
                                      inputMode="tel"
                                      placeholder={`Phone ${i + 1}`}
                                      aria-label={`Phone ${i + 1}`}
                                      className={cx(cls, "mt-0 w-[150px]")}
                                    />
                                    {p.phones.length > 1 ? (
                                      <button
                                        type="button"
                                        onClick={() => setP(g.key, p.key, { phones: p.phones.filter((_, j) => j !== i) })}
                                        className="px-1 text-muted hover:text-danger"
                                        aria-label={`Remove phone ${i + 1}`}
                                      >
                                        ×
                                      </button>
                                    ) : null}
                                  </span>
                                ))}
                                {p.phones.length < MAX_PHONES ? (
                                  <button type="button" onClick={() => setP(g.key, p.key, { phones: [...p.phones, ""] })} className="text-[12px] font-medium text-brand">
                                    + Another number
                                  </button>
                                ) : null}
                              </div>
                              {pErr ? <span className="mt-1 block text-danger">{pErr}</span> : null}
                            </div>
                          );
                        })}
                      </div>
                      <button type="button" onClick={() => setG(g.key, { people: [...g.people, blankPerson()] })} className="mt-2 text-[12px] font-medium text-brand">
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
      {hint ? <div className="mt-0.5 text-[12px] text-muted">{hint}</div> : null}
    </div>
  );
}
