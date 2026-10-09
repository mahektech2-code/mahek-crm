import { requireWebsiteModule } from "../require-module";

/** Route guard for the Website media module: `website.media`. */
export default async function WebsiteMediaLayout({ children }: { children: React.ReactNode }) {
  await requireWebsiteModule("media");
  return children;
}
