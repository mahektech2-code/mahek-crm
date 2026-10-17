import { requireWebsiteModule } from "../require-module";

/** Route guard for the Website products module: `website.products`. */
export default async function WebsiteProductsLayout({ children }: { children: React.ReactNode }) {
  await requireWebsiteModule("products");
  return children;
}
