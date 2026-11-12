// Test fixtures carried over from the standalone Studio: sample leads, products and a user. Tests only.
import type { Product } from "./domain/product";
import type { User } from "./domain/lead";
export const MOCK_PRODUCTS: readonly Product[] = [
  { id: "M1433", code: "M1433", name: "M1433 Thinner" },
  { id: "M2210", code: "M2210", name: "M2210 Epoxy Primer" },
  { id: "M3050", code: "M3050", name: "M3050 PU Topcoat" },
  { id: "M1810", code: "M1810", name: "M1810 Cleaning Solvent" },
  { id: "M2750", code: "M2750", name: "M2750 Wood Lacquer" },
];

export function mockProduct(code: string): Product {
  const found = MOCK_PRODUCTS.find((p) => p.code === code);
  if (!found) throw new Error(`Unknown mock product code: ${code}`);
  return found;
}
export const MOCK_USER: User = {
  id: "u-priya",
  name: "Priya Sharma",
  role: "Sales executive",
  initials: "PS",
};

const owner = { ownerId: MOCK_USER.id, ownerName: MOCK_USER.name };
export const MOCK_LEAD_RECORDS = [
  { id: "l1", contact: "Rajesh Shah", company: "ABC Industries", city: "Mumbai", state: "Maharashtra", product: mockProduct("M1433"), source: "Website enquiry", addedAt: "2026-10-07T08:30:00+05:30", ...owner },
  { id: "l2", contact: "Sunita Deshmukh", company: "Deshmukh Paint House", city: "Pune", state: "Maharashtra", product: mockProduct("M2210"), source: "IndiaMART", addedAt: "2026-10-07T07:30:00+05:30", ...owner },
  { id: "l3", contact: "Kiran Patel", company: "Patel Coatings Pvt. Ltd.", city: "Ahmedabad", state: "Gujarat", product: mockProduct("M1433"), source: "Referral", addedAt: "2026-10-07T04:10:00+05:30", ...owner },
  { id: "l4", contact: "Imran Qureshi", company: "Qureshi Hardware & Paints", city: "Hyderabad", state: "Telangana", product: mockProduct("M3050"), source: "Trade show", addedAt: "2026-10-06T16:00:00+05:30", ...owner },
  { id: "l5", contact: "Anita Nair", company: "Nair Industrial Supplies", city: "Kochi", state: "Kerala", product: mockProduct("M1810"), source: "Website enquiry", addedAt: "2026-10-06T11:00:00+05:30", ...owner },
  { id: "l6", contact: "Vikram Chauhan", company: "Chauhan Enterprises", city: "Jaipur", state: "Rajasthan", product: mockProduct("M2210"), source: "IndiaMART", addedAt: "2026-10-05T15:20:00+05:30", ...owner },
  { id: "l7", contact: "Meera Joshi", company: "Joshi Furniture Works", city: "Nashik", state: "Maharashtra", product: mockProduct("M2750"), source: "Referral", addedAt: "2026-10-05T10:05:00+05:30", ...owner },
  { id: "l8", contact: "Suresh Bhatt", company: "Bhatt & Sons Hardware", city: "Surat", state: "Gujarat", product: null, source: "Cold call", addedAt: "2026-10-04T17:45:00+05:30", ...owner },
  { id: "l9", contact: "Pooja Agarwal", company: "Maharashtra Industrial Coatings & Allied Products Pvt. Ltd.", city: "Nagpur", state: "Maharashtra", product: mockProduct("M1433"), source: "Website enquiry", addedAt: "2026-10-04T09:15:00+05:30", ...owner },
  { id: "l10", contact: "Harpreet Singh", company: "Singh Auto Finishes", city: "Ludhiana", state: "Punjab", product: mockProduct("M3050"), source: "Trade show", addedAt: "2026-10-03T14:30:00+05:30", ...owner },
] as const;
