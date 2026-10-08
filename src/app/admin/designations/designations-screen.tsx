"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, Field, Input, Select, Td, Th, Tr, cx } from "@/components/ui/primitives";
import { ConfirmDialog, Modal, RowMenu } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { getModule, isAlwaysOpen, moduleGroupsForApp, moduleKeysForApp } from "@/lib/modules";
import { ERP_POWERS, ERP_POWER_LABEL, type ErpPower } from "@/lib/erp/powers";
import { describeDiff, grantableModules, type ErpLevel } from "@/lib/erp/designations";
import { DEPARTMENT_SEATS, SEAT_LABEL, departmentsOf, isDepartmentSeat, type ErpDepartmentSeat } from "@/lib/erp/departments";
import { deleteErpDesignation, saveErpDesignation } from "@/lib/actions/erp-designations";
import { erpStartViewAs } from "@/lib/actions/erp";
import type { DesignationWithMembers } from "@/lib/services/erp-designation-service";
import { ADMIN } from "@/lib/admin-routes";
import { AdminPage } from "../_shell/admin-page";

/* ---------------------------------------------------------------------------
 * ERP DESIGNATIONS — the jobs the ERP is worked by, each a level, a set of
 * screens and a set of powers with a name on it.
 *
 * The list answers the two questions somebody arrives with: what does a
 * Quality tester get, and who is one. The editor answers the third — if I
 * change this, who moves — on a review page BEFORE anything is written,
 * naming the people who move with it and the customised ones it leaves alone.
 * ------------------------------------------------------------------------- */

const LEVELS: { id: ErpLevel; label: string; line: string }[] = [
  { id: "associate", label: "Associate", line: "Works the screens ticked below." },
  { id: "manager", label: "Manager", line: "Also verifies expenses, edits recipes and help videos, and runs the alert checks." },
  { id: "admin", label: "Admin — everything in the ERP", line: "Every power, without a tick. Keep it for the owner." },
];
const levelLabel = (l: ErpLevel) => LEVELS.find((x) => x.id === l)?.label ?? l;
const ALL = moduleKeysForApp("erp");
const GRANTABLE = grantableModules(ALL);
const screenLabel = (k: string) => getModule(k)?.label ?? k;
const powerLabel = (p: string) => ERP_POWER_LABEL[p as ErpPower]?.label ?? p;

