import "server-only";
import type { SectionProvider } from "./provider";
import type { SectionKey } from "./types";

/* One provider per section. Company and Needs you have their own readers. */
type Loader = () => Promise<{ provider: SectionProvider }>;

const LOADERS: Partial<Record<SectionKey, Loader>> = {
  sales: () => import("./sections/sales"),
  team: () => import("./sections/team"),
  customers: () => import("./sections/customers"),
  leads: () => import("./sections/leads"),
  enquiries: () => import("./sections/enquiries"),
  calling: () => import("./sections/calling"),
  field: () => import("./sections/field"),
  service: () => import("./sections/service"),
  money: () => import("./sections/money"),
  prices: () => import("./sections/prices"),
  whatsapp: () => import("./sections/whatsapp"),
  people: () => import("./sections/people"),
  system: () => import("./sections/system"),
};

export async function providerFor(section: SectionKey): Promise<SectionProvider> {
  const load = LOADERS[section];
  if (!load) throw new Error(`No section called ${section}.`);
  return (await load()).provider;
}
