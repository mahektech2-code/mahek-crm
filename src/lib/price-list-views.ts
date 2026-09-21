/* ---------------------------------------------------------------------------
 * WHAT A PRICE LIST SCREEN IS HANDED — the view types, and nothing else.
 *
 * Pure and client-safe: the service that fills these is `server-only`, the
 * screens and modals that read them run in a browser, and both import from
 * here so a field cannot be renamed on one side without the other noticing.
 * Every money figure is paise, every date is an ISO string.
 * ------------------------------------------------------------------------- */

import type {
  PriceDeliveryBasis,
  PriceDerivation,
  PriceDiscountKind,
  PriceDocumentStatus,
  PriceFilenameHints,
  PriceFreightTerm,
  PriceListStatus,
  PriceMatchStatus,
  PriceParsedHeader,
  PriceScopeKind,
} from "@/db/schema";
import type { Resolution } from "@/lib/engines/price-resolution";

export type PriceListSummary = {
  id: string;
  refNo: string | null;
  name: string;
  version: number;
  status: PriceListStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  validityDays: number | null;
  /** effectiveFrom plus the validity, or the configured default. Null when open-ended by rule. */
  expiresOn: string | null;
  expired: boolean;
  taxBasis: "inclusive" | "exclusive";
  gstBp: number;
  deliveryBasis: PriceDeliveryBasis | null;
  freightTerm: PriceFreightTerm;
  unitBasis: "per_can" | "per_litre";
  parentListId: string | null;
  parentListName: string | null;
  derivation: PriceDerivation | null;
  supersedesId: string | null;
  supersededById: string | null;
  documentId: string | null;
  rateCount: number;
  scopeCount: number;
  /** "Odisha · Paid", "Everybody", "S M Distributors (customer)" — the scopes said in words. */
  scopeSummary: string;
  createdAt: string;
  publishedAt: string | null;
  updatedAt: string;
};

export type RateRow = {
  id: string;
  productId: string;
  productName: string;
  brandName: string | null;
  formulationName: string | null;
  millilitresPerCan: number | null;
  cansPerBox: number | null;
  packing: string | null;
  productActive: boolean;
  rateExGstPaise: number;
  rateInclGstPaise: number;
  perLitrePaise: number | null;
  minCans: number | null;
  maxCans: number | null;
  offered: boolean;
  rawProductText: string | null;
  rawPackText: string | null;
  rawPriceText: string | null;
  matchStatus: PriceMatchStatus;
  matchConfidence: number | null;
  updatedAt: string;
};

export type GridColumn = {
  key: string;
  label: string;
  millilitres: number | null;
  cansPerBox: number | null;
  packing: string | null;
};

export type RateGrid = {
  columns: GridColumn[];
  rows: Array<{
    family: string;
    familyKey: string;
    cells: Array<{ column: GridColumn; rate: RateRow | null }>;
  }>;
};

export type ScopeView = {
  id: string;
  scopeKind: PriceScopeKind;
  scopeValue: string;
  scopeLabel: string | null;
  parentKey: string;
  parentLabel: string | null;
  freightTermMatch: "any" | "to_pay" | "paid";
  priority: number;
  validFrom: string | null;
  validTo: string | null;
  /** How many customers this row names today. Approximate, computed by the service. */
  customersMatched: number;
};

export type DiscountTermView = {
  id: string;
  kind: PriceDiscountKind;
  percentBp: number;
  thresholdLitres: number | null;
  thresholdPaise: number | null;
  rawText: string | null;
  sentence: string;
};

export type DocumentView = {
  id: string;
  filename: string;
  sourceKind: "pdf_text" | "pdf_scan" | "image";
  byteSize: number | null;
  pageCount: number | null;
  parseStatus: PriceDocumentStatus;
  stageNote: string | null;
  stageStartedAt: string | null;
  confidence: number | null;
  layout: "grid" | "long" | "unknown" | null;
  header: PriceParsedHeader | null;
  problems: string[];
  filenameHints: PriceFilenameHints | null;
  attachmentId: string | null;
  priceListId: string | null;
  priceListName: string | null;
  uploadedByName: string | null;
  createdAt: string;
  parsedAt: string | null;
  publishedAt: string | null;
  rejectReason: string | null;
  rowCount: number;
  matchedCount: number;
  suggestedCount: number;
  heldCount: number;
  skippedCount: number;
};

export type ParseRowView = {
  id: string;
  page: number;
  rowIndex: number;
  colIndex: number;
  rawProductText: string;
  rawPackText: string | null;
  rawPriceText: string | null;
  millilitres: number | null;
  cansPerBox: number | null;
  container: string | null;
  rateInclGstPaise: number | null;
  rateExGstPaise: number | null;
  offered: boolean;
  matchedProductId: string | null;
  matchedProductName: string | null;
  matchStatus: PriceMatchStatus;
  matchConfidence: number | null;
  candidates: Array<{ productId: string; name: string; score: number }>;
  problem: string | null;
  decidedAt: string | null;
};

export type ParseGrid = {
  columns: Array<{ colIndex: number; label: string }>;
  rows: Array<{ rowIndex: number; rawProductText: string; cells: ParseRowView[] }>;
};

