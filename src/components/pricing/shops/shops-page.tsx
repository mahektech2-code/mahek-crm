import "server-only";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listOverrides } from "@/lib/services/price-book-service";
import { shopPricesView } from "@/lib/services/price-override-service";
import { PageHeader } from "@/components/ui/primitives";
import { PricingSubNav } from "@/components/pricing/sub-nav";
import { ShopPickScreen, ShopPricesScreen } from "./shop-prices-screen";

/**
 * "What a shop pays", the same in all three doors and read-only in every one
 * of them — changing a shop's prices is the Overrides tab and the books. The
 * shop is checked against the reader's own scope (`customerPricing` asserts
 * it), so a CRM user opens the shops in their book and nobody else's.
 */
export async function ShopsIndexPage({ basePath }: { basePath: string }) {
  await requireUser();
  const overrides = await listOverrides();
  const counts = new Map<string, { id: string; name: string; count: number }>();
  for (const o of overrides) {
    if (o.state !== "live" && o.state !== "scheduled") continue;
    const s = counts.get(o.customerId) ?? { id: o.customerId, name: o.customerName, count: 0 };
    s.count++;
    counts.set(o.customerId, s);
  }
  return (
    <>
      <PageHeader title="What a shop pays" subtitle="Product by product, and where each price comes from." />
      <PricingSubNav basePath={basePath} current="shops" />
      <ShopPickScreen basePath={basePath} withOverrides={[...counts.values()].sort((a, b) => a.name.localeCompare(b.name))} />
    </>
  );
}

export async function ShopPricesPage({ basePath, customerId }: { basePath: string; customerId: string }) {
  await requireUser();
  let view;
  try {
    view = await shopPricesView(customerId);
  } catch {
    // Out of the reader's scope answers exactly as a shop that does not exist.
    notFound();
  }
  if (!view) notFound();
  return (
    <>
      <PageHeader title="What a shop pays" subtitle="Product by product, and where each price comes from." />
      <PricingSubNav basePath={basePath} current="shops" />
      <ShopPricesScreen basePath={basePath} view={view} />
    </>
  );
}
