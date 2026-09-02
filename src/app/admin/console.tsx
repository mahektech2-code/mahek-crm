"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppSwitcher } from "@/components/shell/app-switcher";
import type { AppDefinition } from "@/lib/apps";
import { Badge, Button, Card, EmptyState, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { ToastProvider } from "@/components/ui/toast";
import type { Config } from "@/lib/config/registry";
import { crmSchema, toStored } from "@/lib/config/schema-contract";
import type { Collection } from "@/lib/config/entity-collections";
import { updateConfigSettings } from "@/lib/actions/crm";
import { PLATFORM_SUBTITLES, PLATFORM_TABS } from "./data";
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
import { SchemaInspector } from "./platform-extra";
import {
  AttentionTab,
  AuditTab,
  DriftTab,
  HealthTab,
  ImportsTab,
  IntegrationsTab,
  JobsTab,
  MigrationsTab,
  NotificationsTab,
  OnboardingTab,
  RegistryTab,
  SessionsTab,
  UsageTab,
  type PlatformData,
} from "./platform-real";
import { CATALOGUE_SUBTITLE, CATALOGUE_TABS, CatalogueSection } from "./catalogue-section";
import type { CatalogueData } from "./catalogue-data";
import { SHEET_SUBTITLE, SHEET_TABS, type SheetData } from "./sheet-data";
import { SheetSection } from "./sheet-section";
import { VoiceSection, VOICE_SUBTITLE, type VoiceData } from "./voice-section";
import { ComponentsScreen } from "./components-section";
import type { Person } from "@/lib/services/admin-people-service";
import type { AccessRow } from "@/lib/services/access-service";
import { AccessSection } from "./access-section";
import { FeedbackSection, type FeedbackData } from "./feedback-section";
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
  { key: "feedback", label: "Feedback" },
  { key: "voice", label: "Voice" },
  { key: "components", label: "Components" },
  { key: "audit", label: "Audit" },
] as const;

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

/**
 * The catalogue is the CRM's data rather than its configuration, so it gets its
 * own section instead of a settings tab: a settings tab saves a change set, and
 * this saves one row at a time against a table every order line points at.
 */
const CATALOGUE_SECTION = "catalogue";

/**
 * The imported order sheet. Data rather than configuration, like the
 * catalogue — and read-only, because the spreadsheet is the source and a
 * second place to edit a figure is a second answer to the same question.
 */
const SHEET_SECTION = "order-sheet";

/** Section keys the platform owns. An app may not take one of these. */
const PLATFORM_KEYS: ReadonlySet<string> = new Set([
  ...PLATFORM_NAV.map((n) => n.key),
  CATALOGUE_SECTION,
  SHEET_SECTION,
]);


export function AdminConsole({
  apps,
  crm,
  catalogue,
  sheet,
  voice,
  people,
  access,
  feedback,
  platform,
  me,
  isPlatformAdmin,
  initial,
}: {
  apps: AppDefinition[];
  crm: CrmConfig;
  catalogue: CatalogueData;
  sheet: SheetData;
  voice: VoiceData;
  people: Person[];
  /** Who opens what, and how far into it. The People section IS this. */
  access: AccessRow[];
  feedback: FeedbackData;
  platform: PlatformData;
  /** The account actually signed in. The console shows who you ARE. */
  me: { name: string; initials: string; role: string };
  isPlatformAdmin: boolean;
  /** Where the URL says to open. */
  initial: Address;
}) {
  return (
    <ToastProvider>
      <AdminStore people={people} me={me}>
        <ConsoleShell
          apps={apps}
          crm={crm}
          catalogue={catalogue}
          sheet={sheet}
          voice={voice}
          access={access}
          feedback={feedback}
          platform={platform}
          me={me}
          isPlatformAdmin={isPlatformAdmin}
          initial={initial}
        />
        <AdminDrawer />
      </AdminStore>
    </ToastProvider>
  );
}

/**
 * An app's section is addressed `app-<id>`.
 *
 * Two of the app ids — `people` and `apps` — are also platform section keys,
 * and a bare id let the app win: /admin/people opened "Attendance & People,
 * registered but not built" instead of the roster. A bare id is still accepted
 * for anything that is not a platform key, so /admin/crm keeps working.
 */
const APP_PREFIX = "app-";

function appIdOf(section: string, platformKeys: ReadonlySet<string>): string | null {
  if (section.startsWith(APP_PREFIX)) return section.slice(APP_PREFIX.length);
  return platformKeys.has(section) ? null : section;
}

/** Computed once from the CRM's own declaration — pure, so it runs here too. */
const CRM_SCHEMA = crmSchema();

/** Where a screen lives: /admin/people/security. */
function addressOf(section: string, tab: string): string {
  return tab ? `/admin/${section}/${tab}` : `/admin/${section}`;
}

/** Landing on a section means landing on its first tab. */
function firstTab(section: string): string {
  if (section === "crm" || section === `${APP_PREFIX}crm`) return CRM_SCHEMA.tabs[0]?.key ?? "";
  if (section === CATALOGUE_SECTION) return CATALOGUE_TABS[0].slug;
  if (section === SHEET_SECTION) return SHEET_TABS[0].slug;
  return PLATFORM_TABS[section]?.[0]?.slug ?? "";
}

