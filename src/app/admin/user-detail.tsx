"use client";

import * as React from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Input,
  Select,
  Textarea,
  cx,
} from "@/components/ui/primitives";
import { FilterPills, Tabs } from "@/components/ui/overlays";
import { ownedFor, type AdminUser } from "./data";
import { activityFor, type ActivityKind } from "./data-platform";
import { statusTone, capabilities } from "./people-section";
import { useAdmin } from "./store";

const TABS = ["Profile", "Access", "Activity", "Sessions", "Owned records", "Audit", "Notes"] as const;
type DetailTab = (typeof TABS)[number];

export function UserDetail({ user, onBack }: { user: AdminUser; onBack: () => void }) {
  const { registry, sessions, audit, notes, notify, patchUser, revokeGrant, endSession, addNote, openDrawer } =
    useAdmin();
  const [tab, setTab] = React.useState<DetailTab>("Profile");
  const [offboarding, setOffboarding] = React.useState(false);
  const owned = ownedFor(user.id);

  return (
    <div>
      <button
        onClick={onBack}
        className="mb-2.5 inline-flex cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-[13px] text-muted hover:text-body"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M15 6 9 12l6 6" />
        </svg>
        All users
      </button>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span className="text-[28px] leading-[34px] font-semibold text-ink">{user.name}</span>
            <Badge tone={statusTone(user.status)}>{user.status}</Badge>
          </div>
          <div className="mt-1 text-[13px] text-muted">
            {user.code} · {user.designation} · {user.dept} · joined {user.joined}
          </div>
        </div>
        <div className="flex flex-none gap-2.5">
          <Button variant="ghost" onClick={() => openDrawer({ kind: "delegate", id: user.id })}>
            Delegate access
          </Button>
          <Button variant="ghost" onClick={() => openDrawer({ kind: "leave", id: user.id })}>
            Mark on leave
          </Button>
          {user.status === "Deactivated" ? (
            <Button
              variant="primary"
              onClick={() => {
                patchUser(user.id, { status: "Active" });
                notify(`${user.name} reactivated. History is intact — previous access and roles can be restored.`);
              }}
            >
              Reactivate account
            </Button>
          ) : (
            <Button
              variant="secondary"
              className="border-danger text-danger hover:bg-danger-soft"
              onClick={() => setOffboarding(true)}
            >
              Deactivate
            </Button>
          )}
        </div>
      </div>

      <Tabs
        className="mt-4"
        tabs={TABS.map((t) => ({ key: t, label: t }))}
        value={tab}
        onChange={setTab}
      />

      {tab === "Profile" ? <ProfileTab key={user.id} user={user} /> : null}

      {tab === "Access" ? (
        <div>
          <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
            <CardHeader
              title="App access"
              hint="Who granted it, when, and why — the answer to “why can this person see that?”"
            />
            {user.grants.length === 0 ? (
              <div className="px-5 py-6 text-sm text-muted">
                No app access. MahekOne will not open for this account.
              </div>
            ) : null}
            {user.grants.map((g, i) => (
              <div key={g.app} className={cx("px-5 py-3", i ? "border-t border-canvas" : "")}>
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 text-sm font-medium text-ink">
                    {registry.find((a) => a.id === g.app)?.name ?? g.app}
                  </span>
                  <Button size="sm" variant="ghost" className="text-danger" onClick={() => revokeGrant(user.id, g.app)}>
                    Revoke
                  </Button>
                </div>
                <div className="mt-0.5 text-[13px] text-muted">
                  Granted by {g.by} on {g.on} · {g.reason}
                </div>
              </div>
            ))}
          </Card>

          <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
            <CardHeader title="Role history" />
            {user.roleLog.length === 0 ? (
              <div className="px-5 py-6 text-sm text-muted">No role has been assigned yet.</div>
            ) : null}
            {user.roleLog.map((r, i) => (
              <div key={`${r.app}-${r.on}`} className={cx("px-5 py-2.5", i ? "border-t border-canvas" : "")}>
                <div className="text-sm font-medium text-ink">
                  {registry.find((a) => a.id === r.app)?.short ?? r.app} · {r.role}
                </div>
                <div className="text-[13px] text-muted">
                  Set by {r.by} on {r.on}
                </div>
              </div>
            ))}
          </Card>

          <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
            <CardHeader title="What this adds up to" hint="Access plus role, as the apps themselves read it." />
            {user.apps.length === 0 ? (
              <div className="px-5 py-6 text-sm text-muted">Nothing — this account cannot open anything.</div>
            ) : null}
            {user.apps.map((id) => {
              const a = registry.find((x) => x.id === id)!;
              const role = user.roles[id] ?? a.roles[0];
              return (
                <div key={id} className="border-t border-canvas px-5 py-3">
                  <div className="text-sm font-medium text-ink">
                    {a.name} · {role}
                  </div>
                  <div className="mt-0.5 text-[13px] text-muted">{capabilities(role)}</div>
                </div>
              );
            })}
          </Card>
        </div>
      ) : null}

      {tab === "Activity" ? <ActivityTab user={user} /> : null}

      {tab === "Sessions" ? (
        <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          <CardHeader title="Live sessions" hint="Each one individually revocable." />
          {sessions.filter((s) => s.user === user.id).length === 0 ? (
            <div className="px-5 py-6 text-sm text-muted">No active sessions.</div>
          ) : null}
          {sessions
            .filter((s) => s.user === user.id)
            .map((s, i) => (
              <div key={s.id} className={cx("flex items-center gap-4 px-5 py-3", i ? "border-t border-canvas" : "")}>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">
                    {s.app} · {s.device}
                  </span>
                  <span className="block text-[13px] text-muted">
                    {s.ip} · started {s.started} · last seen {s.seen}
                  </span>
                </span>
                <Button size="sm" variant="ghost" className="text-danger" onClick={() => endSession(s.id)}>
                  End session
                </Button>
              </div>
            ))}
        </Card>
      ) : null}

      {tab === "Owned records" ? (
        <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          <CardHeader
            title="Owned records across every app"
            hint="Read live from each app's own contract. The console holds no knowledge of what these records are."
          />
          {owned.length === 0 ? (
            <div className="px-5 py-6 text-sm text-muted">
              {user.name} owns nothing in any app, so deactivation would not strand any records.
            </div>
          ) : null}
          {owned.map((r, i) => (
            <div key={`${r.appId}-${r.key}`} className={cx("flex items-center gap-4 px-5 py-3.5", i ? "border-t border-canvas" : "")}>
              <span
                className={cx(
                  "min-w-[56px] text-right text-[22px] font-semibold",
                  r.count > 100 ? "text-warn-ink" : "text-ink",
                )}
              >
                {r.count}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink">{r.label}</span>
                <span className="block text-[13px] text-muted">{r.app}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => notify(`Opening the ${r.label.toLowerCase()} list in ${r.app}`)}>
                View list
              </Button>
            </div>
          ))}
          {owned.length ? (
            <div className="bg-canvas px-5 py-3 text-[13px] text-muted">
              All of this must be reassigned before {user.name} can be deactivated.
            </div>
          ) : null}
        </Card>
      ) : null}

      {tab === "Audit" ? (
        <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          <CardHeader title="Audit" hint="Changes to this account, and changes this person made." />
          {[
            ...audit.filter((r) => r.actor === user.name || r.subject === user.id),
            {
              kind: "access" as const,
              setting: "Account created",
              app: "Platform",
              from: "—",
              to: user.name,
              actor: user.createdBy,
              t: user.joined,
            },
          ].map((r, i) => (
            <div key={`${r.setting}-${r.t}-${i}`} className={cx("px-5 py-3", i ? "border-t border-canvas" : "")}>
              <div className="flex items-baseline gap-2.5">
                <span className="min-w-0 flex-1 text-sm font-medium text-ink">{r.setting}</span>
                <span className="flex-none text-[13px] text-muted">{r.t}</span>
              </div>
              <div className="mt-0.5 text-[13px] text-muted">
                {r.app} · {r.from === "—" ? r.to : `${r.from} → ${r.to}`} · by {r.actor}
              </div>
            </div>
          ))}
        </Card>
      ) : null}

      {tab === "Notes" ? <NotesTab user={user} notes={notes[user.id] ?? []} onAdd={addNote} /> : null}

      {offboarding ? (
        <OffboardWizard user={user} onClose={() => setOffboarding(false)} onDone={onBack} />
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- profile */

type ProfileField = {
  group: "Identity" | "Employment" | "Contact";
  key: keyof AdminUser & string;
  label: string;
  value: string;
  required?: boolean;
  half?: boolean;
  help?: string;
  options?: string[];
};

/**
 * One form with one commit, not eight independent row editors.
 *
 * Grouped the way an HR record is actually read, validated as a whole so a
 * person sees every problem at once, and saved as one action that writes an
 * audit entry per changed field. Nothing is written until Save.
 */
function ProfileTab({ user }: { user: AdminUser }) {
  const { users, patchUser, record, notify, audit } = useAdmin();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // The declared department list, plus whatever this record already holds —
  // opening a form must never silently move somebody to another department.
  const departments = [...new Set(["Telecalling", "Accounts", "Dispatch", "Management", user.dept])];
  const managers = [
    "—",
    ...users.filter((u) => u.id !== user.id && u.roles.crm === "Manager").map((u) => u.name),
  ];

  const fields: ProfileField[] = [
    { group: "Identity", key: "name", label: "Full name", value: user.name, required: true },
    { group: "Identity", key: "code", label: "Employee code", value: user.code, required: true, half: true },
    { group: "Identity", key: "joined", label: "Date joined", value: user.joined, half: true },
    { group: "Employment", key: "designation", label: "Designation", value: user.designation, half: true },
    { group: "Employment", key: "dept", label: "Department", value: user.dept, half: true, options: departments },
    { group: "Employment", key: "reportsTo", label: "Reporting manager", value: user.reportsTo ?? "—", options: managers },
    {
      group: "Contact", key: "contact", label: "Work email", value: user.contact, required: true,
      help: "Used to sign in, and where a set-password link is sent.",
    },
    { group: "Contact", key: "mobile", label: "Mobile", value: user.mobile, half: true },
  ];

  const current = (f: ProfileField) => draft[f.key] ?? f.value;
  const changed = fields.filter((f) => current(f) !== f.value);

  function save() {
    // Validate everything, then report — not one error at a time.
    const found: Record<string, string> = {};
    for (const f of fields) {
      const v = String(current(f) ?? "").trim();
      if (f.required && !v) found[f.key] = `${f.label} is required`;
      else if (f.key === "contact" && v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
        found[f.key] = "Enter a valid work email";
      } else if (f.key === "mobile" && v && v !== "—" && !/^[+0-9 ]{8,}$/.test(v)) {
        found[f.key] = "Enter a valid mobile number";
      } else if (f.key === "code" && v && users.some((u) => u.id !== user.id && u.code === v)) {
        found[f.key] = "That employee code is already in use";
      }
    }
    if (Object.keys(found).length) return setErrors(found);

    if (!changed.length) return setEditing(false);
    const patch: Record<string, string> = {};
    for (const f of changed) {
      const next = String(current(f)).trim();
      patch[f.key] = next;
      record("access", "Platform", `${f.label} — ${user.name}`, f.value, next, user.id);
    }
    patchUser(user.id, patch as Partial<AdminUser>);
    setEditing(false);
    setDraft({});
    setErrors({});
    notify(`${changed.length} ${changed.length === 1 ? "field" : "fields"} updated · audited against this account`);
  }

  const lastEdit = audit.find((r) => r.subject === user.id);

  return (
    <div className="mt-5 grid items-start gap-4 [grid-template-columns:minmax(0,1fr)_clamp(240px,24%,300px)]">
      <Card className="min-w-0 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <div className="flex items-start justify-between gap-4 border-b border-divider px-5 py-4">
          <div className="min-w-0">
            <div className="text-lg font-semibold text-ink">Profile</div>
            <div className="mt-0.5 text-[13px] text-muted">
              {!editing
                ? "Changes are audited against this account."
                : changed.length
                  ? `${changed.length} unsaved ${changed.length === 1 ? "change" : "changes"} — nothing is written until you save`
                  : "No changes yet"}
            </div>
          </div>
          {editing ? (
            <span className="flex flex-none gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(false);
                  setDraft({});
                  setErrors({});
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!changed.length}
                title={changed.length ? undefined : "Nothing to save"}
                onClick={save}
              >
                Save changes
              </Button>
            </span>
          ) : (
            <Button variant="ghost" className="flex-none" onClick={() => setEditing(true)}>
              Edit profile
            </Button>
          )}
        </div>

        {(["Identity", "Employment", "Contact"] as const).map((group) => (
          <div key={group} className="border-b border-divider px-5 py-4 last:border-0">
            <div className="mb-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{group}</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
              {fields
                .filter((f) => f.group === group)
                .map((f) => (
                  <div key={f.key} className={cx("min-w-0", f.half ? "" : "col-span-2")}>
                    <span className="block text-xs font-medium tracking-[0.04em] text-muted uppercase">
                      {f.label}
                    </span>
                    {editing ? (
                      <span className="mt-1 block">
                        {f.options ? (
                          <Select
                            value={current(f)}
                            className="w-full"
                            onChange={(e) => {
                              setDraft((d) => ({ ...d, [f.key]: e.target.value }));
                              setErrors((x) => ({ ...x, [f.key]: "" }));
                            }}
                          >
                            {f.options.map((o) => (
                              <option key={o}>{o}</option>
                            ))}
                          </Select>
                        ) : (
                          <Input
                            value={current(f)}
                            invalid={!!errors[f.key]}
                            onChange={(e) => {
                              setDraft((d) => ({ ...d, [f.key]: e.target.value }));
                              setErrors((x) => ({ ...x, [f.key]: "" }));
                            }}
                          />
                        )}
                        {errors[f.key] ? (
                          <span className="mt-1 block text-[13px] text-danger">{errors[f.key]}</span>
                        ) : f.help ? (
                          <span className="mt-1 block text-[13px] text-muted">{f.help}</span>
                        ) : null}
                      </span>
                    ) : (
                      <span className={cx("mt-0.5 block text-sm", f.value === "—" ? "text-muted" : "text-ink")}>
                        {f.value}
                      </span>
                    )}
                  </div>
                ))}
            </div>
          </div>
        ))}
      </Card>

      {/* Provenance the record itself carries, rather than a claim in a subtitle. */}
      <Card className="min-w-0 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <div className="border-b border-divider px-4 py-3.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          Record
        </div>
        <div className="flex flex-col gap-3.5 px-4 py-3.5">
          {[
            ["Created", `${user.joined} · by ${user.createdBy || "System admin"}`],
            ["Last modified", lastEdit ? `${lastEdit.t} · by ${lastEdit.actor}` : "Never modified"],
            ["Account status", user.status],
            ["Record id", user.id.toUpperCase()],
          ].map(([label, value]) => (
            <span key={label} className="block min-w-0">
              <span className="block text-xs text-muted">{label}</span>
              <span className="mt-px block text-sm text-ink">{value}</span>
            </span>
          ))}
        </div>
      </Card>
    </div>
  );
}

const ACTIVITY_FILTERS = ["Everything", "Sign-in", "App", "Account", "Session"] as const;
const PAGE = 8;

/**
 * Their use of the system, not their work. Filtered by kind because an admin
 * arrives with one question — "when did they last actually open it?" — and a
 * mixed list buries the answer.
 */
function ActivityTab({ user }: { user: AdminUser }) {
  const { registry } = useAdmin();
  const [filter, setFilter] = React.useState<(typeof ACTIVITY_FILTERS)[number]>("Everything");
  const [shown, setShown] = React.useState(PAGE);

  const all = activityFor(user.id, user.joined, user.createdBy);
  const rows = filter === "Everything" ? all : all.filter((r) => r.kind === (filter as ActivityKind));
  const page = rows.slice(0, shown);

  return (
    <div>
      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Platform activity"
          hint="Their use of the system, not their work."
          action={
            <span className="text-[13px] whitespace-nowrap text-muted">
              {rows.length} of {all.length} records
            </span>
          }
        />
        <div className="border-b border-divider px-5 py-3">
          <FilterPills
            options={ACTIVITY_FILTERS.map((f) => ({
              key: f,
              label: f === "App" ? "App opens" : f === "Account" ? "Account changes" : f,
              count: f === "Everything" ? all.length : all.filter((r) => r.kind === f).length,
            }))}
            value={filter}
            onChange={(f) => {
              setFilter(f);
              setShown(PAGE);
            }}
          />
        </div>
        {rows.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-muted">
            Nothing of that kind on this account.
          </div>
        ) : null}
        {page.map((r, i) => (
          <div key={`${r.t}-${r.what}`} className={cx("flex gap-4 px-5 py-3", i ? "border-t border-canvas" : "")}>
            <span className="w-[150px] flex-none text-[13px] text-muted">{r.t}</span>
            <span className="w-[92px] flex-none">
              <Badge tone={r.kind === "Sign-in" ? "success" : r.kind === "Account" ? "warn" : "neutral"}>
                {r.kind}
              </Badge>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink">{r.what}</span>
              <span className="block text-[13px] text-muted">{r.meta}</span>
            </span>
          </div>
        ))}
        {shown < rows.length ? (
          <div className="border-t border-divider px-5 py-3 text-center">
            <Button size="sm" variant="ghost" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, rows.length - shown)} more
            </Button>
          </div>
        ) : null}
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader title="App usage" hint="Granted but never opened is the sign of access nobody needed." />
        <div className="flex flex-wrap gap-5 px-5 py-3.5">
          {user.apps.length === 0 ? <span className="text-sm text-muted">No apps granted.</span> : null}
          {user.apps.map((id) => (
            <span key={id} className="block">
              <span className="block text-sm font-medium text-ink">
                {registry.find((a) => a.id === id)?.name}
              </span>
              <span className={cx("block text-[13px]", id === "crm" ? "text-body" : "text-warn-ink")}>
                {id === "crm" ? "18 times this week" : "Never opened"}
              </span>
            </span>
          ))}
        </div>
      </Card>
    </div>
  );
}

