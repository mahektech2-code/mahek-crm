import { listItems, orderChangedKinds } from "@/lib/website-cms/service";
import { CmsEnvProvider } from "./cms-env";
import { ContentScreen } from "./content-screen";
import { chromeFor } from "./chrome-cache";
import type { ListKind } from "./field-defs";

/**
 * The server half of every list-style Website screen: read the rows, ask what
 * this person may do, hand both to the client screen. The module guard is the
 * folder's own layout (`require-module.ts`); this only draws.
 */
export async function ListModulePage({ kind }: { kind: ListKind }) {
  const [items, orderChanged, chrome] = await Promise.all([listItems(kind), orderChangedKinds([kind]), chromeFor()]);
  return (
    <CmsEnvProvider media={chrome.media} siteUrl={chrome.siteUrl} products={chrome.products}>
      <ContentScreen kind={kind} items={items} canPublish={chrome.canPublish} orderChanged={orderChanged.includes(kind)} />
    </CmsEnvProvider>
  );
}