function ConsoleShell({
  apps,
  crm,
  catalogue,
  sheet,
  voice,
  access,
  feedback,
  platform,
  me,
  isPlatformAdmin,
  initial,
}: {
  apps: AppDefinition[];
  crm: CrmConfig;
  catalogue: CatalogueData;
  sheet: SheetData;
  voice: VoiceData;
  access: AccessRow[];
  feedback: FeedbackData;
  platform: PlatformData;
  me: { name: string; initials: string; role: string };
  isPlatformAdmin: boolean;
  initial: Address;
}) {
  // Config writes audit themselves server-side, one row per setting.
  const { registry, notify } = useAdmin();

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
    .filter((a) => apps.some((mine) => mine.id === a.id))
    .sort((a, b) => a.order - b.order);
  const appId = appIdOf(section, PLATFORM_KEYS);
  const appDef = appId ? (registry.find((a) => a.id === appId) ?? null) : null;
  const schema = appDef?.id === "crm" ? CRM_SCHEMA : null;
  const platformTabs = PLATFORM_TABS[section];
  const tabs: Array<{ slug: string; label: string }> = appDef
    ? (schema?.tabs.map((t) => ({ slug: t.key, label: t.label })) ?? [])
    : section === CATALOGUE_SECTION
      ? CATALOGUE_TABS.map((t) => ({ slug: t.slug, label: t.label }))
      : section === SHEET_SECTION
        ? SHEET_TABS.map((t) => ({ slug: t.slug, label: t.label }))
        : (platformTabs ?? []);
  // An unknown slug lands on the first tab rather than a blank screen — a link
  // to a tab that has since been removed should still open something.
  const tabIndex = Math.max(0, tabs.findIndex((t) => t.slug === tab));
  const tabSlug = tabs[tabIndex]?.slug ?? "";

  // A settings surface is a live app's schema tab. The platform itself
  // declares no settings — the tab that pretended it did rendered a fixture.
  const tabDef = schema ? schema.tabs[Math.min(tabIndex, schema.tabs.length - 1)] : null;
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
    notify(
      lastSet.count === 1
        ? "Change set rolled back. The setting is back to what it was."
        : `Change set rolled back. ${lastSet.count} settings are back to what they were.`,
    );
    setLastSet(null);
  }

  // What the Attention tab would show. A badge that counts a fixture is how a
  // console gets a red dot nobody can ever clear.
  const failing = platform.attention.filter((a) => a.tone === "danger").length;
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

        {/* Who is signed in. There were two fictional personas here — a
            platform admin and a CRM manager nobody could log in as — which
            meant the console named somebody other than the person reading it. */}
        <span className="flex flex-none items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-[4px] bg-brand-soft text-xs font-semibold text-[#5223E0]">
            {me.initials}
          </span>
          <span className="leading-[14px]">
            <span className="block text-[13px] font-medium whitespace-nowrap text-ink">{me.name}</span>
            <span className="block text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
              {isPlatformAdmin ? "Platform admin" : me.role}
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
                    tone={
                      n.key === "overview" && failing
                        ? "danger"
                        : n.key === "feedback" && feedback.counts.new
                          ? "danger"
                          : "neutral"
                    }
                    badge={
                      n.key === "overview" && failing
                        ? String(failing)
                        : n.key === "feedback" && feedback.counts.new
                          ? String(feedback.counts.new)
                          : undefined
                    }
                    title={
                      n.key === "feedback" && feedback.counts.new
                        ? `${feedback.counts.new} reports nobody has read yet`
                        : undefined
                    }
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
                active={appId === a.id}
                tone={a.status === "Live" ? "success" : "neutral"}
                badge={a.status === "Live" ? undefined : "Soon"}
                title={a.status === "Live" ? undefined : a.status}
                onClick={() => navigate(`${APP_PREFIX}${a.id}`, firstTab(a.id))}
              />
            ))}

            {/* Shared data rather than one app's settings: the catalogue is what
                every order line points at, and dispatch and accounts will read
                the same rows when they arrive. */}
            <div className="px-3 pt-3.5 pb-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              Data
            </div>
            <NavButton
              label="Catalogue"
              active={section === CATALOGUE_SECTION}
              tone={catalogue.summary.unresolved ? "danger" : "success"}
              badge={catalogue.summary.unresolved ? String(catalogue.summary.unresolved) : undefined}
              title={
                catalogue.summary.unresolved
                  ? `${catalogue.summary.unresolved} SKU names still need a canonical legacy ID`
                  : undefined
              }
              onClick={() => navigate(CATALOGUE_SECTION, firstTab(CATALOGUE_SECTION))}
            />
            <NavButton
              label="Order sheet"
              active={section === SHEET_SECTION}
              tone={sheet.summary.rowsWithIssues ? "danger" : "success"}
              badge={
                sheet.summary.rowsWithIssues
                  ? String(sheet.summary.rowsWithIssues)
                  : undefined
              }
              title={
                sheet.summary.rowsWithIssues
                  ? `${sheet.summary.rowsWithIssues} imported rows need attention`
                  : undefined
              }
              onClick={() => navigate(SHEET_SECTION, firstTab(SHEET_SECTION))}
            />
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
              <DetailPane id={detailId} platform={platform} onBack={() => setDetailId(null)} />
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
                        : section === CATALOGUE_SECTION
                          ? CATALOGUE_SUBTITLE
                          : section === SHEET_SECTION
                            ? SHEET_SUBTITLE
                            : section === "voice"
                              ? VOICE_SUBTITLE
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
                  isAdmin={me.role === "admin"}
                  collections={crm.collections}
                  catalogue={catalogue}
                  access={access}
                  sheet={sheet}
                  voice={voice}
                  feedback={feedback}
                  platform={platform}
                  canWriteCatalogue={crm.canWrite}
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
  isAdmin,
  collections,
  catalogue,
  access,
  sheet,
  voice,
  feedback,
  platform,
  canWriteCatalogue,
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
  /** Holds the `admin` ROLE — not merely granted the Admin Console app. See AccessSection. */
  isAdmin: boolean;
  collections: Record<string, Collection>;
  catalogue: CatalogueData;
  access: AccessRow[];
  sheet: SheetData;
  voice: VoiceData;
  feedback: FeedbackData;
  platform: PlatformData;
  canWriteCatalogue: boolean;
}) {
  if (section === CATALOGUE_SECTION) {
    return (
      <CatalogueBody catalogue={catalogue} canWrite={canWriteCatalogue} tab={tabIndex} />
    );
  }

  if (section === SHEET_SECTION) {
    return (
      <div className="mt-5">
        <SheetSection data={sheet} tab={tabIndex} />
      </div>
    );
  }

  if (section === "voice") {
    return (
      <div className="mt-5">
        <VoiceSection data={voice} />
      </div>
    );
  }

  /*
   * The design system, rendered. It lived at /crm/components, which put a
   * build-facing handoff artifact one click from a telecaller's Help centre —
   * every component in every state, useful to whoever writes the screens and
   * to nobody who works the queue. It is a platform section now, so it is
   * reachable only by somebody holding the Admin app.
   */
  if (section === "components") {
    return <ComponentsScreen />;
  }

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

  if (section === "overview") {
    if (tabIndex === 0) return <AttentionTab data={platform} navigate={navigate} />;
    if (tabIndex === 1) return <HealthTab data={platform} />;
    if (tabIndex === 2) return <IntegrationsTab data={platform} />;
    if (tabIndex === 3) return <UsageTab data={platform} />;
    if (tabIndex === 4) return <DriftTab data={platform} navigate={navigate} />;
    if (tabIndex === 6) return <SessionsTab data={platform} />;
    if (tabIndex === 7) return <OnboardingTab data={platform} />;
    return <JobsTab data={platform} />;
  }
  // One screen, dedicated to access. Sessions and the never-signed-in list
  // moved to Overview, where the rest of the platform's own answers already
  // live — this section answers who can open what, and nothing else.
  if (section === "people") {
    return <AccessSection rows={access} onOpenUser={onOpenUser} isAdmin={isAdmin} />;
  }
  if (section === "apps") {
    if (tabIndex === 0) return <RegistryTab data={platform} />;
    return <SchemaInspector />;
  }
  if (section === "data") {
    if (tabIndex === 0) return <ImportsTab data={platform} />;
    return <MigrationsTab data={platform} />;
  }
  if (section === "notifications") return <NotificationsTab data={platform} />;
  if (section === "feedback") return <FeedbackSection data={feedback} tab={tabIndex} />;
  if (section === "audit") return <AuditTab data={platform} tab={tabIndex} />;
  return null;
}

