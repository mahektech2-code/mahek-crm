import Link from "next/link";
import { Badge, Card, CardHeader, MetricStrip, PageHeader } from "@/components/ui/primitives";
import { listUserModules } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { hasSecret } from "@/lib/secrets";
import { KINDS, type KindKey, type ModuleSlug } from "@/lib/website-cms/kinds";
import { dashboardSummary } from "@/lib/website-cms/service";
import { CmsEnvProvider } from "./cms-ui/cms-env";
import { chromeFor } from "./cms-ui/chrome-cache";
import { ConnectionPanel, ImportPanel, PublishPendingButton } from "./cms-ui/dashboard-panels";
import { requireWebsiteModule } from "./require-module";

/**
 * The Website dashboard: what is stored, what is live, what is waiting, and
 * whether the live site is connected. Every number is read from the database —
 * nothing is a constant.
 */

const MODULES: { slug: ModuleSlug; label: string; kind?: KindKey }[] = [
  { slug: "products", label: "Products", kind: "product" },
  { slug: "industries", label: "Industries", kind: "industry" },
  { slug: "pages", label: "Pages", kind: "page" },
  { slug: "gallery", label: "Gallery", kind: "gallery" },
  { slug: "media", label: "Media" },
  { slug: "careers", label: "Careers", kind: "job" },
  { slug: "testimonials", label: "Testimonials", kind: "testimonial" },
  { slug: "milestones", label: "Milestones", kind: "milestone" },
  { slug: "navigation", label: "Navigation", kind: "navigation" },
  { slug: "seo", label: "SEO", kind: "seo" },
  { slug: "settings", label: "Settings", kind: "settings" },
];

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default async function WebsiteDashboard() {
  /* The app root is a module like any other (`website.dashboard`), and it cannot
     have a folder layout of its own to guard it, so the guard runs here — the
     same arrangement as the Enquiries overview. */
  await requireWebsiteModule("dashboard");

  const user = await requireUser();
  const [mods, summary, chrome, readSet, publishSet] = await Promise.all([
    listUserModules(user.id, "website"),
    dashboardSummary(),
    chromeFor(),
    hasSecret("website.cmsReadSecret"),
    hasSecret("website.cmsPublishSecret"),
  ]);
  const allowed = new Set(mods.map((m) => m.href));

  const liveTotal = summary.kinds.reduce((n, k) => n + k.live, 0);
  const metrics = [
    { label: "Live items", value: String(liveTotal) },
    { label: "Drafts", value: String(summary.kinds.reduce((n, k) => n + k.draft, 0)) },
    { label: "Unpublished changes", value: String(summary.kinds.reduce((n, k) => n + k.changes, 0)) },
    { label: "Archived", value: String(summary.kinds.reduce((n, k) => n + k.archived, 0)) },
    { label: "Uploaded images", value: String(summary.mediaUploads) },
  ];

  return (
    <div className="p-6">
      <CmsEnvProvider media={[]} siteUrl={chrome.siteUrl} products={[]}>
        <PageHeader
          title="Website"
          subtitle="What mahekindia.com shows. Edit here, preview on the real page, then publish."
          actions={chrome.canPublish ? <PublishPendingButton pending={summary.pending} /> : undefined}
        />
        <MetricStrip metrics={metrics} />

        <ConnectionPanel
          readSet={readSet}
          publishSet={publishSet}
          canPublish={chrome.canPublish}
          lastRefresh={summary.lastRefresh}
          refreshOutstanding={summary.refreshOutstanding}
          siteUrl={chrome.siteUrl}
        />

        {!summary.imported ? <ImportPanel canPublish={chrome.canPublish} /> : null}

        <Card className="mb-4">
          <CardHeader title="Modules" hint="Every screen this account may open." />
          <div className="grid grid-cols-1 gap-px bg-divider sm:grid-cols-2 lg:grid-cols-3">
            {MODULES.filter((m) => allowed.has(`/website/${m.slug}`)).map((m) => {
              const k = m.kind ? summary.kinds.find((x) => x.kind === m.kind) : undefined;
              const single = m.kind ? KINDS[m.kind].singleton : false;
              return (
                <Link
                  key={m.slug}
                  href={`/website/${m.slug}`}
                  className="flex flex-col gap-1 bg-surface px-5 py-4 text-sm no-underline hover:bg-canvas hover:no-underline"
                >
                  <span className="font-medium text-ink">{m.label}</span>
                  {m.slug === "media" ? (
                    <span className="text-xs text-muted">{summary.mediaUploads} uploaded · {summary.mediaSite} on the site</span>
                  ) : k ? (
                    <span className="text-xs text-muted">
                      {k.total === 0
                        ? "Nothing here yet"
                        : single
                          ? k.live
                            ? "Live"
                            : "Not live — the site uses its built-in version"
                          : `${k.live} live${k.draft ? ` · ${k.draft} draft` : ""}${k.archived ? ` · ${k.archived} archived` : ""}`}
                    </span>
                  ) : null}
                  {k && (k.changes > 0 || k.neverPublished > 0 || k.orderChanged) ? (
                    <span>
                      <Badge tone="warn">
                        {[
                          k.changes ? `${k.changes} unpublished change${k.changes === 1 ? "" : "s"}` : "",
                          k.neverPublished ? `${k.neverPublished} new draft${k.neverPublished === 1 ? "" : "s"}` : "",
                          k.orderChanged ? "order changed" : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </Badge>
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        </Card>

        <Card>
          <CardHeader title="Recent activity" hint="Publishes, takedowns, refreshes and imports. Saved drafts are not listed." />
          {summary.activity.length === 0 ? (
            <div className="px-5 py-4 text-sm text-muted">Nothing has been published yet.</div>
          ) : (
            <ul className="divide-y divide-divider text-sm">
              {summary.activity.map((a, i) => (
                <li key={`${a.at}-${i}`} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                  <span className="w-[120px] text-xs text-muted">{when(a.at)}</span>
                  <Badge tone={a.ok ? "neutral" : "danger"}>{a.action}</Badge>
                  <span className="min-w-0 flex-1 truncate text-body">{a.detail ?? a.label ?? ""}</span>
                  {!a.ok ? <span className="text-xs text-danger">did not succeed</span> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </CmsEnvProvider>
    </div>
  );
}
