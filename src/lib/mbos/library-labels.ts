/**
 * What the library and the training centre are made of — PURE, and client-safe.
 *
 * The categories live here rather than in the action for the same reason the
 * feedback vocabulary does: the form that offers them runs in the browser and
 * the action that writes them is `"use server"`, where every export has to be
 * an async function. A list written out in the screen instead would be the
 * product-list mistake one table over — a seventh category that the enum has
 * never heard of, refused at the save with nothing on the form saying why.
 *
 * A stored enum is not a label, so the sentences are here too.
 */

export const DOCUMENT_CATEGORIES = [
  "price_list",
  "catalogue",
  "policy",
  "agreement",
  "kyc",
  "marketing",
] as const;

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

const DOCUMENT_LABELS: Record<DocumentCategory, string> = {
  price_list: "Price list",
  catalogue: "Catalogue",
  policy: "Policy",
  agreement: "Agreement",
  kyc: "KYC",
  marketing: "Marketing",
};

export function documentCategoryLabel(category: string): string {
  return DOCUMENT_LABELS[category as DocumentCategory] ?? category.replace(/_/g, " ");
}

/**
 * What each is FOR, said in the form rather than left to be guessed at. An
 * agreement and a KYC file are both a customer's own paperwork and the
 * difference decides who can open it, so it is worth a sentence.
 */
export const DOCUMENT_CATEGORY_HELP: Record<DocumentCategory, string> = {
  price_list: "Rates the field quotes from.",
  catalogue: "What we sell, for showing a customer.",
  policy: "How the company does something — credit terms, returns, expenses.",
  agreement: "A signed agreement with one customer.",
  kyc: "A customer's own identity paperwork.",
  marketing: "A leaflet, a scheme sheet, a campaign.",
};
