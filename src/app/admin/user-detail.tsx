"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardHeader, cx } from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/overlays";
import { stamp } from "@/lib/format";
import { endSessionsFor, sendPasswordResetFor, setUserActive } from "@/lib/actions/people";
import { statusTone, type AdminUser } from "./data";

import { useAdmin } from "./store";
import type { PlatformData } from "./platform-real";

/* ---------------------------------------------------------------------------
 * One account, in full.
 *
 * This screen used to carry seven tabs, most of them fixtures: an activity
 * feed nobody wrote, a session list of invented devices and IP addresses, an
 * offboarding wizard that reassigned records it had made up, and a notes
 * feature that lived in memory until the page was refreshed.
 *
 * What is left is what the database can answer — who they are, what they can
 * open, what is open right now, and what the audit log says about them — plus
 * the three actions that do something: reset, sign out everywhere, and
 * deactivate.
 * ------------------------------------------------------------------------- */

const TABS = ["Profile", "Access", "Sessions", "Audit"] as const;
type DetailTab = (typeof TABS)[number];

export function UserDetail({
  user,
  platform,
  onBack,
}: {
  user: AdminUser;
  platform: PlatformData;
  onBack: () => void;
}) {
  const router = useRouter();
  const { registry, notify } = useAdmin();
  const [tab, setTab] = React.useState<DetailTab>("Profile");
  const [busy, setBusy] = React.useState(false);

  const sessions = platform.sessions.filter((s) => s.user === user.name);
  const audit = platform.audit.filter(
    (a) => a.actor === user.name || a.entityId === user.id,
  );

  async function run(work: Promise<{ ok: boolean; message?: string; error?: string }>) {
    setBusy(true);
    try {
      const result = await work;
      notify(result.ok ? (result.message ?? "Done.") : (result.error ?? "That did not work."));
      if (result.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        onClick={onBack}
        className="mb-2.5 inline-flex cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-[13px] text-muted hover:text-body"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
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
          <div className="mt-1 text-[13px] text-muted capitalize">
            {user.platformRole} · {user.contact}
            {user.mobile ? ` · ${user.mobile}` : ""} · joined {user.joined}
          </div>
        </div>
        <div className="flex flex-none gap-2.5">
          <Button
            variant="ghost"
            disabled={busy || user.status === "Deactivated"}
            title={user.status === "Deactivated" ? "This account cannot sign in at all" : undefined}
            onClick={() => void run(sendPasswordResetFor(user.id))}
          >
            Send a field-app password link
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void run(endSessionsFor(user.id))}
          >
            End every session
          </Button>
          {user.status === "Deactivated" ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void run(setUserActive(user.id, true))}
            >
              Reactivate account
            </Button>
          ) : (
            <Button
              variant="secondary"
              className="border-danger text-danger hover:bg-danger-soft"
              disabled={busy}
              onClick={() => void run(setUserActive(user.id, false))}
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

      {tab === "Profile" ? (
        <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          <CardHeader
            title="Account"
            hint="Both the email and the work number are sign-ins: office staff know their email and telecallers know their number."
          />
          <Facts
            rows={[
              ["Name", user.name],
              ["Work email", user.contact],
              ["Work number", user.mobile || "Not recorded"],
              ["Role", user.platformRole],
              ["Reports to", user.reportsTo ?? "Nobody"],
              ["Customers in their book", String(user.customers || 0)],
              ["Created", user.created],
              ["Last signed in", user.lastSeen],
            ]}
          />
        </Card>
      ) : null}

      {tab === "Access" ? (
        <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          <CardHeader
            title="Apps"
            hint="Read here, changed on the Access screen. This tab used to carry its own checkboxes, which made two ways to grant an app — and only one of them knew about modules, so revoking and re-granting from here quietly widened a narrowed grant back to the whole app."
          />
          {registry.map((a, i) => {
            const has = user.apps.includes(a.id);
            return (
              <div
                key={a.id}
                className={cx(
                  "flex items-center gap-3 px-5 py-3",
                  i ? "border-t border-canvas" : "",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">{a.name}</span>
                  <span className="block text-[13px] text-muted">{a.desc}</span>
                </span>
                {has ? (
                  <Badge tone="success">Granted</Badge>
                ) : (
                  <span className="text-[13px] text-muted">—</span>
                )}
              </div>
            );
          })}
          <div className="bg-canvas px-5 py-2.5 text-[13px] text-muted">
            {user.apps.length === 0
              ? "No app. MahekOne opens on a launcher that says so plainly rather than a blank screen."
              : user.apps.length === 1
                ? "One app, so they are taken straight into it and never see the launcher."
                : `${user.apps.length} apps, so they land on the launcher and choose.`}
          </div>
        </Card>
      ) : null}

      {tab === "Sessions" ? (
        <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          <CardHeader
            title="Open sessions"
            hint="A session is a row: an id, an account and an expiry. No device and no IP address are stored, so none is shown."
          />
          {sessions.length === 0 ? (
            <div className="px-5 py-6 text-sm text-muted">
              Nothing open. They are not signed in anywhere.
            </div>
          ) : (
            sessions.map((s, i) => (
              <div key={s.id} className={cx("px-5 py-3", i ? "border-t border-canvas" : "")}>
                <div className="text-sm text-ink">Signed in {stamp(s.startedAt)}</div>
                <div className="mt-0.5 text-[13px] text-muted">Expires {stamp(s.expiresAt)}</div>
              </div>
            ))
          )}
        </Card>
      ) : null}

      {tab === "Audit" ? (
        <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          <CardHeader
            title="What they did, and what was done to them"
            hint="From the audit log. Read-only, and never editable by anybody."
          />
          {audit.length === 0 ? (
            <div className="px-5 py-6 text-sm text-muted">
              Nothing recorded against this account yet.
            </div>
          ) : (
            audit.map((a, i) => (
              <div key={`${a.action}-${a.at}-${i}`} className={cx("px-5 py-3", i ? "border-t border-canvas" : "")}>
                <div className="text-sm font-medium text-ink">{a.action}</div>
                <div className="mt-0.5 text-[13px] text-muted">
                  {a.detail} · {a.actor === user.name ? "by them" : `by ${a.actor ?? "the system"}`} ·{" "}
                  {stamp(a.at)}
                </div>
              </div>
            ))
          )}
        </Card>
      ) : null}
    </div>
  );
}

function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="grid gap-x-8 gap-y-3 px-5 py-4 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
      {rows.map(([label, value]) => (
        <div key={label}>
          <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            {label}
          </div>
          <div className="mt-0.5 text-sm text-ink capitalize">{value}</div>
        </div>
      ))}
    </div>
  );
}
