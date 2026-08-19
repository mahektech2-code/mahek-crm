import { redirect } from "next/navigation";
import { requireUser, isManager } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { APPS } from "@/lib/apps";
import { can } from "@/lib/access-control";
import { getConfig, configWarnings } from "@/lib/config/store";
import { listCollections } from "@/lib/config/entity-collections";
import { crmSchema, schemaFields, toConsole } from "@/lib/config/schema-contract";
import {
  catalogueSummary,
  listAliases,
  listDuplicates,
  listExceptions,
  listHierarchy,
  listSkus,
} from "@/lib/services/catalogue-service";
import { SOURCE_DISCREPANCIES } from "@/db/catalogue-seed";
import {
  listSheetIssues,
  listSheetOrders,
  assignableOwners,
  listSheetRows,
  sheetSummary,
} from "@/lib/services/sheet-order-service";
import { sheetsConfigured } from "@/lib/sheets";
import { secretStatuses } from "@/lib/secrets";
import { listPeople } from "@/lib/services/admin-people-service";
import { listAccess } from "@/lib/services/access-service";
import { feedbackCounts, listFeedback } from "@/lib/services/feedback-service";
import {
  attentionItems,
  auditRows,
  configDrift,
  importHistory,
  integrationStatus,
  jobHealth,
  liveSessions,
  migrationStatus,
  notificationLog,
  onboardingRows,
  platformHealth,
  queueOwners,
  usageStats,
} from "@/lib/services/admin-platform-service";
import {
  orderSheetId,
  orderTabTitle,
} from "@/lib/services/sheet-sync-service";
import type { Config } from "@/lib/config/registry";
import { today } from "@/lib/queries";
import { AdminConsole } from "../console";

export const metadata = { title: "Admin Console · MahekOne" };

/**
 * Access is checked here, not just hidden on the launcher — a bookmarked
 * /admin must not open for somebody who was never given the app.
 *
 * A CRM manager reaches this console too, for their own app's section. They
 * hold no platform access, so nothing outside it renders for them.
 */
