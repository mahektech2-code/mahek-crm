import Link from "next/link";
import { Badge, Callout, Card, CardHeader, MetricStrip, PageHeader } from "@/components/ui/primitives";
import { listUserModules } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { hasSecret } from "@/lib/secrets";
import { holdsReview } from "@/lib/website-cms/access";
import { KINDS, type KindKey, type ModuleSlug } from "@/lib/website-cms/kinds";
import { myWork, pendingReviewCount, scopeFor } from "@/lib/website-cms/review-queries";
import { slugVisible } from "@/lib/website-cms/review-scope";
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
  /* Every figure on this page is counted over what the person may SEE: where
     assignments are enforced an editor's dashboard is about their own work. */
  const scope = await scopeFor(user.id);
  const [mods, summary, chrome, readSet, publishSet, reviewer] = await Promise.all([
    listUserModules(user.id, "website"),
    dashboardSummary(scope),
    chromeFor(),
    hasSecret("website.cmsReadSecret"),
    hasSecret("website.cmsPublishSecret"),
    holdsReview(user.id),
  ]);
  const waitingForReview = reviewer ? await pendingReviewCount() : 0;
  const mine = chrome.canSubmit ? await myWork(user.id, scope) : null;
  const allowed = new Set(mods.map((m) => m.href));

  const liveTotal = summary.kinds.reduce((n, k) => n + k.live, 0);
  const metrics = [
    { label: "Live items", value: String(liveTotal) },
    { label: "Drafts", value: String(summary.kinds.reduce((n, k) => n + k.draft, 0)) },
    { label: "Unpublished changes", value: String(summary.kinds.reduce((n, k) => n + k.changes, 0)) },
    { label: "Archived", value: String(summary.kinds.reduce((n, k) => n + k.archived, 0)) },
    ...(summary.scoped && !scope.hasKind("media") ? [] : [{ label: "Uploaded images", value: String(summary.mediaUploads) }]),
  ];

  return (
    <div className="p-6">
      <CmsEnvProvider media={[]} siteUrl={chrome.siteUrl} products={[]}>
        <PageHeader
          title="Website"
          subtitle="What mahekindia.com shows. Edit here, preview on the real page, then publish."
          actions={chrome.canPublish ? <PublishPendingButton pending={summary.pending} /> : undefined}
        />
        {waitingForReview > 0 ? (
          <Callout tone="brand">
            <span className="text-sm text-ink">
              <span className="font-medium">{waitingForReview} {waitingForReview === 1 ? "request is" : "requests are"} waiting for your decision.</span>{" "}
              <Link href="/website/review">Open the review queue</Link>
            </span>
          </Callout>
        ) : null}
        {mine && mine.toPublish.length > 0 ? (
          <Callout tone="success">
            <span className="text-sm text-ink">
              <span className="font-medium">Verification Granted</span> — you can now publish {mine.toPublish.length === 1 ? "an approved change" : `${mine.toPublish.length} approved changes`}.{" "}
              <Link href="/website/my-work">Go to My work</Link>
            </span>
          </Callout>
        ) : null}
        {mine && mine.returned.length > 0 ? (
          <Callout tone="warn">
            <span className="text-sm text-ink">
              <span className="font-medium">{mine.returned.length} {mine.returned.length === 1 ? "request has" : "requests have"} come back to you.</span>{" "}
              <Link href="/website/my-work">See why</Link>
            </span>
          </Callout>
        ) : null}
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
            {MODULES.filter((m) => allowed.has(`/website/${m.slug}`) && slugVisible(scope, m.slug)).map((m) => {
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