export type PriceListDetail = {
  list: PriceListSummary & {
    termsText: string | null;
    signatory: string | null;
    notes: string | null;
    freightPerLitrePaise: number | null;
    withdrawReason: string | null;
    publishedByName: string | null;
    createdByName: string | null;
  };
  rates: RateRow[];
  grid: RateGrid;
  scopes: ScopeView[];
  discountTerms: DiscountTermView[];
  document: DocumentView | null;
  versions: Array<{
    id: string;
    version: number;
    status: PriceListStatus;
    effectiveFrom: string;
    effectiveTo: string | null;
    name: string;
  }>;
  children: Array<{ id: string; name: string; status: PriceListStatus; derivation: PriceDerivation | null }>;
  parent: { id: string; name: string } | null;
};

export type CompareRow = {
  productId: string;
  productName: string;
  millilitresPerCan: number | null;
  cansPerBox: number | null;
  aEx: number | null;
  bEx: number | null;
  aIncl: number | null;
  bIncl: number | null;
  deltaPaise: number | null;
  deltaBp: number | null;
};

export type Comparison = {
  a: PriceListSummary;
  b: PriceListSummary;
  rows: CompareRow[];
  summary: {
    changed: number;
    up: number;
    down: number;
    onlyInA: number;
    onlyInB: number;
    medianDeltaBp: number | null;
  };
  inferredDerivation: PriceDerivation | null;
};

export type RequestView = {
  id: string;
  customerId: string;
  customerName: string;
  productId: string;
  productName: string;
  requestedRateExGstPaise: number;
  requestedRateInclGstPaise: number;
  currentRateExGstPaise: number | null;
  currentListId: string | null;
  currentListName: string | null;
  reason: string;
  status: "pending" | "approved" | "refused" | "withdrawn";
  requestedById: string;
  requestedByName: string;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  resultingListId: string | null;
};

export type CustomerPricing = {
  customer: {
    id: string;
    name: string;
    city: string;
    region: string | null;
    freightTerm: "to_pay" | "paid" | null;
    priceTag: string | null;
    salesmanName: string | null;
    kind: "lead" | "customer";
  };
  resolution: Resolution | null;
  list: PriceListSummary | null;
  rates: RateRow[];
  grid: RateGrid | null;
  discountTerms: DiscountTermView[];
  lastOrder: { listId: string | null; listName: string | null; orderedAt: string } | null;
  listChangedSinceLastOrder: boolean;
  pendingRequests: RequestView[];
};

export type CoverageReport = {
  customersConsidered: number;
  resolved: number;
  unresolved: number;
  noFreightTerm: number;
  /** Capped at 200. */
  unresolvedCustomers: Array<{
    id: string;
    name: string;
    city: string;
    region: string | null;
    freightTerm: string | null;
    salesmanName: string | null;
  }>;
  perList: Array<{ listId: string; name: string; status: PriceListStatus; customers: number }>;
  listsWithNobody: PriceListSummary[];
};

export type VarianceRow = {
  orderDate: string;
  orderNumber: string | null;
  customerId: string | null;
  customerName: string;
  productId: string | null;
  productName: string;
  cans: number | null;
  billedExPaise: number;
  listExPaise: number | null;
  listId: string | null;
  listName: string | null;
  deltaPaise: number | null;
  deltaBp: number | null;
  sheetDiscountBp: number | null;
};

export type VarianceReport = {
  month: string;
  rows: VarianceRow[];
  summary: {
    lines: number;
    onList: number;
    belowList: number;
    aboveList: number;
    unresolved: number;
    totalBelowPaise: number;
  };
};

export type PlaceOption = {
  key: string;
  label: string;
  parentKey: string;
  parentLabel: string | null;
  shops: number;
};

export type PricingOptions = {
  products: Array<{
    id: string;
    name: string;
    millilitresPerCan: number | null;
    cansPerBox: number | null;
    packing: string | null;
    brandName: string | null;
    formulationName: string | null;
    active: boolean;
  }>;
  places: { states: PlaceOption[]; districts: PlaceOption[]; cities: PlaceOption[]; areas: PlaceOption[] };
  beats: string[];
  salesmen: Array<{ id: string; name: string }>;
  customerTypes: string[];
  lists: Array<{ id: string; name: string; status: PriceListStatus; version: number; effectiveFrom: string }>;
};

export type PricingCounts = {
  published: number;
  drafts: number;
  documentsWaiting: number;
  requestsPending: number;
  unresolvedCustomers: number | null;
};

export type CustomerHit = {
  id: string;
  name: string;
  city: string;
  region: string | null;
  kind: "lead" | "customer";
};

/** Keyed by product id. */
export type CustomerRates = Record<
  string,
  {
    listId: string;
    listName: string;
    rateExGstPaise: number;
    rateInclGstPaise: number;
    gstBp: number;
    offered: boolean;
  }
>;

export type DiscountAuthorityInput = {
  level: "associate" | "manager" | "admin";
  associateMaxBp: number;
  managerMaxBp: number;
};
