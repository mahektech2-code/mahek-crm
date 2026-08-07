"use client";

import * as React from "react";
import Link from "next/link";
import { Badge, Button, Card, EmptyState, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { ToastProvider } from "@/components/ui/toast";
import {
  INTEGRATIONS,
  PLATFORM_SUBTITLES,
  PLATFORM_TABS,
  schemaFor,
} from "./data";
import {
  crossCheck,
  dirtyFields,
  impactRows,
  readable,
  savedValue,
  type Values,
} from "./settings-model";
import { SettingsSection } from "./settings-section";
import { AppsSection, AuditSection, DataSection, OverviewSection } from "./platform-sections";
import { PeopleSection } from "./people-section";
import { UserDetail } from "./user-detail";
import { AdminDrawer } from "./drawers";
import { AdminStore, useAdmin } from "./store";

/* ---------------------------------------------------------------------------
 * The Admin Console.
 *
 * Two kinds of section live in one shell: the platform sections, which only a
 * platform admin reaches, and one section per registered app, rendered entirely
 * from the schema that app publishes. Nothing a person cannot reach renders at
 * all — the sidebar is not a list of things to be told no about.
 * ------------------------------------------------------------------------- */

const PLATFORM_NAV = [
  { key: "overview", label: "Overview" },
  { key: "people", label: "People" },
  { key: "apps", label: "Apps" },
  { key: "audit", label: "Audit" },
  { key: "data", label: "Data" },
] as const;

export function AdminConsole({ signedInAs }: { signedInAs: string }) {
  return (
    <ToastProvider>
      <AdminStore>
        <ConsoleShell signedInAs={signedInAs} />
        <AdminDrawer />
      </AdminStore>
    </ToastProvider>
  );
}

function ConsoleShell({ signedInAs }: { signedInAs: string }) {
  const { me, personas, setPersona, registry, notify, record } = useAdmin();

  const [section, setSection] = React.useState<string>("overview");
  const [tab, setTab] = React.useState(0);
  const [detailId, setDetailId] = React.useState<string | null>(null);

  // Saved values and, until Save, per-field drafts. Nothing is written until the
  // whole section is saved — half the relationships only hold across fields.
  const [values, setValues] = React.useState<Values>({});
  const [drafts, setDrafts] = React.useState<Values>({});
  const [impactOpen, setImpactOpen] = React.useState(false);
  const [guard, setGuard] = React.useState<null | { count: number; go: () => void }>(null);

  const visibleApps = registry
    .filter((a) => me.apps.includes(a.id))
    .sort((a, b) => a.order - b.order);
  const appDef = registry.find((a) => a.id === section) ?? null;
  const schema = appDef ? schemaFor(appDef.id) : null;
  const platformTabs = PLATFORM_TABS[section];
  const tabLabels = appDef ? (schema?.tabs.map((t) => t.label) ?? []) : (platformTabs ?? []);
  const tabIndex = Math.min(tab, Math.max(0, tabLabels.length - 1));
  const tabDef = schema ? schema.tabs[Math.min(tabIndex, schema.tabs.length - 1)] : null;

  const dirty = dirtyFields(tabDef, values, drafts);
  const errors = tabDef ? crossCheck(tabDef, values, drafts) : [];
  const impact = impactRows(tabDef, values, drafts);

  // Leaving a section with unsaved work asks first — the drafts are discarded,
  // not quietly carried to the next screen where they would look saved.
  function navigate(nextSection: string, nextTab: number) {
    const go = () => {
      setSection(nextSection);
      setTab(nextTab);
      setDrafts({});
      setDetailId(null);
      setGuard(null);
    };
    if (dirty.length) return setGuard({ count: dirty.length, go });
    go();
  }

  function commit() {
    const next = { ...values };
    for (const f of dirty) {
      next[f.key] = drafts[f.key];
      record("config", appDef?.name ?? "Platform", f.label, readable(savedValue(values, f)), readable(drafts[f.key]));
    }
    setValues(next);
    setDrafts({});
    setImpactOpen(false);
    notify(
      dirty.length === 1
        ? "1 setting saved. It takes effect immediately."
        : `${dirty.length} settings saved. They take effect immediately.`,
    );
  }

  function save() {
    if (errors.length) return notify("Fix the flagged relationships first");
    if (!dirty.length) return;
    if (impact.length) return setImpactOpen(true);
    commit();
  }

  const failing = INTEGRATIONS.filter((i) => i.state === "Failing").length;

  return (
    <div className="flex h-screen min-w-[1000px] flex-col overflow-hidden bg-canvas">
      <header className="relative z-20 flex h-14 flex-none items-center gap-4 border-b border-line bg-surface px-5">
        <Link href="/apps" className="text-[15px] font-semibold whitespace-nowrap text-ink no-underline hover:no-underline">
          MAHEK<span className="text-brand">ONE</span>
        </Link>
        <span className="h-5 w-px flex-none bg-divider" />
        <span className="text-[15px] font-semibold whitespace-nowrap text-ink">Admin Console</span>
        <span className="min-w-2 flex-1" />

        {/* Two personas, because "what a CRM manager sees here" is the whole
            point of the platform/app split and cannot be checked otherwise. */}
        <div className="flex h-[30px] flex-none items-center gap-1.5 rounded-[4px] border border-dashed border-line-strong px-1">
          <span className="pl-1.5 text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
            Viewing as
          </span>
          {personas.map((p) => (
            <button
              key={p.key}
              onClick={() => {
                setPersona(p.key);
                setSection(p.platform ? "overview" : "crm");
                setTab(0);
                setDrafts({});
                setDetailId(null);
              }}
              className={cx(
                "h-[22px] cursor-pointer rounded-[3px] border-none px-2 text-xs whitespace-nowrap",
                me.key === p.key ? "bg-brand-soft font-medium text-[#5223E0]" : "bg-transparent text-muted hover:text-body",
              )}
            >
              {p.role}
            </button>
          ))}
        </div>

        <span className="flex flex-none items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-[4px] bg-brand-soft text-xs font-semibold text-[#5223E0]">
            {me.initials}
          </span>
          <span className="leading-[14px]">
            <span className="block text-[13px] font-medium whitespace-nowrap text-ink">{me.name}</span>
            <span className="block text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
              {me.role}
            </span>
          </span>
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 flex-none flex-col border-r border-line bg-surface">
          <nav className="flex-1 overflow-y-auto p-2 pb-4">
            {me.platform ? (
              <div>
                <div className="px-3 pt-3 pb-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  Platform
                </div>
                {PLATFORM_NAV.map((n) => (
                  <NavButton
                    key={n.key}
                    label={n.label}
                    active={section === n.key}
                    tone={n.key === "overview" && failing ? "danger" : "neutral"}
                    badge={n.key === "overview" && failing ? String(failing) : undefined}
                    onClick={() => navigate(n.key, 0)}
                  />
                ))}
              </div>
            ) : null}

            <div className="px-3 pt-3.5 pb-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              Apps
            </div>
            {visibleApps.map((a) => (
              <NavButton
                key={a.id}
                label={a.name}
                active={section === a.id}
                tone={a.status === "Live" ? "success" : "neutral"}
                badge={a.status === "Live" ? undefined : "Soon"}
                title={a.status === "Live" ? undefined : a.status}
                onClick={() => navigate(a.id, 0)}
              />
            ))}
          </nav>

          <div className="flex-none border-t border-divider p-3">
            <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Schema</div>
            <div className="mt-1 text-[13px] text-body">
              {visibleApps.filter((a) => a.status === "Live").length} live schema,{" "}
              {visibleApps.filter((a) => a.status !== "Live").length} registered
            </div>
          </div>
        </aside>

        <main className="relative min-w-0 flex-1 overflow-y-auto">
          <div className="px-6 pt-6 pb-12">
            {detailId ? (
              <DetailPane id={detailId} onBack={() => setDetailId(null)} />
            ) : (
              <>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h1 className="text-[28px] leading-[34px] font-semibold text-ink">
                      {appDef ? appDef.name : titleCase(section)}
                    </h1>
                    <p className="mt-1 text-[13px] leading-[18px] text-muted">
                      {appDef
                        ? appDef.status === "Live"
                          ? "Every setting below is declared by the app and rendered from its schema — the console holds no copy of it."
                          : "Registered in the app registry, not yet built."
                        : PLATFORM_SUBTITLES[section]}
                    </p>
                  </div>
                  <PrimaryAction section={section} />
                </div>

                <div className="mt-4 flex flex-wrap items-center border-b border-line">
                  {tabLabels.map((label, i) => (
                    <button
                      key={label}
                      onClick={() => navigate(section, i)}
                      className={cx(
                        "-mb-px cursor-pointer border-b-2 px-1 py-2.5 text-sm whitespace-nowrap",
                        i === tabIndex
                          ? "border-brand font-medium text-[#5223E0]"
                          : "border-transparent text-muted hover:text-body",
                      )}
                      style={{ marginRight: 20 }}
                    >
                      {label}
                      {i === tabIndex && dirty.length ? (
                        <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand align-middle" />
                      ) : null}
                    </button>
                  ))}
                </div>

                <SectionBody
                  section={section}
                  tabIndex={tabIndex}
                  navigate={navigate}
                  onOpenUser={setDetailId}
                  appLive={!!appDef && appDef.status === "Live"}
                  comingSoon={appDef && appDef.status !== "Live" ? appDef : null}
                  tabDef={tabDef}
                  values={values}
                  drafts={drafts}
                  errors={errors}
                  onDraft={(key, value) => setDrafts((d) => ({ ...d, [key]: value }))}
                  isPlatformAdmin={me.platform}
                />

                {tabDef && appDef?.status === "Live" ? (
                  <div className="sticky bottom-0 mt-5 bg-canvas pt-4">
                    <Card className="flex items-center gap-3 px-5 py-3 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
                      <span className="text-sm text-body">
                        {errors.length
                          ? `${errors.length} ${errors.length === 1 ? "relationship" : "relationships"} to fix before saving`
                          : dirty.length
                            ? `${dirty.length} unsaved ${dirty.length === 1 ? "change" : "changes"} in this section`
                            : "No unsaved changes. Values take effect the moment they are saved."}
                      </span>
                      <span className="flex-1" />
                      {dirty.length ? (
                        <Button variant="secondary" onClick={() => setDrafts({})}>
                          Discard changes
                        </Button>
                      ) : null}
                      <Button
                        variant="primary"
                        disabled={!!errors.length || !dirty.length}
                        title={
                          errors.length
                            ? "Fix the relationships above first"
                            : !dirty.length
                              ? "Nothing to save"
                              : undefined
                        }
                        onClick={save}
                      >
                        Save changes
                      </Button>
                    </Card>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </main>
      </div>

      <Modal
        open={impactOpen}
        onClose={() => setImpactOpen(false)}
        title="Before you save"
        width={560}
        footer={
          <>
            <Button variant="secondary" onClick={() => setImpactOpen(false)}>
              Keep editing
            </Button>
            <Button variant="primary" onClick={commit}>
              Save changes
            </Button>
          </>
        }
      >
        <div className="text-sm leading-[21px] text-body">
          These changes alter who appears in a worklist tomorrow.
        </div>
        <div className="mt-3.5 overflow-hidden rounded-[4px] border border-line">
          {impact.map((row, i) => (
            <div key={row.setting} className={cx("px-3.5 py-3", i ? "border-t border-canvas" : "")}>
              <div className="text-sm font-medium text-ink">{row.setting}</div>
              <div className="mt-0.5 text-[13px] text-muted">{row.change}</div>
              <div
                className={cx(
                  "mt-1.5 text-sm font-medium",
                  row.tone === "warn" ? "text-warn-ink" : row.tone === "ok" ? "text-success" : "text-body",
                )}
              >
                {row.effect}
              </div>
            </div>
          ))}
        </div>
      </Modal>

      <Modal
        open={!!guard}
        onClose={() => setGuard(null)}
        title="Discard unsaved changes?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setGuard(null)}>
              Keep editing
            </Button>
            <Button variant="danger" onClick={() => guard?.go()}>
              Discard
            </Button>
          </>
        }
      >
        <div className="text-sm leading-[21px] text-body">
          You have {guard?.count} unsaved {guard?.count === 1 ? "change" : "changes"} in this section. Leaving
          discards them.
        </div>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------- the sections */

function SectionBody({
  section,
  tabIndex,
  navigate,
  onOpenUser,
  appLive,
  comingSoon,
  tabDef,
  values,
  drafts,
  errors,
  onDraft,
  isPlatformAdmin,
}: {
  section: string;
  tabIndex: number;
  navigate: (section: string, tab: number) => void;
  onOpenUser: (id: string) => void;
  appLive: boolean;
  comingSoon: { name: string; desc: string } | null;
  tabDef: React.ComponentProps<typeof SettingsSection>["tab"] | null;
  values: Values;
  drafts: Values;
  errors: React.ComponentProps<typeof SettingsSection>["errors"];
  onDraft: (key: string, value: unknown) => void;
  isPlatformAdmin: boolean;
}) {
  if (comingSoon) {
    return (
      <Card className="mt-5">
        <EmptyState
          title={`${comingSoon.name} is registered but not built`}
          body={`${comingSoon.desc} Its settings appear here automatically once it publishes a configuration schema — this console needs no change.`}
          action={
            <Button variant="secondary" onClick={() => navigate("apps", 0)}>
              Open its registry entry
            </Button>
          }
        />
      </Card>
    );
  }

  if (appLive && tabDef) {
    return (
      <SettingsSection
        tab={tabDef}
        values={values}
        drafts={drafts}
        errors={errors}
        onDraft={onDraft}
        isPlatformAdmin={isPlatformAdmin}
      />
    );
  }

  if (section === "overview") return <OverviewSection tab={tabIndex} navigate={navigate} />;
  if (section === "people") return <PeopleSection tab={tabIndex} onOpenUser={onOpenUser} />;
  if (section === "apps") return <AppsSection tab={tabIndex} />;
  if (section === "data") return <DataSection tab={tabIndex} />;
  if (section === "audit") return <AuditSection tab={tabIndex} />;
  return null;
}

function DetailPane({ id, onBack }: { id: string; onBack: () => void }) {
  const { users } = useAdmin();
  const user = users.find((u) => u.id === id);
  if (!user) return null;
  return <UserDetail key={user.id} user={user} onBack={onBack} />;
}

function PrimaryAction({ section }: { section: string }) {
  const { openDrawer, notify } = useAdmin();
  if (section === "people") {
    return (
      <Button variant="primary" onClick={() => openDrawer({ kind: "createUser" })}>
        Create user
      </Button>
    );
  }
  if (section === "apps") {
    return (
      <Button variant="primary" onClick={() => openDrawer({ kind: "registerApp" })}>
        Register app
      </Button>
    );
  }
  if (section === "audit") {
    return (
      <Button variant="primary" onClick={() => notify("Audit log exported")}>
        Export log
      </Button>
    );
  }
  return null;
}

function NavButton({
  label,
  active,
  tone,
  badge,
  title,
  onClick,
}: {
  label: string;
  active: boolean;
  tone: "neutral" | "success" | "danger";
  badge?: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cx(
        "relative mb-px flex h-9 w-full cursor-pointer items-center rounded-[4px] border-none border-l-[3px] pr-2.5 pl-2.5 text-left text-sm whitespace-nowrap",
        active ? "border-l-brand bg-brand-soft font-medium text-[#5223E0]" : "border-l-transparent bg-transparent text-body hover:bg-canvas",
      )}
    >
      <span className="flex w-full items-center gap-2.5">
        <span
          className={cx(
            "block h-1.5 w-1.5 flex-none rounded-full",
            tone === "danger" ? "bg-danger" : tone === "success" ? "bg-success" : "bg-line-strong",
          )}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {badge ? (
          <Badge tone={tone === "danger" ? "danger" : "neutral"}>{badge}</Badge>
        ) : null}
      </span>
    </button>
  );
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