function NotesTab({
  user,
  notes,
  onAdd,
}: {
  user: AdminUser;
  notes: Array<{ text: string; by: string; t: string }>;
  onAdd: (id: string, text: string) => void;
}) {
  const [draft, setDraft] = React.useState("");
  const { notify } = useAdmin();

  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <CardHeader
        title="Admin notes"
        hint="For things the system cannot know — cover arrangements, leave, context for the next admin."
      />
      <div className="flex gap-2.5 border-b border-divider px-5 py-3.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="On leave until the 20th, book covered by Rakesh"
          className="flex-1"
        />
        <Button
          variant="primary"
          onClick={() => {
            const v = draft.trim();
            if (!v) return notify("Type the note first");
            onAdd(user.id, v);
            setDraft("");
          }}
        >
          Add note
        </Button>
      </div>
      {notes.length === 0 ? (
        <div className="px-5 py-6 text-sm text-muted">No notes on this account yet.</div>
      ) : null}
      {notes.map((n, i) => (
        <div key={`${n.text}-${i}`} className={cx("px-5 py-3", i ? "border-t border-canvas" : "")}>
          <div className="text-sm text-ink">{n.text}</div>
          <div className="mt-0.5 text-xs text-muted">
            {n.by} · {n.t}
          </div>
        </div>
      ))}
    </Card>
  );
}

