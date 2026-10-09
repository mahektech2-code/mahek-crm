import { requireWebsiteModule } from "../require-module";

/** Route guard for the Website settings module: `website.settings`. */
export default async function WebsiteSettingsLayout({ children }: { children: React.ReactNode }) {
  await requireWebsiteModule("settings");
  return children;
}