/**
 * The catalogue reads the database, so a write is followed by re-reading it
 * rather than by patching a copy in memory — the console holds no copy, the
 * same way it holds no copy of the configuration.
 *
 * A soft refresh, not a reload: `router.refresh()` re-runs the server
 * component and leaves this screen's own state alone, so an import's report
 * survives the numbers above it changing.
 */
function CatalogueBody({
  catalogue,
  canWrite,
  tab,
}: {
  catalogue: CatalogueData;
  canWrite: boolean;
  tab: number;
}) {
  const router = useRouter();
  return (
    <CatalogueSection
      tab={tab}
      data={catalogue}
      canWrite={canWrite}
      refresh={() => router.refresh()}
    />
  );
}

function DetailPane({
  id,
  platform,
  onBack,
}: {
  id: string;
  platform: PlatformData;
  onBack: () => void;
}) {
  const { users } = useAdmin();
  const user = users.find((u) => u.id === id);
  if (!user) return null;
  return <UserDetail key={user.id} user={user} platform={platform} onBack={onBack} />;
}

function PrimaryAction({ section }: { section: string }) {
  const { openDrawer } = useAdmin();
  if (section === "people") {
    return (
      <Button variant="primary" onClick={() => openDrawer({ kind: "enableAccess" })}>
        Enable access
      </Button>
    );
  }
  // Apps are code, not rows: there is nothing to register from a screen. The
  // audit log had an Export button that exported nothing.
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
