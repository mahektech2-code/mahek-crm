import { requireWebsiteModule } from "../require-module";

/** Route guard for the Website testimonials module: `website.testimonials`. */
export default async function WebsiteTestimonialsLayout({ children }: { children: React.ReactNode }) {
  await requireWebsiteModule("testimonials");
  return children;
}