/* --------------------------------------------------------------- offboarding */

const STEPS = ["Impact", "Reassign", "Access", "Confirm", "Summary"] as const;
const REASONS = ["Resigned", "Terminated", "Role change", "Extended leave", "Other"];
const ACCESS_MODES = [
  "Revoke everything now",
  "End sessions, keep access until the effective date",
  "Schedule access to end on a future date",
];

/**
 * Deactivating somebody is five decisions, not one. Their book has to land
 * somewhere before the account closes, and the resulting workload is shown so
 * nobody is quietly handed four hundred customers.
 */
function OffboardWizard({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const { users, patchUser, record, notify } = useAdmin();
  const owned = ownedFor(user.id);
  const candidates = users.filter((u) => u.status === "Active" && u.id !== user.id);

  const [step, setStep] = React.useState(1);
  const [to, setTo] = React.useState(candidates[0]?.name ?? "");
  const [accessMode, setAccessMode] = React.useState(ACCESS_MODES[0]);
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState("");
  const [date, setDate] = React.useState("2026-08-07");
  const [reasonError, setReasonError] = React.useState(false);

  const dest = users.find((u) => u.name === to);

  function next() {
    if (step === 4 && !reason.trim()) return setReasonError(true);
    if (step === 4) {
      patchUser(user.id, { status: "Deactivated", apps: [], roles: {}, deactReason: reason });
      record("access", "Platform", "User deactivated", "Active", "Deactivated");
    }
    setStep((s) => Math.min(5, s + 1));
  }

  return (
    <div className="animate-fade-in fixed inset-0 z-[72] flex items-center justify-center bg-[rgba(26,30,40,0.45)] p-6">
      <div className="flex max-h-[calc(100vh-48px)] w-[720px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-[6px] bg-surface shadow-[0_8px_24px_rgba(22,22,22,0.12)]">
        <div className="flex-none border-b border-line px-5 py-4">
          <div className="text-lg font-semibold text-ink">Offboard {user.name}</div>
          <div className="mt-3 flex items-center gap-2">
            {STEPS.map((label, i) => {
              const n = i + 1;
              return (
                <span key={label} className={cx("flex items-center gap-2", n === 5 ? "flex-none" : "flex-1")}>
                  <span
                    className={cx(
                      "flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] font-medium",
                      step > n ? "bg-brand-lime text-ink" : step === n ? "bg-brand text-white" : "bg-divider text-body",
                    )}
                  >
                    {step > n ? "✓" : n}
                  </span>
                  <span
                    className={cx(
                      "text-[13px] whitespace-nowrap",
                      step === n ? "font-medium text-[#5223E0]" : "text-muted",
                    )}
                  >
                    {label}
                  </span>
                  {n === 5 ? null : (
                    <span className={cx("h-0.5 min-w-3 flex-1", step > n ? "bg-brand-lime" : "bg-divider")} />
                  )}
                </span>
              );
            })}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {step === 1 ? (
            <div>
              <div className="text-[15px] font-semibold text-ink">What this person owns</div>
              <div className="mt-1 text-sm leading-[21px] text-muted">
                Pulled live from every app. None of it can be left stranded.
              </div>
              <div className="mt-3.5 overflow-hidden rounded-[4px] border border-line">
                {owned.length === 0 ? (
                  <div className="p-5 text-sm text-muted">Nothing owned in any app.</div>
                ) : null}
                {owned.map((r, i) => (
                  <div
                    key={`${r.appId}-${r.key}`}
                    className={cx("flex items-center gap-4 px-4 py-3", i ? "border-t border-canvas" : "")}
                  >
                    <span
                      className={cx(
                        "min-w-12 text-right text-lg font-semibold",
                        r.count > 100 ? "text-warn-ink" : "text-ink",
                      )}
                    >
                      {r.count}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-ink">{r.label}</span>
                      <span className="block text-[13px] text-muted">{r.app}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div>
              <div className="text-[15px] font-semibold text-ink">Reassign their work</div>
              <div className="mt-1 text-sm leading-[21px] text-muted">
                The resulting workload is shown so nobody is quietly handed four hundred customers.
              </div>
              <label className="mt-3.5 block">
                <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
                  Reassign everything to
                </span>
                <Select value={to} onChange={(e) => setTo(e.target.value)} className="w-[280px]">
                  {candidates.map((c) => (
                    <option key={c.id}>{c.name}</option>
                  ))}
                </Select>
              </label>
              <div className="mt-3.5 overflow-hidden rounded-[4px] border border-line">
                {owned
                  .filter((r) => r.reassignable)
                  .map((r, i) => {
                    const destOwned = dest ? ownedFor(dest.id).find((x) => x.key === r.key) : undefined;
                    const after = (destOwned?.count ?? 0) + r.count;
                    return (
                      <div key={`${r.appId}-${r.key}`} className={cx("px-4 py-3", i ? "border-t border-canvas" : "")}>
                        <div className="flex items-baseline gap-2.5">
                          <span className="min-w-0 flex-1 text-sm font-medium text-ink">
                            {r.count} × {r.label}
                          </span>
                          <span className="flex-none text-[13px] text-muted">{r.app}</span>
                        </div>
                        <div
                          className={cx(
                            "text-[13px] font-medium",
                            after > 200 ? "text-danger" : after > 150 ? "text-warn-ink" : "text-success",
                          )}
                        >
                          {dest?.name} would hold {after}{" "}
                          {r.label.toLowerCase().replace(" owned", "").replace(" assigned", "").replace(" outstanding", "")}
                        </div>
                      </div>
                    );
                  })}
                {owned.filter((r) => r.reassignable).length === 0 ? (
                  <div className="p-5 text-sm text-muted">Nothing needs reassigning.</div>
                ) : null}
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div>
              <div className="text-[15px] font-semibold text-ink">Access and sessions</div>
              <label className="mt-3.5 block">
                <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
                  When access ends
                </span>
                <Select value={accessMode} onChange={(e) => setAccessMode(e.target.value)} className="w-full">
                  {ACCESS_MODES.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </Select>
              </label>
              <div className="mt-2.5 text-[13px] leading-[19px] text-muted">
                Every session is ended either way. No password is displayed or changed at any point.
              </div>
            </div>
          ) : null}

          {step === 4 ? (
            <div>
              <div className="text-[15px] font-semibold text-ink">Confirm</div>
              <label className="mt-3.5 block">
                <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
                  Reason · required
                </span>
                <Select
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setReasonError(false);
                  }}
                  className={cx("w-full", reasonError && "border-danger")}
                >
                  <option value="">Choose a reason</option>
                  {REASONS.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </Select>
                {reasonError ? (
                  <span className="mt-1 block text-[13px] text-danger">
                    Pick a reason — it is recorded on the offboarding record.
                  </span>
                ) : null}
              </label>
              <label className="mt-3.5 block">
                <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">Note</span>
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Left the company on 31 Aug"
                  className="h-[72px]"
                />
              </label>
              <label className="mt-3.5 block">
                <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
                  Effective date
                </span>
                <span className="block w-[200px]">
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </span>
              </label>
            </div>
          ) : null}

          {step === 5 ? (
            <div>
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[6px] bg-success-soft">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1D7A45" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m5 13 4 4L19 7" />
                  </svg>
                </span>
                <span className="text-[15px] font-semibold text-ink">{user.name} has been offboarded</span>
              </div>
              <div className="mt-3.5 overflow-hidden rounded-[4px] border border-line">
                {[
                  ["Account", `${user.name} · ${user.code}`],
                  ["Reason", reason + (note.trim() ? ` — ${note}` : "")],
                  ["Effective", date],
                  ["Reassigned to", owned.length ? to : "Nothing to reassign"],
                  ["Access", accessMode],
                  ["Sessions ended", "All"],
                ].map(([label, value], i) => (
                  <div
                    key={label}
                    className={cx("flex justify-between gap-4 px-4 py-2.5", i ? "border-t border-canvas" : "")}
                  >
                    <span className="text-[13px] text-muted">{label}</span>
                    <span className="text-right text-sm font-medium text-ink">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex flex-none items-center gap-2.5 border-t border-line px-5 py-3">
          {step === 5 ? (
            <Button variant="ghost" onClick={() => notify("Offboarding record exported")}>
              Export the record
            </Button>
          ) : null}
          <span className="flex-1" />
          {step > 1 && step < 5 ? (
            <Button variant="ghost" onClick={() => setStep((s) => Math.max(1, s - 1))}>
              Back
            </Button>
          ) : null}
          {step < 5 ? (
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          ) : null}
          {step === 5 ? (
            <Button
              variant="primary"
              onClick={() => {
                onClose();
                onDone();
              }}
            >
              Done
            </Button>
          ) : (
            <Button variant="primary" onClick={next}>
              {step === 4 ? `Deactivate ${user.name}` : "Continue"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
