import { requireWebsiteWorkflow } from "../require-module";

/** Route guard for My work and a request's own page: somebody who works on the website or reviews it. */
export default async function WebsiteMyWorkLayout({ children }: { children: React.ReactNode }) {
  await requireWebsiteWorkflow();
  return children;
}
