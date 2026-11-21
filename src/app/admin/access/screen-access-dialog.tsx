"use client";

import * as React from "react";
import { Modal } from "@/components/ui/overlays";
import { ImpactDialog } from "@/components/ui/impact-dialog";
import { Button, cx } from "@/components/ui/primitives";
import { ACCESS_REVOKE_KIND, accessRevokeKey } from "@/lib/impact/kinds/access-revoke-key";
import type { ImpactConfirmation } from "@/lib/impact/types";
import type { Result } from "@/lib/result";
import { getModule, grantableApps } from "@/lib/modules";
import { initialsOf } from "@/lib/format";
import type { AppId } from "@/lib/apps";
import type { AccessRow } from "@/lib/services/access-service";
import { setAccess, type ScreenGrantInput, type SetAccessResult } from "@/lib/actions/access";
import { loadScreenAccess, type ScreenAccessView } from "@/lib/actions/screen-access";
import { HANDSET_LABELS } from "@/lib/access/handset-screens";
import { moduleShape } from "@/lib/access/screen-permissions";
import {
  emptyGrant,
  setAccess as tickAccess,
  setDelete,
  setEdit,
  setModule,
  setPosition,
  type AppGrantDraft,
  type ModuleShape,
  type Position,
} from "@/lib/access/permission-rules";

/* ---------------------------------------------------------------------------
 * MANAGE ACCESS — POSITION AND SCREENS.
 *
 * Per app: the POSITION (whose records they see: their own, their team's, or
 * everybody's) and, laid out as the app's own sidebar, each module and the
 * screens under it with three ticks — Access (the screen and every ordinary
 * action on it), Edit (row, modal and detail edits) and Delete (special; needs
 * Edit). The tick rules are `lib/access/permission-rules.ts`, the same code the
 * save runs, so what is drawn here is what is stored.
 *
 * Reports to is HRMS's and is shown, never edited. Saving goes through the
 * Review step and `setAccess`, which derives everything else (modules, level,
 * ERP/HRMS/Tasks powers) from the ticks on the server.
 * ------------------------------------------------------------------------- */

type Drafts = Map<AppId, AppGrantDraft>;

const POSITIONS: { id: Position; label: string; line: string }[] = [
  { id: "associate", label: "Associate", line: "Sees only their own records." },
  { id: "manager", label: "Manager", line: "Sees their own and their team's records. Edit and Delete reach the team's too." },
  { id: "everyone", label: "Everyone", line: "Sees the whole company's records in this app." },
];

const shapes = new Map<AppId, ModuleShape[]>();
function shapeOf(app: AppId): ModuleShape[] {
  let s = shapes.get(app);
  if (!s) shapes.set(app, (s = moduleShape(app)));
  return s;
}

function screenLabel(key: string): string {
  return getModule(key)?.label ?? HANDSET_LABELS[key] ?? key;
}

/** "ERP · Purchase" in the registry reads "Purchase" inside the ERP's own list. */
function moduleLabel(m: string): string {
  return m.replace(/^[^·]+·\s*/, "");
}

function draftsFrom(view: ScreenAccessView): Drafts {
  const d: Drafts = new Map();
  for (const a of view.apps) {
    d.set(a.app, {
      position: a.position,
      modules: new Set(a.modules),
      screens: new Map(a.screens.map((s) => [s.screen, { edit: s.edit, delete: s.delete, autoEdit: s.autoEdit }])),
    });
  }
  return d;
}

function signature(d: Drafts, platformAdmin: boolean): string {
  const parts = [...d]
    .filter(([, g]) => g.screens.size)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([app, g]) => `${app}:${g.position}:${[...g.screens].sort(([a], [b]) => a.localeCompare(b)).map(([s, t]) => `${s}${t.edit ? "E" : ""}${t.delete ? "D" : ""}`).join(",")}`);
  return `${platformAdmin}|${parts.join(";")}`;
}