export function DesignationsScreen({ roster }: { roster: DesignationWithMembers[] }) {
  const router = useRouter();
  const { push } = useToast();
  const [editing, setEditing] = React.useState<DesignationWithMembers | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<DesignationWithMembers | null>(null);
  const holders = roster.reduce((n, d) => n + d.members.length, 0);
  const customised = roster.reduce((n, d) => n + d.members.filter((m) => !m.matches).length, 0);

  const viewAs = (id: string) =>
    void erpStartViewAs({ kind: "designation", id }).then((r) => {
      if (r.ok) router.push("/erp");
      else push(r.error, "error");
    });

  return (
    <AdminPage
      title="ERP designations"
      subtitle="The jobs the ERP is worked by. Each one is a level, a set of screens and a set of powers with a name on it — give somebody one on the Access screen, and an edit here moves everybody who still holds exactly it."
      actions={
        <Button variant="primary" onClick={() => setEditing("new")}>
          New designation
        </Button>
      }
    >
      <div className="mt-5 flex flex-wrap items-center gap-2 text-[13px] text-muted">
        {roster.length} designations · {holders} {holders === 1 ? "person holds" : "people hold"} one
        {customised ? ` · ${customised} customised` : ""}
      </div>

      <Card className="mt-3 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Designations"
          hint="Customised means somebody's access was changed by hand after the designation was given. They keep the name, and an edit to the designation leaves them where they are."
        />
        {roster.length === 0 ? (
          <EmptyState title="No designations yet" body="Create one to give the ERP's jobs a name and a shape." />
        ) : (
          <div className="overflow-auto">
            {/* PROSE COLUMNS, so they wrap — the one table here whose cells are
                sentences and lists rather than values somebody scans. */}
            <table className="w-full min-w-[1080px] table-fixed">
              <thead>
                <tr>
                  <Th className="w-[25%]">Designation</Th>
                  <Th className="w-[11%]">Level</Th>
                  <Th className="w-[24%]">Screens</Th>
                  <Th className="w-[18%]">Powers</Th>
                  <Th className="w-[14%]">Held by</Th>
                  <Th className="w-[8%]" />
                </tr>
              </thead>
              <tbody>
                {roster.map((d, i) => (
                  <Tr key={d.id} className={i % 2 ? "bg-canvas" : ""}>
                    <Td className="py-2.5 align-top whitespace-normal">
                      <button
                        onClick={() => setEditing(d)}
                        className="cursor-pointer border-0 bg-transparent p-0 text-left text-sm font-medium text-ink hover:text-brand"
                      >
                        {d.name}
                      </button>
                      {d.description ? <span className="block text-[13px] leading-[18px] text-muted">{d.description}</span> : null}
                      {d.department ? (
                        <span className="mt-1 inline-block">
                          <Badge tone="brand">{SEAT_LABEL[d.department]} department</Badge>
                        </span>
                      ) : null}
                    </Td>
                    <Td className="py-2.5 align-top text-[13px] whitespace-normal">{levelLabel(d.level)}</Td>
                    <Td className="py-2.5 align-top text-[13px] whitespace-normal">
                      {d.allScreens ? (
                        <span className="text-body">Every screen</span>
                      ) : (
                        <span className="text-body" title={d.modules.map(screenLabel).join(", ")}>
                          {d.modules.length} of {GRANTABLE.length}
                          <span className="block text-muted">{d.modules.map(screenLabel).join(", ")}</span>
                        </span>
                      )}
                    </Td>
                    <Td className="py-2.5 align-top text-[13px] whitespace-normal">
                      {d.level === "admin" ? (
                        <span className="text-body">Every power</span>
                      ) : d.powers.length ? (
                        <span className="text-body">{d.powers.map(powerLabel).join(", ")}</span>
                      ) : (
                        <span className="text-muted">None</span>
                      )}
                    </Td>
                    <Td className="py-2.5 align-top text-[13px] whitespace-normal">
                      {d.members.length === 0 ? (
                        <span className="text-muted">Nobody yet</span>
                      ) : (
                        <span className="flex flex-col gap-0.5">
                          {d.members.slice(0, 5).map((m) => (
                            <span key={m.userId} className="inline-flex flex-wrap items-center gap-1.5">
                              <Link href={ADMIN.person(m.userId)} className={cx(!m.active && "text-muted line-through")}>
                                {m.name}
                              </Link>
                              {m.matches ? null : (
                                <Badge
                                  tone="warn"
                                  title={`${describeDiff(m.diff, screenLabel, powerLabel).join("; ")}. An edit here leaves them alone.`}
                                >
                                  customised
                                </Badge>
                              )}
                            </span>
                          ))}
                          <Link href={ADMIN.accessForDesignation(d.id)} className="text-[12px]">
                            {d.members.length > 5 ? `All ${d.members.length} on Access` : "See on Access"}
                          </Link>
                        </span>
                      )}
                    </Td>
                    <Td className="py-2 align-top">
                      <span className="flex justify-end gap-1.5">
                        <Button size="sm" variant="secondary" onClick={() => setEditing(d)}>
                          Edit
                        </Button>
                        <RowMenu
                          items={[
                            {
                              label: "Preview the ERP as this",
                              title: "Opens the ERP read-only, exactly as somebody holding this designation sees it",
                              onSelect: () => viewAs(d.id),
                            },
                            { label: "Delete", destructive: true, onSelect: () => setDeleting(d) },
                          ]}
                        />
                      </span>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing ? (
        <DesignationEditor
          key={editing === "new" ? "new" : editing.id}
          designation={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            push(message);
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={!!deleting}
        title={deleting ? `Delete ${deleting.name}?` : ""}
        body={
          deleting?.members.length
            ? `${deleting.members.length} ${deleting.members.length === 1 ? "person holds" : "people hold"} it. They keep every screen and power they have now — only the name goes, and edits stop reaching them.`
            : "Nobody holds it. It is removed from the Access screen's list."
        }
        confirmLabel="Delete"
        destructive
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          const r = await deleteErpDesignation(deleting.id);
          push(r.ok ? (r.message ?? "Deleted.") : r.error, r.ok ? "info" : "error");
          setDeleting(null);
          if (r.ok) router.refresh();
        }}
      />
    </AdminPage>
  );
}

/* --------------------------------------------------------------- editor */

function DesignationEditor({
  designation,
  onClose,
  onSaved,
}: {
  designation: DesignationWithMembers | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [step, setStep] = React.useState<"edit" | "review">("edit");
  const [name, setName] = React.useState(designation?.name ?? "");
  const [description, setDescription] = React.useState(designation?.description ?? "");
  const [level, setLevel] = React.useState<ErpLevel>(designation?.level ?? "associate");
  const [allScreens, setAllScreens] = React.useState(designation?.allScreens ?? false);
  const [modules, setModules] = React.useState<string[]>(designation?.modules ?? []);
  const [powers, setPowers] = React.useState<string[]>(designation?.powers ?? []);
  const [department, setDepartment] = React.useState<ErpDepartmentSeat | null>(designation?.department ?? null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  const groups = moduleGroupsForApp("erp").map((g) => ({ ...g, modules: g.modules.filter((m) => !isAlwaysOpen(m.key)) })).filter((g) => g.modules.length);
  const toggle = (list: string[], k: string) => (list.includes(k) ? list.filter((x) => x !== k) : [...list, k]);

  const members = designation?.members ?? [];
  const moving = members.filter((m) => m.matches);
  const staying = members.filter((m) => !m.matches);

  const before = designation;
  const changeLines: string[] = [];
  if (!before) changeLines.push(`A new designation, ${name.trim() || "unnamed"}.`);
  else {
    if (before.name !== name.trim()) changeLines.push(`Renamed from ${before.name}.`);
    if (before.level !== level) changeLines.push(`Level ${levelLabel(before.level)} → ${levelLabel(level)}.`);
    if (before.allScreens !== allScreens) changeLines.push(allScreens ? "Now every screen, including ones built later." : "No longer every screen.");
    if (!allScreens) {
      const was = new Set(before.allScreens ? GRANTABLE : before.modules);
      const added = modules.filter((k) => !was.has(k));
      const removed = [...was].filter((k) => !modules.includes(k));
      if (added.length) changeLines.push(`Adds ${added.map(screenLabel).join(", ")}.`);
      if (removed.length) changeLines.push(`Takes away ${removed.map(screenLabel).join(", ")}.`);
    }
    if (level !== "admin") {
      const was = new Set<string>(before.level === "admin" ? [] : before.powers);
      const added = powers.filter((p) => !was.has(p));
      const removed = [...was].filter((p) => !powers.includes(p));
      if (added.length) changeLines.push(`Adds the power to ${added.map(powerLabel).join(", ").toLowerCase()}.`);
      if (removed.length) changeLines.push(`Takes away the power to ${removed.map(powerLabel).join(", ").toLowerCase()}.`);
    }
    if ((before.description ?? "") !== description.trim()) changeLines.push("Description reworded.");
    if ((before.department ?? null) !== department)
      changeLines.push(department ? `Works in ${SEAT_LABEL[department]}${before.department ? ` (was ${SEAT_LABEL[before.department]})` : ""}.` : "No longer a production department.");
  }

  const save = () => {
    setSaving(true);
    setErrors({});
    void saveErpDesignation({ id: designation?.id ?? null, name, description, level, allScreens, modules, powers, department }).then((r) => {
      setSaving(false);
      if (r.ok) return onSaved(r.message ?? "Saved.");
      if (r.fieldErrors?.length) {
        setErrors(Object.fromEntries(r.fieldErrors.map((f) => [f.field, f.message])));
        setStep("edit");
      } else setErrors({ form: r.error });
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      width={900}
      title={step === "edit" ? (designation ? `Edit ${designation.name}` : "New designation") : `Review — ${name.trim() || "designation"}`}
      footer={
        <>
          <Button variant="secondary" onClick={() => (step === "review" ? setStep("edit") : onClose())}>
            {step === "review" ? "Back" : "Cancel"}
          </Button>
          {step === "edit" ? (
            <Button variant="primary" onClick={() => setStep("review")}>
              Review
            </Button>
          ) : (
            <Button variant="primary" disabled={saving || (!!designation && !changeLines.length)} onClick={save}>
              {saving ? "Saving…" : designation ? `Save${moving.length ? ` and move ${moving.length}` : ""}` : "Create"}
            </Button>
          )}
        </>
      }
    >
      {step === "edit" ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[1fr_2fr] gap-3">
            <Field label="Name" error={errors.name}>
              <Input value={name} placeholder="Quality tester" onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="What the job is" hint="One line, shown under the name on the Access screen.">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>

          <div>
            <div className="mb-1 text-[13px] font-medium text-ink">Level in the ERP</div>
            <div className="flex flex-wrap gap-2">
              {LEVELS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setLevel(l.id)}
                  className={cx(
                    "max-w-[270px] cursor-pointer rounded-[4px] border px-3 py-2 text-left",
                    level === l.id ? "border-brand bg-brand-soft" : "border-line bg-surface hover:bg-canvas",
                  )}
                >
                  <span className="block text-[13px] font-medium text-ink">{l.label}</span>
                  <span className="block text-[12px] leading-[17px] text-muted">{l.line}</span>
                </button>
              ))}
            </div>
          </div>

          <Field
            label="Production department"
            error={errors.department}
            hint={
              department
                ? `Raises purchase requirements for ${departmentsOf(department)
                    .map((d) => `${d.label} (${d.materialTypes.join(", ").toLowerCase()})`)
                    .join(" · ")} only, and sees those departments' requirements.`
                : "Not a production job: nothing it asks to be bought is narrowed."
            }
          >
            <Select value={department ?? ""} onChange={(e) => setDepartment(isDepartmentSeat(e.target.value) ? e.target.value : null)}>
              <option value="">None</option>
              {DEPARTMENT_SEATS.map((d) => (
                <option key={d} value={d}>
                  {SEAT_LABEL[d]}
                  {d === "head" ? " — every department" : ""}
                </option>
              ))}
            </Select>
          </Field>

          <div className="overflow-hidden rounded-[4px] border border-line">
            <div className="flex items-center gap-2 bg-canvas px-2.5 py-1.5">
              <span className="text-[13px] font-medium text-ink">Screens</span>
              <span className="text-[12px] text-muted">Dashboard and Settings are open to everybody who holds the ERP.</span>
              <span className="flex-1" />
              <Checkbox
                checked={allScreens}
                onChange={() => setAllScreens(!allScreens)}
                label={<span className="text-[13px] text-body">Every screen, including ones built later</span>}
              />
            </div>
            {allScreens ? null : (
              <div className="px-2.5 py-1">
                {groups.map((g) => (
                  <div key={g.group} className="flex items-start gap-2 border-b border-divider py-1 last:border-b-0">
                    <span className="w-[132px] flex-none pt-[3px] text-[10px] leading-[14px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
                      {g.group.replace(/^ERP · /, "")}
                    </span>
                    <span className="grid min-w-0 flex-1 grid-cols-3 gap-x-3">
                      {g.modules.map((m) => (
                        <Checkbox
                          key={m.key}
                          checked={modules.includes(m.key)}
                          onChange={() => setModules(toggle(modules, m.key))}
                          className="min-w-0 py-[1px]"
                          label={<span className="truncate text-[13px] text-body">{m.label}</span>}
                        />
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {errors.modules ? <p className="border-t border-divider px-2.5 py-1.5 text-[13px] text-danger">{errors.modules}</p> : null}
          </div>

          <div className="overflow-hidden rounded-[4px] border border-line">
            <div className="bg-canvas px-2.5 py-1.5 text-[13px] font-medium text-ink">Powers</div>
            {level === "admin" ? (
              <p className="px-2.5 py-2 text-[13px] text-muted">An ERP administrator holds every power without a tick.</p>
            ) : (
              <div className="grid grid-cols-3 gap-x-3 px-2.5 py-1.5">
                {ERP_POWERS.map((p) => (
                  <Checkbox
                    key={p}
                    checked={powers.includes(p)}
                    title={ERP_POWER_LABEL[p].source}
                    onChange={() => setPowers(toggle(powers, p))}
                    className="min-w-0 py-[1px]"
                    label={<span className="truncate text-[13px] text-body">{ERP_POWER_LABEL[p].label}</span>}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="overflow-hidden rounded-[4px] border border-line">
            {(changeLines.length ? changeLines : ["Nothing has changed."]).map((l, i) => (
              <div key={i} className={cx("px-2.5 py-2 text-[13px] text-body", i > 0 && "border-t border-divider")}>
                {l}
              </div>
            ))}
          </div>
          {designation ? (
            <>
              <div className="rounded-[4px] border border-line px-3 py-2.5">
                <div className="text-[13px] font-medium text-ink">
                  {moving.length
                    ? `${moving.length} ${moving.length === 1 ? "person moves" : "people move"} with it`
                    : "Nobody moves with it"}
                </div>
                <p className="mt-0.5 text-[13px] text-muted">
                  {moving.length
                    ? `${moving.map((m) => m.name).join(", ")} — their ERP level, screens and powers become exactly the above, and each is told.`
                    : "Nobody holds exactly this designation today."}
                </p>
              </div>
              {staying.length ? (
                <div className="rounded-[4px] border border-warn bg-warn-soft px-3 py-2.5">
                  <div className="text-[13px] font-medium text-warn-ink">
                    {staying.length} customised {staying.length === 1 ? "holder stays" : "holders stay"} as they are
                  </div>
                  {staying.map((m) => (
                    <p key={m.userId} className="mt-0.5 text-[13px] text-warn-ink">
                      <span className="font-medium">{m.name}</span> — {describeDiff(m.diff, screenLabel, powerLabel).join("; ")}
                    </p>
                  ))}
                  <p className="mt-1 text-[12px] text-warn-ink">Reset any of them to the designation from their Manage access.</p>
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-[13px] text-muted">Nobody holds it yet. Give it to somebody from the Access screen.</p>
          )}
          {errors.form ? <p className="text-[13px] text-danger">{errors.form}</p> : null}
        </div>
      )}
    </Modal>
  );
}
