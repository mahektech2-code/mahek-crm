import Link from "next/link";
import { Card, CardHeader, MetricStrip, PageHeader } from "@/components/ui/primitives";
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

export default function WebsiteDashboard() {
  return (
    <div className="p-6">
      <PageHeader
        title="Website"
        subtitle="What the public site shows — content, not the calling book. Mock data for now; publishing to the live site is a later PR."
      />
      <MetricStrip
        metrics={[
          { label: "Products", value: String(PRODUCTS.length) },
          { label: "Industries", value: String(INDUSTRIES.length) },
          { label: "Gallery items", value: String(GALLERY.length) },
          { label: "Media files", value: String(MEDIA.length) },
          { label: "Open roles", value: String(JOBS.filter((j) => j.status === "published").length) },
          { label: "Testimonials", value: String(TESTIMONIALS.length) },
          { label: "Milestones", value: String(MILESTONES.length) },
        ]}
      />
      <Card>
        <CardHeader title="Modules" hint="Every screen this grant opens." />
        <div className="grid grid-cols-2 gap-px bg-divider sm:grid-cols-3">
          {TILES.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="bg-surface px-5 py-4 text-sm font-medium text-body no-underline hover:bg-canvas hover:text-ink hover:no-underline"
            >
              {t.label}
            </Link>
          ))}
        </div>
      </Card>
    </div>
  );
}
