/* ---------------------------------------------------------------------------
 * The ERP's screens, grouped the way its sidebar draws them.
 *
 * ONE LIST for three readers: the sidebar, the module guard (via
 * `lib/modules.ts`) and the Access screen. Each screen is its own module
 * because the source granted each screen separately — its `Permissions` list
 * named screens, not areas (spec §2.3) — and a module is exactly "a
 * destination that can be withheld".
 *
 * A screen appears in `lib/modules.ts` only once it is `built`. Registering a
 * module for a screen that does not exist yet would put a door on the access
 * screen that opens onto nothing, and a grant nobody can use reads as a bug.
 *
 * PURE and client-safe: the shell is a client component and must draw the
 * same list the server enforces.
 * ------------------------------------------------------------------------- */

export type ErpIcon =
  | "home" | "bell" | "db" | "cart" | "flask" | "beaker" | "can" | "box"
  | "swap" | "refresh" | "receipt" | "file" | "truck" | "chat" | "phone"
  | "wallet" | "people" | "play" | "gear";

/**
 * A TAB of a screen. Mahek Plus drew a separate view for every filter of one
 * table — Pending LR, Track LR and All transport are one list three ways — and
 * the first build of the ERP copied that into one sidebar entry, one module
 * and one grant each. A view is that list again, reached from its screen
 * rather than from the sidebar: it keeps its own server module (its rows, its
 * actions) under its own key, and it is opened by holding the SCREEN. It is
 * never a module of its own, so it can never be granted apart from its screen.
 */
export type ErpView = {
  /** The server module key that draws this tab. */
  key: string;
  label: string;
  /**
   * A second list the tab switches to without a tab of its own — the full
   * entry log behind an "available stock" tab. Drawn as a toggle.
   */
  alt?: { key: string; label: string; back: string };
};

export type ErpScreen = {
  /** Stable key; the module key is `erp.<key>`. Never renamed — it is a grant. */
  key: string;
  /** URL segment under /erp. The dashboard is the app root. */
  slug: string;
  label: string;
  /** The sentence under the title, from the design. */
  sub: string;
  built: boolean;
  /** Tabs, the first being what the screen opens on. Absent: the screen is one list, its own key. */
  views?: ErpView[];
};

export type ErpGroup = {
  id: string;
  label: string;
  icon: ErpIcon;
  screens: ErpScreen[];
};

const s = (key: string, slug: string, label: string, sub: string, built = false, views?: ErpView[]): ErpScreen => ({
  key,
  slug,
  label,
  sub,
  built,
  ...(views ? { views } : {}),
});

const v = (key: string, label: string, alt?: ErpView["alt"]): ErpView => ({ key, label, ...(alt ? { alt } : {}) });

