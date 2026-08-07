"use client";

import * as React from "react";
import Link from "next/link";
import { AppSwitcher } from "@/components/shell/app-switcher";
import type { AppDefinition } from "@/lib/apps";
import { Badge, Button, Card, EmptyState, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { ToastProvider } from "@/components/ui/toast";
import type { Config } from "@/lib/config/registry";
import { crmSchema, toStored } from "@/lib/config/schema-contract";
import type { Collection } from "@/lib/config/entity-collections";
import { updateConfigSettings } from "@/lib/actions/crm";
import { INTEGRATIONS, PLATFORM_SUBTITLES, PLATFORM_TABS } from "./data";
import { PLATFORM_SCHEMA } from "./data-platform";
import { NotificationsSection } from "./platform-extra";
import {
  changeSet,
  dirtyFields,
  impactRows,
  introducedProblems,
  readable,
  savedValue,
  type Values,
} from "./settings-model";
import { SettingsSection } from "./settings-section";
import { SettingsToolbar } from "./settings-tools";
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
  { key: "data", label: "Data" },
  { key: "notifications", label: "Notifications" },
  { key: "audit", label: "Audit" },
] as const;

/** Apps → the last sub-tab is MahekOne's own configuration, rendered by the same renderer. */
const PLATFORM_SETTINGS_TAB = 7;

export type CrmConfig = {
  /** Stored values, in console shape, keyed by setting key. */
  values: Values;
  /** The raw stored config, for the consistency check the server also runs. */
  config: Config;
  /** Problems already present before anybody edits anything. */
  warnings: string[];
  /** Whether this person may write configuration at all. */
  canWrite: boolean;
  /** The rows behind each collection the CRM declares. */
  collections: Record<string, Collection>;
};

export type Address = { section?: string; tab?: string };

export function AdminConsole({
  apps,
  crm,
  isPlatformAdmin,
  initial,
}: {
  apps: AppDefinition[];
  crm: CrmConfig;
  isPlatformAdmin: boolean;
  /** Where the URL says to open. */
  initial: Address;
}) {
  return (
    <ToastProvider>
      <AdminStore>
        <ConsoleShell apps={apps} crm={crm} isPlatformAdmin={isPlatformAdmin} initial={initial} />
        <AdminDrawer />
      </AdminStore>
    </ToastProvider>
  );
}

/** Computed once from the CRM's own declaration — pure, so it runs here too. */
const CRM_SCHEMA = crmSchema();

/** Where a screen lives: /admin/people/security. */
function addressOf(section: string, tab: string): string {
  return tab ? `/admin/${section}/${tab}` : `/admin/${section}`;
}

/** Landing on a section means landing on its first tab. */
function firstTab(section: string): string {
  if (section === "crm") return CRM_SCHEMA.tabs[0]?.key ?? "";
  return PLATFORM_TABS[section]?.[0]?.slug ?? "";
}