/** The changes the Review step lists, in words. */
function describe(before: Drafts, after: Drafts, adminBefore: boolean, adminAfter: boolean): string[] {
  const out: string[] = [];
  if (adminBefore !== adminAfter) out.push(adminAfter ? "Made platform administrator" : "No longer platform administrator");
  for (const a of grantableApps()) {
    const b = before.get(a.id);
    const n = after.get(a.id);
    const had = !!b?.screens.size;
    const has = !!n?.screens.size;
    if (!had && !has) continue;
    if (had && !has) {
      out.push(`${a.name}: taken away`);
      continue;
    }
    if (!had && has) out.push(`${a.name}: given, as ${n!.position}`);
    else if (b!.position !== n!.position) out.push(`${a.name}: position ${b!.position} → ${n!.position}`);
    const keys = new Set([...(b?.screens.keys() ?? []), ...n!.screens.keys()]);
    for (const k of keys) {
      const x = b?.screens.get(k);
      const y = n!.screens.get(k);
      const word = (t?: { edit: boolean; delete: boolean }) => (!t ? "no access" : t.delete ? "Delete" : t.edit ? "Edit" : "Access");
      if (word(x) !== word(y)) out.push(`${a.name} › ${screenLabel(k)}: ${word(x)} → ${word(y)}`);
    }
  }
  return out;
}

export function ScreenAccessDialog({
  person,
  onClose,
  onDone,
}: {
  person: AccessRow;
  onClose: () => void;
  onDone: (r: { ok: boolean; message?: string; error?: string }) => void;
}) {
  const [view, setView] = React.useState<ScreenAccessView | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  /* Read once, on mount; the dialog is keyed on the person, so a second person mounts afresh. */
  React.useEffect(() => {
    let live = true;
    void loadScreenAccess(person.userId).then((r) => {
      if (!live) return;
      if (r.ok) setView(r.data);
      else setLoadError(r.error);
    });
    return () => {
      live = false;
    };
  }, [person.userId]);

  if (loadError) {
    return (
      <Modal open onClose={onClose} title="Manage access" footer={<Button onClick={onClose}>Close</Button>}>
        <p className="text-meta text-danger">{loadError}</p>
      </Modal>
    );
  }
  if (!view) {
    return (
      <Modal open onClose={onClose} title={`Manage access · ${person.name}`}>
        <p className="text-meta text-muted">Reading what {person.name} holds…</p>
      </Modal>
    );
  }
  return <Editor key={person.userId} person={person} view={view} onClose={onClose} onDone={onDone} />;
}

