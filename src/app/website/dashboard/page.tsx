import Link from "next/link";
import { Card, CardHeader, MetricStrip, PageHeader, Button, Badge } from "@/components/ui/primitives";
import { Icon } from "@/components/shell/icons";
import {
  INITIAL_PRODUCTS,
  INITIAL_INDUSTRIES,
  INITIAL_JOBS,
  INITIAL_GALLERY,
  INITIAL_TESTIMONIALS,
  INITIAL_PAGES,
  formatDateTime,
} from "../mock-data";

export default function WebsiteDashboardPage() {
  const products = INITIAL_PRODUCTS;
  const industries = INITIAL_INDUSTRIES;

  const metrics = [
    { label: "Published Products", value: String(products.filter((p) => p.status === "published").length), sub: `${products.length} total` },
    { label: "Draft Products", value: String(products.filter((p) => p.status === "draft").length) },
    { label: "Industries", value: String(industries.length), sub: `${industries.filter((i) => i.status === "published").length} published` },
    { label: "Open Careers", value: String(INITIAL_JOBS.filter((j) => j.status === "open").length), sub: `${INITIAL_JOBS.length} total postings` },
    { label: "Gallery Items", value: String(INITIAL_GALLERY.length), sub: `${INITIAL_GALLERY.filter((g) => g.status === "draft").length} draft` },
    { label: "Testimonials", value: String(INITIAL_TESTIMONIALS.length) },
    { label: "Pages", value: String(INITIAL_PAGES.length), sub: "all published" },
  ];

  const recentActivity: { who: string; what: string; when: string }[] = [
    { who: "Seema Kulkarni", what: "updated Industry “Cleaning Industry” (draft)", when: INITIAL_INDUSTRIES[3].updatedAt },
    { who: "Rahul Shah", what: "updated Product “Mahek Universal Thinner”", when: INITIAL_PRODUCTS[0].updatedAt },
    { who: "Vikram Doshi", what: "uploaded “dealer-meet-2026.jpg” to Gallery (draft)", when: INITIAL_GALLERY[3].updatedAt },
    { who: "Seema Kulkarni", what: "added testimonial from Deepak Jain (draft)", when: INITIAL_TESTIMONIALS[2].updatedAt },
  ].sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime());

  const contentNeedingAttention = [
    ...products.filter((p) => p.status === "draft").map((p) => ({ label: `Product: ${p.name}`, href: "/website/products" })),
    ...industries.filter((i) => i.status === "draft").map((i) => ({ label: `Industry: ${i.name}`, href: "/website/industries" })),
  ];

  return (
    <>
      <PageHeader
        title="Website Dashboard"
        subtitle="Website Admin controls content; CRM Enquiries handles enquiries."
      />

      <MetricStrip metrics={metrics} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card className="mb-4">
            <CardHeader title="Quick actions" />
            <div className="grid grid-cols-2 gap-2.5 p-5 sm:grid-cols-3">
              <QuickAction href="/website/products" icon="plus" label="Add Product" />
              <QuickAction href="/website/industries" icon="plus" label="Add Industry" />
              <QuickAction href="/website/careers" icon="plus" label="Add Job" />
              <QuickAction href="/website/gallery" icon="plus" label="Add Gallery Item" />
              <QuickAction href="/website/pages" icon="doc" label="Edit Pages" />
              <QuickAction href="/website/navigation" icon="menu" label="Manage Navigation" />
              <QuickAction href="/website/seo" icon="search" label="Manage SEO" />
              <QuickAction href="/website/settings" icon="settings" label="Website Settings" />
            </div>
          </Card>

          <Card>
            <CardHeader title="Recent publishing activity" hint="Mirrors MahekOne's audit log — see Website Activity on each module." />
            <div className="divide-y divide-divider">
              {recentActivity.map((a, i) => (
                <div key={i} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="text-[13.5px] text-body">
                    <span className="font-medium text-ink">{a.who}</span> {a.what}
                  </div>
                  <div className="flex-none text-[12px] whitespace-nowrap text-muted">{formatDateTime(a.when)}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div>
          <Card className="mb-4">
            <CardHeader
              title="Website Enquiries"
              action={
                <Link href="/enquiries">
                  <Button variant="secondary" size="sm">
                    Open
                  </Button>
                </Link>
              }
            />
            <div className="px-5 py-4 text-[13.5px] text-body">
              <p>
                Enquiries submitted on the public website already sync into the existing{" "}
                <Link href="/enquiries" className="font-medium text-brand hover:text-brand-hover">
                  Enquiries app
                </Link>
                . Website Admin does not duplicate that workflow — this is a link out, not a second inbox.
              </p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Content needing attention" hint="Drafts not yet published" />
            {contentNeedingAttention.length === 0 ? (
              <div className="px-5 py-6 text-center text-[13px] text-muted">Nothing in draft right now.</div>
            ) : (
              <div className="divide-y divide-divider">
                {contentNeedingAttention.map((c, i) => (
                  <Link
                    key={i}
                    href={c.href}
                    className="flex items-center justify-between gap-2 px-5 py-2.5 text-[13.5px] text-body hover:bg-canvas"
                  >
                    {c.label}
                    <Badge tone="muted">Draft</Badge>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function QuickAction({ href, icon, label }: { href: string; icon: string; label: string }) {
  return (
    <Link
      href={href}
      className="flex flex-col items-start gap-2 rounded-[4px] border border-line px-3.5 py-3 text-[13px] font-medium text-body hover:border-brand hover:bg-brand-soft hover:text-[#5223E0]"
    >
      <Icon name={icon} size={18} strokeWidth={1.6} />
      {label}
    </Link>
  );
}