/**
 * One page for every screen in the console: /admin, /admin/people,
 * /admin/people/security. The segments ARE the address — the same shape the
 * rest of MahekOne uses, rather than the console being the one place addressed
 * by query string.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { path } = await params;
  const [section, tab] = path ?? [];
  const user = await requireUser();
  const apps = await listUserApps(user.id);

  const isPlatformAdmin = apps.includes("admin");
  const canConfigureCrm = can(user.role, "config.write") && apps.includes("crm");
  if (!isPlatformAdmin && !canConfigureCrm) redirect("/apps");

  const [config, warnings, collections] = await Promise.all([
    getConfig(),
    configWarnings(),
    listCollections(),
  ]);

  // The SKU list is filtered and paged by the address, so a filtered list is a
  // screen somebody can send to somebody else.
  const query = await searchParams;
  const one = (k: string) => {
    const v = query[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const page = Math.max(1, Number(one("page") ?? 1) || 1);
  const PER_PAGE = 50;
  const status = one("status") ?? "all";

  const [summary, skuPage, hierarchy, duplicates, exceptions, aliases] = await Promise.all([
    catalogueSummary(),
    listSkus({
      query: one("q"),
      formulationId: one("formulation"),
      status: status as "all" | "ok" | "needs_canonical_id" | "inactive",
      limit: PER_PAGE,
      offset: (page - 1) * PER_PAGE,
    }),
    listHierarchy(),
    listDuplicates(),
    listExceptions(),
    listAliases(),
  ]);

  // The imported order sheet. Read here rather than in the client component so
  // the section arrives rendered, like every other section in this console.
  const [sheetStats, sheetPage, sheetOrders, sheetIssues, owners] = await Promise.all([
    sheetSummary(),
    listSheetRows({
      query: one("sq"),
      issuesOnly: one("sissues") === "1",
      page: Math.max(1, Number(one("spage") ?? 1) || 1),
      perPage: 100,
    }),
    listSheetOrders(200),
    listSheetIssues(),
    assignableOwners(),
  ]);

  // Real accounts. The People section used to render a hardcoded array.
  //
  // `access` is the same accounts read a second way — who opens which app and
  // how far into it, joined to the employee master so the screen can say
  // whether HRMS still calls this person active.
  const [people, access] = await Promise.all([listPeople(), listAccess()]);

  // What the team has sent in from the Feedback button. Read here like every
  // other section's data, so the console arrives rendered.
  const [feedbackRows, counts] = await Promise.all([listFeedback(), feedbackCounts()]);
  const secrets = await secretStatuses();

  // The platform sections. Every one of these was a fixture until now, so they
  // are read here with everything else rather than fetched by a client.
  const [
    attention,
    health,
    integrations,
    usage,
    drift,
    jobs,
    audit,
    imports,
    migrations,
    notificationRows,
    sessionRows,
    onboarding,
    queues,
  ] = await Promise.all([
    attentionItems(),
    platformHealth(),
    integrationStatus(),
    usageStats(),
    configDrift(),
    jobHealth(),
    auditRows(),
    importHistory(),
    migrationStatus(),
    notificationLog(),
    liveSessions(),
    onboardingRows(),
    // The rebuild control lives on the Jobs tab and needs to say how old each
    // list is, which is the whole question somebody opens it to answer.
    queueOwners(await today()),
  ]);

  // Stored values, projected into the shapes the console's controls edit.
  const values: Record<string, unknown> = {};
  for (const f of schemaFields(crmSchema())) {
    values[f.key] = toConsole(config[f.key as keyof Config], f.control, f.parts);
  }

  return (
    <AdminConsole
      apps={APPS.filter((a) => apps.includes(a.id))}
      isPlatformAdmin={isPlatformAdmin}
      initial={{ section, tab }}
      people={people}
      access={access}
      me={{ name: user.name, initials: user.initials, role: user.role }}
      platform={{
        attention,
        health,
        integrations,
        usage,
        drift,
        jobs,
        audit,
        imports,
        migrations,
        notifications: notificationRows,
        sessions: sessionRows,
        onboarding,
        queues,
      }}
      feedback={{
        rows: feedbackRows,
        counts,
        // Answering is a manager's, or a platform admin's. Reading is not:
        // a CRM manager on this console sees what their own team reported.
        canTriage: isManager(user) || isPlatformAdmin,
        viewerId: user.id,
        maxImages: config["attachments.maxPerFeedback"],
      }}
      sheet={{
        summary: sheetStats,
        rows: sheetPage.rows,
        total: sheetPage.total,
        page: sheetPage.page,
        pages: sheetPage.pages,
        orders: sheetOrders,
        issues: sheetIssues,
        filters: { query: one("sq"), issuesOnly: one("sissues") === "1" },
        source: {
          spreadsheetId: orderSheetId(),
          tabTitle: orderTabTitle(),
          configured: sheetsConfigured(),
        },
        owners,
        canImport: canConfigureCrm || (isPlatformAdmin && isManager(user)),
      }}
      catalogue={{
        summary,
        skus: skuPage.rows,
        total: skuPage.total,
        page,
        pages: Math.max(1, Math.ceil(skuPage.total / PER_PAGE)),
        hierarchy,
        duplicates,
        exceptions,
        aliases,
        filters: { query: one("q"), formulationId: one("formulation"), status },
        priceSource: config["products.priceSource"],
        discrepancies: SOURCE_DISCREPANCIES,
        lastReport: null,
      }}
      voice={{
        /*
         * Statuses only — which credentials exist, from where, and their last
         * four characters. `secretStatuses` cannot return a key, so a future
         * edit here cannot start leaking one onto the page.
         */
        secrets: secrets.map((s) => ({
          name: s.name,
          source: s.source,
          last4: s.last4,
          updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
        })),
        provider: config["voice.transcriptionProvider"],
        fallbackToOpenai: config["voice.fallbackToOpenai"],
        sarvamModel: config["voice.transcriptionModel"],
        openaiTranscriptionModel: config["voice.openaiTranscriptionModel"],
        languageModel: config["voice.languageModel"],
        maxSeconds: config["voice.maxSeconds"],
        enabled: config["voice.enabled"],
        canWrite: isPlatformAdmin,
      }}
      crm={{
        values,
        config,
        warnings,
        canWrite: canConfigureCrm || (isPlatformAdmin && isManager(user)),
        collections,
      }}
    />
  );
}
