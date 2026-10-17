import { requireWebsiteModule } from "../require-module";

/** Route guard for the Website gallery module: `website.gallery`. */
export default async function WebsiteGalleryLayout({ children }: { children: React.ReactNode }) {
  await requireWebsiteModule("gallery");
  return children;
}