function Editor({
  person,
  view,
  onClose,
  onDone,
}: {
  person: AccessRow;
  view: ScreenAccessView;
  onClose: () => void;
  onDone: (r: { ok: boolean; message?: string; error?: string }) => void;
}) {
  const apps = React.useMemo(() => grantableApps().filter((a) => !a.retiredInto), []);
  const [base] = React.useState<Drafts>(() => draftsFrom(view));
  const [drafts, setDrafts] = React.useState<Drafts>(() => draftsFrom(view));
  const [platformAdmin, setPlatformAdmin] = React.useState(view.platformAdmin);
  const [sel, setSel] = React.useState<AppId>(() => (view.apps[0]?.app ?? apps[0].id) as AppId);
  const [posOpen, setPosOpen] = React.useState(false);
  const [folded, setFolded] = React.useState<ReadonlySet<string>>(new Set());
  const [step, setStep] = React.useState<"edit" | "review">("edit");
  const [saving, setSaving] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  const shape = shapeOf(sel);
  const grant = drafts.get(sel) ?? emptyGrant();
  const on = grant.screens.size > 0 || grant.modules.size > 0;
  const changes = describe(base, drafts, view.platformAdmin, platformAdmin);
  const dirty = signature(base, view.platformAdmin) !== signature(drafts, platformAdmin);
  const revoked = apps.filter((a) => base.get(a.id)?.screens.size && !drafts.get(a.id)?.screens.size).map((a) => a.id);
  const deletes = [...drafts.values()].reduce((n, g) => n + [...g.screens.values()].filter((t) => t.delete).length, 0);

  const update = (fn: (g: AppGrantDraft) => AppGrantDraft) =>
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(sel, fn(prev.get(sel) ?? emptyGrant()));
      return next;
    });

  const toggleApp = () =>
    update((g) => {
      if (g.screens.size || g.modules.size) return emptyGrant(g.position);
      /* Given: every module opens at Access; untick what they should not have. */
      return shape.reduce((acc, m) => setModule(acc, shape, m.module, true), emptyGrant(g.position));
    });

  function payload(): ScreenGrantInput[] {
    const out: ScreenGrantInput[] = [];
    for (const [app, g] of drafts) {
      if (!g.screens.size) continue;
      out.push({
        app,
        position: g.position,
        modules: [...g.modules],
        screens: [...g.screens].map(([screen, t]) => ({ screen, edit: t.edit, delete: t.delete, autoEdit: t.autoEdit })),
        ...(app === "admin" ? { platformAdmin } : {}),
      });
    }
    if (platformAdmin && !drafts.get("admin")?.screens.size) {
      const s = shapeOf("admin");
      out.push({
        app: "admin",
        position: "everyone",
        modules: s.map((m) => m.module),
        screens: s.flatMap((m) => m.screens).map((screen) => ({ screen, edit: true, delete: true, autoEdit: false })),
        platformAdmin: true,
      });
    }
    return out;
  }

  async function save(confirmation?: ImpactConfirmation): Promise<Result<SetAccessResult>> {
    setSaving(true);
    try {
      const r = await setAccess({ userId: person.userId, grants: [], screenGrants: payload(), confirmation });
      if (r.ok) onDone({ ok: true, message: r.message ?? `Access saved for ${person.name}.` });
      return r;
    } finally {
      setSaving(false);
    }
  }

  const reportsTo = view.reportsTo;

  return (
    <>
      <Modal open onClose={onClose} title={null} width={1000}>
        <div className="-mx-6 -my-5 flex h-[min(820px,78vh)] flex-col text-meta text-body">
          {/* Header */}
          <div className="flex items-center gap-3.5 border-b border-divider px-5 py-4">
            <span aria-hidden className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-divider text-[15px] font-bold text-body">
              {person.initials || initialsOf(person.name)}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-2">
                <span className="text-[17px] font-bold text-ink">{person.name}</span>
                {person.employeeCode ? <span className="text-xs font-medium text-muted">{person.employeeCode}</span> : null}
              </div>
              <span className="text-xs text-muted">{[person.department, person.email ?? person.phone].filter(Boolean).join(" · ")}</span>
            </div>
            <div className="flex h-11 items-center gap-2.5 rounded-lg bg-canvas px-3" title="Comes from the employee's record in HRMS. Change it there.">
              <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-full bg-divider text-[11px] font-bold text-body">
                {reportsTo ? initialsOf(reportsTo.name) : "—"}
              </span>
              <span className="flex flex-col leading-tight">
                <span className="text-[10px] font-semibold tracking-label text-muted uppercase">
                  Reports to <span className="font-medium tracking-normal normal-case">· from HRMS</span>
                </span>
                <span className="font-semibold text-ink">{reportsTo?.name ?? "Nobody"}</span>
              </span>
            </div>
            <button type="button" aria-label="Close" onClick={onClose} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-canvas">
              <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          {step === "review" ? (
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <div className="mb-3 text-sm font-bold text-ink">Review changes for {person.name}</div>
              {changes.length ? (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {changes.map((c) => (
                    <li key={c} className={cx("rounded-control border border-divider px-3 py-2", /→ Delete|taken away/.test(c) ? "text-danger" : "text-ink")}>
                      {c}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted">Nothing has changed.</p>
              )}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1">
              {/* App rail */}
              <div className="flex w-[216px] flex-none flex-col gap-0.5 overflow-y-auto border-r border-divider bg-canvas px-2.5 py-3">
                <span className="px-2 pb-2 text-2xs font-semibold tracking-label text-muted uppercase">
                  Apps · {apps.filter((a) => drafts.get(a.id)?.screens.size).length} of {apps.length}
                </span>
                {apps.map((a) => {
                  const g = drafts.get(a.id);
                  const has = !!g?.screens.size;
                  const total = shapeOf(a.id).reduce((n, m) => n + m.screens.length, 0);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => {
                        setSel(a.id);
                        setPosOpen(false);
                      }}
                      className={cx(
                        "flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 px-2.5 py-2 text-left",
                        sel === a.id ? "bg-surface shadow-[0_0_0_1px_var(--color-line)]" : "bg-transparent hover:bg-divider",
                      )}
                    >
                      <span aria-hidden className={cx("h-2 w-2 flex-none rounded-full", has ? "bg-success" : "bg-line-strong")} />
                      <span className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="font-semibold text-ink">{a.name}</span>
                        <span className="text-2xs text-muted">{has ? `${POSITIONS.find((p) => p.id === g!.position)!.label} · ${g!.screens.size}/${total}` : "No access"}</span>
                      </span>
                    </button>
                  );
                })}
                <span className="flex-1" />
                <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-divider bg-surface p-2.5">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand" checked={platformAdmin} onChange={() => setPlatformAdmin((v) => !v)} />
                  <span className="flex flex-col leading-tight">
                    <span className="font-semibold text-ink">Platform admin</span>
                    <span className="text-2xs text-muted">Everything, everywhere</span>
                  </span>
                </label>
              </div>

              {/* Detail */}
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-3 border-b border-divider px-5 py-3.5">
                  <div className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="text-base font-bold text-ink">{apps.find((a) => a.id === sel)?.name}</span>
                    <span className="text-xs text-muted">{apps.find((a) => a.id === sel)?.description}</span>
                  </div>
                  {on ? (
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setPosOpen((v) => !v)}
                        className="flex h-[34px] cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface pr-2.5 pl-3 hover:border-line-strong"
                      >
                        <span className="text-xs text-muted">Position</span>
                        <span className="font-semibold text-ink">{POSITIONS.find((p) => p.id === grant.position)!.label}</span>
                        <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-muted">
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                      {posOpen ? (
                        <div className="absolute top-[42px] right-0 z-20 w-[300px] rounded-lg border border-line bg-surface p-1.5 shadow-pop">
                          {POSITIONS.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => {
                                update((g) => setPosition(g, p.id));
                                setPosOpen(false);
                              }}
                              className={cx("flex w-full cursor-pointer items-start gap-2.5 rounded-md border-0 p-2.5 text-left", grant.position === p.id ? "bg-canvas" : "bg-transparent hover:bg-canvas")}
                            >
                              <span aria-hidden className={cx("mt-0.5 h-4 w-4 flex-none rounded-full bg-surface", grant.position === p.id ? "border-[5px] border-brand" : "border-[1.5px] border-line-strong")} />
                              <span className="flex flex-col gap-0.5">
                                <span className="font-bold text-ink">{p.label}</span>
                                <span className="text-xs text-body">{p.line}</span>
                              </span>
                            </button>
                          ))}
                          <span className="mt-1 block border-t border-divider px-2.5 pt-2 pb-1 text-2xs text-muted">
                            Position decides whose records they see. What they can open, edit and delete is ticked below.
                          </span>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <button type="button" onClick={toggleApp} aria-pressed={on} className="flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0">
                    <span className="text-xs font-semibold text-ink">{on ? "On" : "Off"}</span>
                    <Switch on={on} />
                  </button>
                </div>

                {!on ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2.5 p-8 text-center">
                    <span className="text-[15px] font-bold text-ink">
                      {person.name} can&apos;t open {apps.find((a) => a.id === sel)?.name}
                    </span>
                    <span className="max-w-[340px] text-muted">Turn it on to choose their position and what they get on each item of its sidebar.</span>
                    <Button variant="primary" onClick={toggleApp}>
                      Give {apps.find((a) => a.id === sel)?.name}
                    </Button>
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex items-center gap-2 border-b border-divider px-5 py-2.5 text-xs">
                      <span className="flex-1 text-body">{POSITIONS.find((p) => p.id === grant.position)!.label} — {POSITIONS.find((p) => p.id === grant.position)!.line}</span>
                      <span className="text-muted">
                        {grant.modules.size} modules · {grant.screens.size} sub-modules · {[...grant.screens.values()].filter((t) => t.edit).length} edit ·{" "}
                        {[...grant.screens.values()].filter((t) => t.delete).length} delete
                      </span>
                    </div>
                    <div className="flex items-center border-b border-line py-2 pr-[31px] pl-5 text-2xs font-semibold tracking-label text-muted uppercase">
                      <span className="flex-1">Module › sub-module</span>
                      <span className="w-[76px] text-center" title="Opens it, with every ordinary action on it">Access</span>
                      <span className="w-[76px] text-center" title="Row, modal and detail edits">Edit</span>
                      <span className="w-[76px] text-center" title="Special — needs Edit">Delete</span>
                      <span className="w-[92px] text-right">Module</span>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-4">
                      <div className="flex flex-col gap-2.5">
                        {shape.map((m) => {
                          const given = grant.modules.has(m.module);
                          const open = given && !folded.has(`${sel}/${m.module}`);
                          const held = m.screens.filter((s) => grant.screens.has(s));
                          const allEdit = held.length > 0 && m.screens.every((s) => grant.screens.get(s)?.edit);
                          const allDel = held.length > 0 && m.screens.every((s) => grant.screens.get(s)?.delete);
                          return (
                            <div key={m.module} className="overflow-hidden rounded-lg border border-line bg-surface">
                              <div className={cx("flex items-center py-2.5 pr-3.5 pl-2.5", given ? "bg-canvas" : "bg-surface")}>
                                <button
                                  type="button"
                                  aria-label={`Show or hide ${moduleLabel(m.module)}`}
                                  disabled={!given}
                                  title={given ? undefined : "Give the module first"}
                                  onClick={() =>
                                    setFolded((f) => {
                                      const n = new Set(f);
                                      const k = `${sel}/${m.module}`;
                                      if (n.has(k)) n.delete(k);
                                      else n.add(k);
                                      return n;
                                    })
                                  }
                                  className="mr-1.5 flex h-5 w-5 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-muted disabled:cursor-default"
                                >
                                  <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className={cx("transition-transform", open ? "rotate-90" : "")}>
                                    <path d="M9 6l6 6-6 6" />
                                  </svg>
                                </button>
                                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                                  <span className={cx("font-bold", given ? "text-ink" : "text-muted")}>{moduleLabel(m.module)}</span>
                                  <span className="text-2xs text-muted">Module · {given ? `${held.length} of ${m.screens.length} sub-modules` : "Not given"}</span>
                                </span>
                                <span className="w-[76px]" />
                                <span className="flex w-[76px] flex-col items-center gap-0.5">
                                  {given ? (
                                    <>
                                      <Tick label={`Edit in all of ${moduleLabel(m.module)}`} checked={allEdit} onChange={() => update((g) => m.screens.reduce((acc, s) => setEdit(acc, shape, s, !allEdit), g))} />
                                      <span className="text-[10px] text-muted">all</span>
                                    </>
                                  ) : null}
                                </span>
                                <span className="flex w-[76px] flex-col items-center gap-0.5">
                                  {given ? (
                                    <>
                                      <Tick label={`Delete in all of ${moduleLabel(m.module)}`} checked={allDel} onChange={() => update((g) => m.screens.reduce((acc, s) => setDelete(acc, shape, s, !allDel), g))} />
                                      <span className="text-[10px] text-muted">all</span>
                                    </>
                                  ) : null}
                                </span>
                                <span className="flex w-[92px] justify-end">
                                  <button
                                    type="button"
                                    aria-pressed={given}
                                    aria-label={`Give the ${moduleLabel(m.module)} module`}
                                    onClick={() => update((g) => setModule(g, shape, m.module, !given))}
                                    className="cursor-pointer border-0 bg-transparent p-0"
                                  >
                                    <Switch on={given} />
                                  </button>
                                </span>
                              </div>
                              {!given ? (
                                <div className="border-t border-divider py-2 pr-4 pl-9 text-xs text-muted">
                                  Give {moduleLabel(m.module)} first — then choose which of its {m.screens.length} sub-modules they get.
                                </div>
                              ) : open ? (
                                m.screens.map((s) => {
                                  const t = grant.screens.get(s);
                                  return (
                                    <div key={s} className="flex min-h-[22px] items-center border-t border-divider bg-surface py-1.5 pr-3.5 pl-9 hover:bg-page">
                                      <span className={cx("min-w-0 flex-1", t ? "text-body" : "text-faint")}>{screenLabel(s)}</span>
                                      <span className="flex w-[76px] justify-center">
                                        <Tick label={`Access to ${screenLabel(s)}`} checked={!!t} onChange={() => update((g) => tickAccess(g, shape, s, !t))} />
                                      </span>
                                      <span className="flex w-[76px] flex-col items-center gap-px">
                                        <Tick label={`Edit in ${screenLabel(s)}`} checked={!!t?.edit} onChange={() => update((g) => setEdit(g, shape, s, !t?.edit))} />
                                        {t?.autoEdit && t.delete ? (
                                          <span className="text-[10px] whitespace-nowrap text-muted" title="Ticked because Delete needs Edit. Unticking Delete takes it away again.">
                                            with Delete
                                          </span>
                                        ) : null}
                                      </span>
                                      <span className="flex w-[76px] justify-center">
                                        <Tick label={`Delete in ${screenLabel(s)}`} checked={!!t?.delete} onChange={() => update((g) => setDelete(g, shape, s, !t?.delete))} />
                                      </span>
                                      <span className="w-[92px]" />
                                    </div>
                                  );
                                })
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center gap-2 border-t border-divider px-5 py-3">
            <span className="text-xs text-muted">{step === "edit" ? "Step 2 of 3" : "Step 3 of 3"}</span>
            {changes.length ? <span className="text-xs font-semibold text-ink">· {changes.length} change{changes.length === 1 ? "" : "s"}</span> : null}
            {deletes ? <span className="text-xs font-semibold text-danger">· Delete on {deletes} item{deletes === 1 ? "" : "s"}</span> : null}
            <span className="flex-1" />
            <Button onClick={step === "review" ? () => setStep("edit") : onClose}>{step === "review" ? "Back" : "Cancel"}</Button>
            {step === "edit" ? (
              <Button variant="primary" onClick={() => setStep("review")}>
                Review changes
              </Button>
            ) : (
              <Button
                variant={revoked.length ? "danger" : "primary"}
                disabled={saving || !dirty}
                title={dirty ? undefined : "Nothing has changed"}
                onClick={() => (revoked.length ? setConfirming(true) : void save())}
              >
                {saving ? "Saving…" : "Save access"}
              </Button>
            )}
          </div>
        </div>
      </Modal>
      {confirming ? (
        <ImpactDialog
          key={accessRevokeKey(person.userId, revoked)}
          kind={ACCESS_REVOKE_KIND}
          id={accessRevokeKey(person.userId, revoked)}
          confirmLabel="Take them away"
          onClose={() => setConfirming(false)}
          onConfirm={(confirmation) => save(confirmation)}
        />
      ) : null}
    </>
  );
}

function Switch({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={cx("relative inline-block h-5 w-[34px] flex-none rounded-full transition-colors", on ? "bg-brand" : "bg-line-strong")}>
      <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.2)] transition-[left]", on ? "left-4" : "left-0.5")} />
    </span>
  );
}

function Tick({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return <input type="checkbox" aria-label={label} checked={checked} onChange={onChange} className="h-4 w-4 cursor-pointer accent-brand" />;
}
