import Link from "next/link";
import { Card, CardHeader, MetricStrip, PageHeader } from "@/components/ui/primitives";
import { requireUser } from "@/lib/auth";
import { listUserModules } from "@/lib/access";
import { requireWebsiteModule } from "./require-module";
import {
  GALLERY,
  INDUSTRIES,
  JOBS,
  MEDIA,
  MILESTONES,
  PRODUCTS,
  TESTIMONIALS,
} from "./mock-data";

const TILES = [
  { href: "/website/products", label: "Products" },
  { href: "/website/industries", label: "Industries" },
  { href: "/website/pages", label: "Pages" },
  { href: "/website/gallery", label: "Gallery" },
  { href: "/website/media", label: "Media" },
  { href: "/website/careers", label: "Careers" },
  { href: "/website/testimonials", label: "Testimonials" },
  { href: "/website/milestones", label: "Milestones" },
  { href: "/website/navigation", label: "Navigation" },
  { href: "/website/seo", label: "SEO" },
  { href: "/website/settings", label: "Settings" },
];

export default async function WebsiteDashboard() {
  /* The app root is a module like any other (`website.dashboard`), and it
     cannot have a folder layout of its own to guard it, so the guard runs
     here — the same arrangement as the Enquiries overview. */
  await requireWebsiteModule("dashboard");

  /* A tile for a screen this person may not open would only lead them to a
     redirect, and a count is itself a reading of that screen. Both are drawn
     from the same grant the route guards check. */
  const user = await requireUser();
  const allowed = new Set((await listUserModules(user.id, "website")).map((m) => m.href));

  const metrics = [
    { href: "/website/products", label: "Products", value: String(PRODUCTS.length) },
    { href: "/website/industries", label: "Industries", value: String(INDUSTRIES.length) },
    { href: "/website/gallery", label: "Gallery items", value: String(GALLERY.length) },
    { href: "/website/media", label: "Media files", value: String(MEDIA.length) },
    { href: "/website/careers", label: "Open roles", value: String(JOBS.filter((j) => j.status === "published").length) },
    { href: "/website/testimonials", label: "Testimonials", value: String(TESTIMONIALS.length) },
    { href: "/website/milestones", label: "Milestones", value: String(MILESTONES.length) },
  ]
    .filter((m) => allowed.has(m.href))
    .map(({ label, value }) => ({ label, value }));
  const tiles = TILES.filter((t) => allowed.has(t.href));

  return (
    <div className="p-6">
      <PageHeader
        title="Website"
        subtitle="What the public site shows — content, not the calling book. Mock data for now; publishing to the live site is a later PR."
      />
      {metrics.length > 0 ? <MetricStrip metrics={metrics} /> : null}
      <Card>
        <CardHeader title="Modules" hint="Every screen this grant opens." />
        {tiles.length === 0 ? (
          <div className="px-5 py-4 text-sm text-muted">No other screens are open to this account.</div>
        ) : (
          <div className="grid grid-cols-2 gap-px bg-divider sm:grid-cols-3">
            {tiles.map((t) => (
              <Link
                key={t.href}
                href={t.href}
                className="bg-surface px-5 py-4 text-sm font-medium text-body no-underline hover:bg-canvas hover:text-ink hover:no-underline"
              >
                {t.label}
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