export const ERP_GROUPS: ErpGroup[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: "home",
    screens: [s("dashboard", "", "Dashboard", "What needs attention now, and the state of stock.", true)],
  },
  {
    id: "alerts",
    label: "Alerts",
    icon: "bell",
    screens: [
      s("alerts", "alerts", "Alerts", "Unusual activity, with the records and figures behind each alert.", true),
    ],
  },
  {
    id: "masters",
    label: "Masters",
    icon: "db",
    screens: [
      s("rawMaterials", "raw-materials", "Raw materials", "Everything the business buys, with density and required tests for chemicals, and photos for cans.", true, [
        v("rawMaterials", "All materials"),
        v("canGroups", "Can groups"),
      ]),
      s("suppliers", "suppliers", "Purchase parties", "Suppliers, grouped by state.", true),
      s("products", "products", "Products", "Finished goods: what each is made of and how it is packed.", true),
      s("customers", "customers", "Sales parties", "Customers. A Pending party must be activated before its orders move.", true),
      s("godowns", "godowns", "Godowns", "Godowns by region.", true),
      s("refLists", "reference-lists", "Reference lists", "The value lists every form picks from.", true),
    ],
  },
  {
    id: "purchase",
    label: "Purchase",
    icon: "cart",
    screens: [
      s("requisitions", "requisitions", "Requirements", "What each department needs bought, through to vendor, PO and goods.", true, [
        v("requisitions", "Requirements"),
        v("quotations", "Quotations"),
      ]),
      s("purchaseOrders", "purchase-orders", "Purchase orders", "Raised from requirements, approved, sent and received against.", true),
      s("register", "register", "Purchases", "Goods received against a PO, and the lots they become.", true, [
        v("inward", "Goods receipt (GRN)"),
        v("register", "Register"),
        v("barcode", "Drum labels"),
      ]),
      s("testing", "testing", "Lot testing", "Test evidence for each chemical lot, for the verifier to verify.", true),
      s("quoteManager", "quotation-manager", "Quotation manager", "Supplier rates by date, party and material, kept like the desk's sheet: every row, column and cell editable.", true),
    ],
  },
  {
    id: "production",
    label: "Production",
    icon: "beaker",
    screens: [
      s("sfgBatches", "sfg-batches", "SFG batches", "Liquid made from raw-material lots.", true),
      s("fgFill", "fg-fill", "FG filling", "SFG filled into cans or drums.", true),
      s("packBatches", "pack-batches", "Packing batches", "Loose cans packed into boxes.", true),
      s("recipes", "recipes", "Recipes", "What one batch of each SFG product takes, in litres.", true),
    ],
  },
  {
    id: "stock",
    label: "Stock",
    icon: "flask",
    screens: [
      s("stock", "stock", "Stock on hand", "What is in each godown, lot by lot, at every stage.", true, [
        v("rmStock", "Raw material", { key: "rmLog", label: "Show every entry", back: "Show available stock" }),
        v("sfgStock", "Semi-finished", { key: "sfgLog", label: "Show every entry", back: "Show available stock" }),
        v("fgStock", "Finished goods", { key: "fgLog", label: "Show every entry", back: "Show available stock" }),
        v("packStock", "Packed", { key: "packLog", label: "Show every entry", back: "Show available stock" }),
      ]),
      s("stockCheck", "stock-check", "Stock accuracy", "Blind counts, floor checks, red flags and approved adjustments.", true, [
        v("countTasks", "To count"),
        v("floorChecks", "Stock checks"),
        v("stockFlags", "Red flags"),
        v("stockAdjustments", "Adjustments"),
        v("missingRecords", "Missing records"),
        v("stockCounts", "Every count"),
      ]),
      s("units", "boxes", "Boxes & labels", "Every labelled box and loose can: where it is and its label.", true, [
        v("units", "In stock & at dispatch"),
        v("allUnits", "Every box"),
      ]),
      s("transfers", "transfers", "Item transfers", "Stock moved between godowns, including write-offs.", true),
      s("rmLevels", "rm-levels", "Raw-material levels", "Minimum and maximum per godown, and what is below it.", true, [
        v("reorderRm", "Below minimum"),
        v("rmLevels", "All levels"),
      ]),
      s("fgLevels", "fg-levels", "Finished-goods levels", "Minimum per SKU, and what is below it.", true, [
        v("reorderFg", "Below minimum"),
        v("fgLevels", "All levels"),
      ]),
    ],
  },
  {
    id: "sales",
    label: "Sales",
    icon: "receipt",
    screens: [
      s("orders", "orders", "Orders", "From the order to the bill leaving the godown, one step per tab.", true, [
        v("pendingOrders", "Pending"),
        v("readyOrders", "Under process & ready"),
        v("orderDetails", "Billing & dispatch"),
        v("batchCodes", "Batch codes"),
        v("labels", "Labels"),
        v("orders", "All lines"),
        v("orderInbox", "WhatsApp inbox"),
      ]),
      s("dispatch", "dispatch", "Dispatch desk", "Pick an order and scan every box onto it before the lorry leaves.", true),
    ],
  },
  {
    id: "trace",
    label: "Traceability",
    icon: "refresh",
    screens: [
      s("trace", "trace", "Traceability", "Where any box, lot, batch, order or bill came from and went.", true),
    ],
  },
  {
    id: "logistics",
    label: "Logistics",
    icon: "truck",
    screens: [
      /* The key and slug stay `transport` so every grant and bookmark holds;
         the screen is the whole logistics flow now (src/app/erp/transport). */
      s("transport", "transport", "Logistics", "From the factory gate to the party's door.", true, [
        v("transport", "Today"),
        v("toTransport", "To transporter"),
        v("pendingLr", "LR desk"),
        v("trackLr", "On the road"),
        v("delivered", "Delivered"),
        v("lrMessages", "Customer messages"),
        v("transporters", "Transporters"),
        v("allBills", "All bills"),
        v("paidFreight", "Paid freight"),
      ]),
    ],
  },
  {
    id: "requests",
    label: "Complaints & credit notes",
    icon: "chat",
    screens: [
      s("requests", "requests", "Complaints & credit notes", "Customer complaints and credit notes, shared with the CRM.", true, [
        v("requests", "All complaints"),
        v("issueCn", "Credit notes"),
        v("complaints", "Without a credit note"),
      ]),
    ],
  },
  {
    id: "returns",
    label: "Material returns",
    icon: "swap",
    screens: [
      s("vendorReturns", "vendor-returns", "Vendor returns", "Material sent back to a supplier, its debit note and the outward.", true, [
        v("vendorReturns", "Purchase returns"),
        v("debitNotes", "Debit notes"),
        v("returnOutwards", "Return outward"),
      ]),
      s("customerReturns", "customer-returns", "Customer returns", "Material a customer sends back, held in quarantine until QC decides.", true, [
        v("customerReturns", "Returns"),
        v("returnQc", "Quarantine & QC"),
        v("reworkOrders", "Rework"),
        v("wasteDisposals", "Waste disposal"),
      ]),
    ],
  },
  {
    id: "scrap",
    label: "Empty drums & scrap",
    icon: "can",
    screens: [
      s("emptyDrums", "empty-drums", "Empty drums", "Every emptied drum, weighed and linked to its GRN.", true, [
        v("emptyDrums", "Mahek stock"),
        v("drumReturnable", "Vendor returnable"),
        v("drumReview", "Needs review"),
        v("drumVariance", "Tare variance"),
        v("drumAdjustments", "Corrections"),
        v("drumRegister", "All drums"),
      ]),
      s("drumReturns", "drum-returns", "Returnable drum outward", "Supplier-owned drums sent back, oldest first.", true, [
        v("drumReturns", "Outwards"),
        v("drumPending", "Pending by supplier"),
      ]),
      s("scrapSales", "scrap-sales", "Scrap sales", "Drums and other scrap sold, and what each buyer still owes.", true, [
        v("scrapSales", "Sales"),
        v("scrapReceivables", "Receivables & ageing"),
        v("scrapStock", "Scrap stock", { key: "scrapEntries", label: "Entries", back: "On hand" }),
        v("scrapBuyers", "Scrap buyers"),
      ]),
    ],
  },
  {
    id: "expenses",
    label: "Petty Cash/Bank",
    icon: "wallet",
    screens: [
      s("expenses", "expenses", "Petty Cash/Bank", "Funds given, what was spent, and money received.", true, [
        v("expenses", "Expenses"),
        v("credits", "Funds given"),
        v("cashReceipts", "Receipts"),
      ]),
    ],
  },
  {
    id: "help",
    label: "Help videos",
    icon: "play",
    screens: [s("videos", "videos", "Help videos", "Short walkthroughs, newest first.", true)],
  },
  {
    id: "settings",
    label: "Settings",
    icon: "gear",
    screens: [s("settings", "settings", "Settings", "Your working location and what your account can do.", true)],
  },
];