function ConsoleShell({
  apps,
  crm,
  isPlatformAdmin,
  initial,
}: {
  apps: AppDefinition[];
  crm: CrmConfig;
  isPlatformAdmin: boolean;
  initial: Address;
}) {
  const { me, personas, setPersona, registry, notify, record } = useAdmin();

  // A CRM manager has no platform sections at all, so they start in the CRM.
  const [section, setSection] = React.useState<string>(initial.section ?? (isPlatformAdmin ? "overview" : "crm"));
  const [tab, setTab] = React.useState<string>(initial.tab ?? "");

  const [detailId, setDetailId] = React.useState<string | null>(null);

  // Saved values and, until Save, per-field drafts. Nothing is written until the
  // whole section is saved — half the relationships only hold across fields.
  const [values, setValues] = React.useState<Values>(crm.values);
  const [saving, setSaving] = React.useState(false);
  const [drafts, setDrafts] = React.useState<Values>({});
  const [reviewOpen, setReviewOpen] = React.useState(false);
  // What the last applied change set replaced, so it can be put back. Reset to
  // default is a different question from reset to what it was before I broke it.
  const [lastSet, setLastSet] = React.useState<null | {
    count: number;
    owner: string;
    /** Console shape, for the local state. */
    before: Values;
    /** Stored shape, for the write path. */
    entries: Array<{ key: string; value: unknown }>;
  }>(null);
  const [guard, setGuard] = React.useState<null | { count: number; go: () => void }>(null);

  const visibleApps = registry
    .filter((a) => me.apps.includes(a.id))
    .sort((a, b) => a.order - b.order);
  const appDef = registry.find((a) => a.id === section) ?? null;
  const schema = appDef?.id === "crm" ? CRM_SCHEMA : null;
  const platformTabs = PLATFORM_TABS[section];
  const tabs: Array<{ slug: string; label: string }> = appDef
    ? (schema?.tabs.map((t) => ({ slug: t.key, label: t.label })) ?? [])
    : (platformTabs ?? []);
  // An unknown slug lands on the first tab rather than a blank screen — a link
  // to a tab that has since been removed should still open something.
  const tabIndex = Math.max(0, tabs.findIndex((t) => t.slug === tab));
  const tabSlug = tabs[tabIndex]?.slug ?? "";

  // A settings surface is either a live app's schema tab or, on Apps, the
  // platform's own schema. The renderer cannot tell the two apart.
  const tabDef = schema
    ? schema.tabs[Math.min(tabIndex, schema.tabs.length - 1)]
    : section === "apps" && tabIndex === PLATFORM_SETTINGS_TAB
      ? PLATFORM_SCHEMA.tabs[0]
      : null;
  const settingsOpen = !!tabDef && (appDef ? appDef.status === "Live" : true);
  const settingsOwner = appDef?.name ?? "Platform";

  const dirty = dirtyFields(tabDef, values, drafts);
  // The CRM section is checked against the real stored config with the CRM's
  // own rules; the platform section has no such contract yet.
  const errors = appDef?.id === "crm" ? introducedProblems(tabDef, values, drafts, crm.config) : [];
  const impact = impactRows(tabDef, values, drafts);

  // Leaving a section with unsaved work asks first — the drafts are discarded,
  // not quietly carried to the next screen where they would look saved.
  function navigate(nextSection: string, nextTab: string) {
    const go = () => {
      setSection(nextSection);
      setTab(nextTab);
      setDrafts({});
      setDetailId(null);
      setGuard(null);
      // The URL is the address of what you are looking at, so a screen can be
      // linked to, bookmarked, and reached again with the back button.
      window.history.pushState(null, "", addressOf(nextSection, nextTab));
    };
    if (dirty.length) return setGuard({ count: dirty.length, go });
    go();
  }

  // Opening /admin with no address resolves to a real screen, so the address
  // bar matches what is on it and copying the URL actually works. Replace, not
  // push — resolving a default is not a navigation somebody can go back from.
  React.useEffect(() => {
    if (!tabSlug) return;
    const address = addressOf(section, tabSlug);
    if (window.location.pathname === address) return;
    window.history.replaceState(null, "", address);
  }, [section, tabSlug]);

  // Back and forward move between screens instead of leaving the console.
  React.useEffect(() => {
    const onPop = () => {
      const [, , popSection, popTab] = window.location.pathname.split("/");
      setSection(popSection || (isPlatformAdmin ? "overview" : "crm"));
      setTab(popTab ?? "");
      setDrafts({});
      setDetailId(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [isPlatformAdmin]);

  async function commit() {
    const entries = changeSet(tabDef, values, drafts);

    // Platform settings have no write path yet, so they stay where they are
    // rather than pretending to save.
    if (appDef?.id !== "crm") {
      const next = { ...values };
      for (const f of dirty) next[f.key] = drafts[f.key];
      setValues(next);
      setDrafts({});
      setReviewOpen(false);
      notify("Platform settings are not stored yet — this change is not saved.");
      return;
    }

    setSaving(true);
    const result = await updateConfigSettings(entries);
    setSaving(false);
    if (!result.ok) {
      notify(result.error ?? "That did not save.");
      return;
    }

    const next = { ...values };
    for (const f of dirty) {
      next[f.key] = drafts[f.key];
      record("config", settingsOwner, f.label, readable(savedValue(values, f)), readable(drafts[f.key]));
    }
    setLastSet({
      count: dirty.length,
      owner: settingsOwner,
      before: Object.fromEntries(dirty.map((f) => [f.key, savedValue(values, f)])),
      entries: dirty.map((f) => ({
        key: f.key,
        value: toStored(savedValue(values, f), f.control, f.def),
      })),
    });
    setValues(next);
    setDrafts({});
    setReviewOpen(false);
    notify(result.message ?? "Saved");
  }

  function save() {
    if (errors.length) return notify("Fix the flagged relationships first");
    if (!dirty.length) return;
    // A change set is reviewed as one thing. A single change with no downstream
    // effect does not need a modal in front of it.
    if (impact.length || dirty.length > 1) return setReviewOpen(true);
    commit();
  }

  async function rollback() {
    if (!lastSet) return;
    if (appDef?.id === "crm") {
      const result = await updateConfigSettings(lastSet.entries);
      if (!result.ok) return notify(result.error ?? "That did not roll back.");
    }
    setValues((v) => ({ ...v, ...lastSet.before }));
    record("config", lastSet.owner, "Change set rolled back", `${lastSet.count} settings`, "previous values");
    notify(
      lastSet.count === 1
        ? "Change set rolled back. The setting is back to what it was."
        : `Change set rolled back. ${lastSet.count} settings are back to what they were.`,
    );
    setLastSet(null);
  }

  const failing = INTEGRATIONS.filter((i) => i.state === "Failing").length;
  const readOnly = appDef?.id === "crm" && !crm.canWrite;

  return (
    <div className="flex h-screen min-w-[1000px] flex-col overflow-hidden bg-canvas">
      <header className="relative z-20 flex h-14 flex-none items-center gap-4 border-b border-line bg-surface px-5">
        {/* The same switcher every other app carries. Moving between apps is a
            platform affordance, not something each app decides to offer. */}
        {apps.length > 1 ? <AppSwitcher apps={apps} current="admin" /> : null}
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
                setTab("");
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
            {isPlatformAdmin ? (
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
                    onClick={() => navigate(n.key, firstTab(n.key))}
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
                onClick={() => navigate(a.id, firstTab(a.id))}
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
                  {tabs.map((t, i) => (
                    <button
                      key={t.slug}
                      onClick={() => navigate(section, t.slug)}
                      className={cx(
                        "-mb-px cursor-pointer border-b-2 px-1 py-2.5 text-sm whitespace-nowrap",
                        i === tabIndex
                          ? "border-brand font-medium text-[#5223E0]"
                          : "border-transparent text-muted hover:text-body",
                      )}
                      style={{ marginRight: 20 }}
                    >
                      {t.label}
                      {i === tabIndex && dirty.length ? (
                        <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand align-middle" />
                      ) : null}
                    </button>
                  ))}
                </div>

                {settingsOpen && tabDef ? (
                  <SettingsToolbar tab={tabDef} owner={settingsOwner} values={values} />
                ) : null}

                {appDef?.id === "crm" && crm.warnings.length ? (
                  <div className="mt-4 rounded-[4px] border border-warn-line border-l-[3px] border-l-warn bg-warn-soft px-4 py-3">
                    <div className="text-sm font-medium text-warn-ink">
                      The stored configuration is already inconsistent
                    </div>
                    <div className="mt-1.5 flex flex-col gap-1">
                      {crm.warnings.map((w) => (
                        <div key={w} className="text-sm leading-[21px] text-ink">
                          {w}
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 text-[13px] text-muted">
                      Saving is not blocked by this — you cannot fix one half of it otherwise.
                    </div>
                  </div>
                ) : null}

                <SectionBody
                  section={section}
                  tabIndex={tabIndex}
                  navigate={navigate}
                  onOpenUser={setDetailId}
                  settingsOpen={settingsOpen}
                  comingSoon={appDef && appDef.status !== "Live" ? appDef : null}
                  noSchema={appDef && appDef.status === "Live" && !schema ? appDef.name : null}
                  tabDef={tabDef}
                  values={values}
                  drafts={drafts}
                  errors={errors}
                  onDraft={(key, value) => setDrafts((d) => ({ ...d, [key]: value }))}
                  isPlatformAdmin={isPlatformAdmin}
                  collections={crm.collections}
                />

                {settingsOpen ? (
                  <div className="sticky bottom-0 mt-5 bg-canvas pt-4">
                    <Card className="flex items-center gap-3 px-5 py-3 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
                      <span className="text-sm text-body">
                        {readOnly
                          ? "Read-only. Configuration is changed by a manager."
                          : errors.length
                          ? `${errors.length} ${errors.length === 1 ? "relationship" : "relationships"} to fix before saving`
                          : dirty.length
                            ? `${dirty.length} unsaved ${dirty.length === 1 ? "change" : "changes"} in this section`
                            : "No unsaved changes. Values take effect the moment they are saved."}
                      </span>
                      <span className="flex-1" />
                      {!dirty.length && lastSet ? (
                        <Button variant="ghost" onClick={rollback}>
                          Undo the last change set
                        </Button>
                      ) : null}
                      {dirty.length ? (
                        <Button variant="secondary" onClick={() => setDrafts({})}>
                          Discard changes
                        </Button>
                      ) : null}
                      <Button
                        variant="primary"
                        disabled={readOnly || saving || !!errors.length || !dirty.length}
                        title={
                          readOnly
                            ? "You can see these settings but not change them"
                            : errors.length
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
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        title="Review this change set"
        width={620}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReviewOpen(false)}>
              Keep editing
            </Button>
            <Button variant="primary" onClick={commit}>
              {saving ? "Saving…" : `Apply ${dirty.length} change${dirty.length === 1 ? "" : "s"}`}
            </Button>
          </>
        }
      >
        <div className="text-sm leading-[21px] text-body">
          {impact.length
            ? "Applied together, as one change. Some of these alter who appears in a worklist tomorrow."
            : "Applied together, as one change, so the system is never briefly half-configured."}
        </div>
        <div className="mt-3.5 overflow-hidden rounded-[4px] border border-line">
          {dirty.map((f, i) => {
            const row = impact.find((r) => r.setting === f.label);
            return (
              <div key={f.key} className={cx("px-3.5 py-3", i ? "border-t border-canvas" : "")}>
                <div className="text-sm font-medium text-ink">{f.label}</div>
                <div className="mt-0.5 font-mono text-[13px] text-muted">
                  {readable(savedValue(values, f))} →{" "}
                  <span className="text-ink">{readable(drafts[f.key])}</span>
                </div>
                {row?.effect ? (
                  <div
                    className={cx(
                      "mt-1.5 text-sm font-medium",
                      row.tone === "warn" ? "text-warn-ink" : row.tone === "ok" ? "text-success" : "text-body",
                    )}
                  >
                    {row.effect}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="mt-3 text-[13px] text-muted">
          Applying this can be undone in one action from the save bar.
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
  settingsOpen,
  comingSoon,
  noSchema,
  tabDef,
  values,
  drafts,
  errors,
  onDraft,
  isPlatformAdmin,
  collections,
}: {
  section: string;
  tabIndex: number;
  navigate: (section: string, tab: string) => void;
  onOpenUser: (id: string) => void;
  settingsOpen: boolean;
  comingSoon: { name: string; desc: string } | null;
  /** The app's name when it is live but declares nothing to configure. */
  noSchema: string | null;
  tabDef: React.ComponentProps<typeof SettingsSection>["tab"] | null;
  values: Values;
  drafts: Values;
  errors: React.ComponentProps<typeof SettingsSection>["errors"];
  onDraft: (key: string, value: unknown) => void;
  isPlatformAdmin: boolean;
  collections: Record<string, Collection>;
}) {
  if (comingSoon) {
    return (
      <Card className="mt-5">
        <EmptyState
          title={`${comingSoon.name} is registered but not built`}
          body={`${comingSoon.desc} Its settings appear here automatically once it publishes a configuration schema — this console needs no change.`}
          action={
            <Button variant="secondary" onClick={() => navigate("apps", "registry")}>
              Open its registry entry
            </Button>
          }
        />
      </Card>
    );
  }

  // A live app that publishes no schema has no settings, which is different
  // from not being built. Say which, rather than rendering nothing.
  if (noSchema) {
    return (
      <Card className="mt-5">
        <EmptyState
          title={`${noSchema} publishes no configuration schema`}
          body="The app is live, but it declares no settings — so there is nothing to configure here. Contract validation shows whether its schema endpoint is reachable."
          action={
            <Button variant="secondary" onClick={() => navigate("apps", "contracts")}>
              Open contract validation
            </Button>
          }
        />
      </Card>
    );
  }

  if (settingsOpen && tabDef) {
    return (
      <SettingsSection
        tab={tabDef}
        values={values}
        drafts={drafts}
        errors={errors}
        onDraft={onDraft}
        isPlatformAdmin={isPlatformAdmin}
        collections={collections}
      />
    );
  }

  if (section === "overview") return <OverviewSection tab={tabIndex} navigate={navigate} />;
  if (section === "people") return <PeopleSection tab={tabIndex} onOpenUser={onOpenUser} />;
  if (section === "apps") return <AppsSection tab={tabIndex} />;
  if (section === "data") return <DataSection tab={tabIndex} />;
  if (section === "notifications") return <NotificationsSection tab={tabIndex} />;
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
