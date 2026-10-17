import { requireUser } from "@/lib/auth";
import { reviewByItem, scopeFor, visibleItems } from "@/lib/website-cms/review-queries";
import { orderChangedKinds } from "@/lib/website-cms/service";
import { CmsEnvProvider } from "./cms-env";
import { ContentScreen } from "./content-screen";
import { chromeFor } from "./chrome-cache";
import type { ListKind } from "./field-defs";

/**
 * The server half of every list-style Website screen: read the rows, ask what
 * this person may do, hand both to the client screen. The module guard is the
 * folder's own layout (`require-module.ts`); this only draws.
 *
 * What it reads is narrowed to what the person may SEE: where assignments are
 * enforced, an editor gets their own items only — no other name, draft or count —
 * and the controls that need a whole-kind assignment (add, reorder) are drawn only
 * if they have one.
 */
export async function ListModulePage({ kind }: { kind: ListKind }) {
  const user = await requireUser();
  const scope = await scopeFor(user.id);
  const [items, orderChanged, chrome] = await Promise.all([visibleItems(kind, scope), orderChangedKinds([kind]), chromeFor()]);
  const review = await reviewByItem(user.id, items.map((i) => i.id));
  return (
    <CmsEnvProvider media={chrome.media} siteUrl={chrome.siteUrl} products={chrome.products}>
      <ContentScreen
        kind={kind}
        items={items}
        canPublish={chrome.canPublish}
        canSubmit={chrome.canSubmit}
        canCreate={scope.kindWide(kind)}
        canMove={scope.kindWide(kind)}
        review={review}
        orderChanged={orderChanged.includes(kind) && scope.kindWide(kind)}
      />
    </CmsEnvProvider>
  );
}