export const ERP_SCREENS: ErpScreen[] = ERP_GROUPS.flatMap((g) => g.screens);

/** The screen a module key is drawn on — its own, or the one it is a tab of. */
export function erpScreen(key: string): ErpScreen | undefined {
  return erpPlace(key)?.screen;
}

export function erpScreenBySlug(slug: string): ErpScreen | undefined {
  return ERP_SCREENS.find((x) => x.slug === slug);
}

export function erpHref(screen: ErpScreen): string {
  return screen.slug ? `/erp/${screen.slug}` : "/erp";
}

/**
 * Where a module key is drawn: a screen of its own, or a tab (or a tab's
 * toggle) of one. Every link to a list goes through this, so a dashboard tile
 * or an alert naming `pendingLr` lands on the Transport screen's Pending LR
 * tab rather than on a page that no longer exists.
 */
export function erpPlace(key: string): { screen: ErpScreen; view: string | null } | undefined {
  const own = ERP_SCREENS.find((x) => x.key === key);
  if (own) return { screen: own, view: own.views?.some((x) => x.key === key) && own.views[0].key !== key ? key : null };
  for (const screen of ERP_SCREENS)
    for (const view of screen.views ?? [])
      if (view.key === key || view.alt?.key === key) return { screen, view: key === screen.views![0].key ? null : key };
  return undefined;
}

/** A link to a list by its module key, with any query it should open with. */
export function erpLink(key: string, query: Record<string, string | null | undefined> = {}): string {
  const place = erpPlace(key);
  if (!place) return "/erp";
  const q = new URLSearchParams();
  if (place.view) q.set("view", place.view);
  for (const [k, val] of Object.entries(query)) if (val) q.set(k, val);
  const qs = q.toString();
  return qs ? `${erpHref(place.screen)}?${qs}` : erpHref(place.screen);
}

/** The label a list goes by, whether it is a screen or a tab of one. */
export function erpListLabel(key: string): string {
  const place = erpPlace(key);
  if (!place) return key;
  if (!place.view) return place.screen.label;
  const view = place.screen.views?.find((x) => x.key === place.view || x.alt?.key === place.view);
  return view ? `${place.screen.label} · ${view.label}` : place.screen.label;
}

/** Every module key a screen's holder may use: its own and its tabs'. */
export function erpKeysOf(screen: ErpScreen): string[] {
  /* A screen's own key is usually one of its tabs too (Transport's "All
     bills" is `transport`); listed twice, a badge would count it twice. */
  return [...new Set([screen.key, ...(screen.views ?? []).flatMap((x) => [x.key, ...(x.alt ? [x.alt.key] : [])])])];
}

export function erpGroupOf(key: string): ErpGroup | undefined {
  return ERP_GROUPS.find((g) => g.screens.some((x) => x.key === key));
}

/**
 * The screens every ERP user reaches whatever they were narrowed to: the
 * dashboard (it only shows tiles for screens they hold) and their own
 * settings. Withholding either would leave somebody an app with no front door.
 */
export const ERP_ALWAYS_OPEN = new Set(["dashboard", "settings"]);
