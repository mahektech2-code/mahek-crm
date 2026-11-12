import { requireWebsiteModule } from "../require-module";

/** Route guard for the Website's My tasks: `website.my-tasks`, always open to whoever holds the app. */
export default async function WebsiteMyTasksLayout({ children }: { children: React.ReactNode }) {
  await requireWebsiteModule("my-tasks");
  return children;
}
