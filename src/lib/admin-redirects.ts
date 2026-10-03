/* ---------------------------------------------------------------------------
 * Where every Admin Console address that used to exist now lives.
 *
 * The console was one page that read its section and tab out of the path, so
 * an address like /admin/overview/jobs or /admin/order-sheet/issues was
 * written into notifications, into emails, into other apps' empty states and
 * into people's bookmarks. The sections are real routes now and several of
 * them moved; these keep every one of those links landing on the screen it
 * meant rather than on whatever happened to match.
 *
 * Permanent, because none of the old addresses is coming back. Read by
 * `next.config.ts`; `admin-routes.test.ts` checks every destination is a page.
 * Order matters — Next takes the first match, so the specific ones come first.
 * ------------------------------------------------------------------------- */

type Redirect = { source: string; destination: string; permanent: true };

const to = (source: string, destination: string): Redirect => ({ source, destination, permanent: true });

/** Every other app id that had a section of its own, and where its settings are now. */
const APP_SETTINGS: Record<string, string> = {
  sales: "/admin/settings/sales",
  field: "/admin/settings/sales",
  accounts: "/admin/settings/accounts",
  erp: "/admin/settings/erp",
  reports: "/admin/settings/reports",
  founder: "/admin/settings/reports",
  enquiries: "/admin",
  people: "/admin",
  admin: "/admin",
};

export const ADMIN_REDIRECTS: Redirect[] = [
  // Overview was eight tabs. Its first three are Home now; the rest have homes of their own.
  to("/admin/overview", "/admin"),
  to("/admin/overview/attention", "/admin"),
  to("/admin/overview/health", "/admin"),
  to("/admin/overview/usage", "/admin"),
  to("/admin/overview/integrations", "/admin/integrations"),
  to("/admin/overview/configuration", "/admin/settings"),
  to("/admin/overview/drift", "/admin/settings"),
  to("/admin/overview/jobs", "/admin/jobs"),
  to("/admin/overview/sessions", "/admin/sign-ins/now"),
  to("/admin/overview/onboarding", "/admin/sign-ins/never"),
  to("/admin/overview/:rest*", "/admin"),

  // People was one screen, Access.
  to("/admin/people/onboarding", "/admin/sign-ins/never"),
  to("/admin/people", "/admin/access"),
  to("/admin/people/:rest*", "/admin/access"),

  // Apps was the registry, drawn again on Home, and a schema inspector the
  // settings search replaces.
  to("/admin/apps", "/admin"),
  to("/admin/apps/schema", "/admin/settings"),
  to("/admin/apps/:rest*", "/admin"),

  // Data was the sync history and the migrations.
  to("/admin/data", "/admin/sheets/history"),
  to("/admin/data/migration", "/admin/database"),
  to("/admin/data/:rest*", "/admin/sheets/history"),

  to("/admin/notifications/:rest+", "/admin/notifications"),
  to("/admin/components/:rest+", "/admin/components"),

  // Every key is on one page.
  to("/admin/voice", "/admin/integrations"),
  to("/admin/voice/:rest*", "/admin/integrations"),
  to("/admin/maps", "/admin/integrations"),
  to("/admin/maps/:rest*", "/admin/integrations"),

  to("/admin/trash", "/admin/deleted-leads"),
  to("/admin/oversight", "/admin/settings/leads"),

  // The order sheet, under the name the Attention list used to get wrong too.
  to("/admin/order-sheet", "/admin/sheets"),
  to("/admin/order-sheet/:tab", "/admin/sheets/:tab"),
  to("/admin/sheet", "/admin/sheets"),
  to("/admin/sheet/:tab", "/admin/sheets/:tab"),

  // An app's settings were /admin/app-<id> or, where that was not a platform
  // key, /admin/<id>. Four of the CRM's tabs moved to the page that owns what
  // they decide, its "Scripts & help" is "Help articles", and its "Other" tab —
  // the 254 settings nobody had placed — is gone, spread across their own pages.
  ...["/admin/app-crm", "/admin/crm"].flatMap((base) => [
    to(`${base}/scripts`, "/admin/settings/crm/help"),
    to(`${base}/voice`, "/admin/settings/ai/dictation"),
    to(`${base}/workday`, "/admin/settings/platform/workday"),
    to(`${base}/attachments`, "/admin/settings/platform/attachments"),
    to(`${base}/pricing`, "/admin/settings/accounts/price-lists"),
    to(`${base}/other`, "/admin/settings"),
    to(base, "/admin/settings/crm"),
    to(`${base}/:tab`, "/admin/settings/crm/:tab"),
  ]),
  ...["/admin/app-hrms", "/admin/hrms"].flatMap((base) => [
    to(base, "/admin/settings/hrms"),
    to(`${base}/:tab`, "/admin/settings/hrms/:tab"),
  ]),
  // The apps that said "publishes no configuration schema" over a button into
  // a tab that no longer existed — while their settings sat under the CRM.
  ...Object.entries(APP_SETTINGS).flatMap(([id, dest]) => [
    to(`/admin/app-${id}`, dest),
    to(`/admin/app-${id}/:rest*`, dest),
    // A bare id was also accepted wherever it was not a platform section.
    ...(["people", "admin"].includes(id) ? [] : [to(`/admin/${id}`, dest), to(`/admin/${id}/:rest*`, dest)]),
  ]),
];
