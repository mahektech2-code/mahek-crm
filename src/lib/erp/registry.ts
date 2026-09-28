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
      s("alerts", "alerts", "Alerts", "Unusual activity the ERP noticed overnight and through the day. Each alert names the records and the figures behind it.", true),
    ],
  },
  {
    id: "masters",
    label: "Masters",
    icon: "db",
    screens: [
      s("rawMaterials", "raw-materials", "Raw materials", "Every material the business buys. Chemicals carry a density and the tests each lot must pass.", true),
      s("suppliers", "suppliers", "Purchase parties", "Suppliers, grouped by state. Call is the quick action.", true),
      s("products", "products", "Products", "From liquid to boxed SKU: what each finished good is made of and how it is packed.", true),
      s("customers", "customers", "Sales parties", "Customers. A Pending party needs admin activation before its orders can move.", true),
      s("myCustomers", "my-customers", "My customers", "Your own customers and what they have raised.", true),
      s("godowns", "godowns", "Godowns", "Every godown by region, plus the reserved Item Lost Record godown that only write-offs use.", true),
      s("priceLists", "price-lists", "Price lists", "Rates by list, as published on the Price Desk. Rate excluding GST is calculated.", true),
      s("refLists", "reference-lists", "Reference lists", "The editable value lists every form picks from.", true),
    ],
  },
  {
    id: "purchase",
    label: "Purchase",
    icon: "cart",
    screens: [
      s("requisitions", "requisitions", "Purchase requisitions", "What the godowns need bought. Status changes directly on the record.", true),
      s("inward", "inward", "Purchase inward", "Goods arriving against a PR. Each line goes once to testing or straight to the purchase register.", true),
      s("testing", "testing", "Purchase testing", "Evidence for the tests each chemical requires. Only the verifier can verify.", true),
      s("register", "register", "Purchase register", "Every verified or direct purchase with its rate, GST and bill. Stock posts only once a rate is entered.", true),
      s("barcode", "barcode", "Purchase barcode", "Chemical lots at your working godown, ready for drum labels.", true),
    ],
  },
  {
    id: "production",
    label: "Production",
    icon: "beaker",
    screens: [
      s("sfgBatches", "sfg-batches", "SFG batches", "Liquid made from raw-material lots. One line per lot consumed.", true),
      s("fgFill", "fg-fill", "FG filling", "SFG filled into cans or drums.", true),
      s("packBatches", "pack-batches", "Packing batches", "Loose cans packed into boxes. A batch posts only when the cans used match the boxes.", true),
    ],
  },
  {
    id: "stock",
    label: "Stock",
    icon: "flask",
    screens: [
      s("stock", "stock", "Stock", "What is in each godown, lot by lot, at every stage. Every entry behind it is one switch away.", true, [
        v("rmStock", "Raw material", { key: "rmLog", label: "Show every entry", back: "Show available stock" }),
        v("sfgStock", "Semi-finished", { key: "sfgLog", label: "Show every entry", back: "Show available stock" }),
        v("fgStock", "Finished goods", { key: "fgLog", label: "Show every entry", back: "Show available stock" }),
        v("packStock", "Packed", { key: "packLog", label: "Show every entry", back: "Show available stock" }),
      ]),
      s("transfers", "transfers", "Item transfers", "Stock moved between godowns, including write-offs to Item Lost Record.", true),
      s("rmLevels", "rm-levels", "Raw-material levels", "Minimum and maximum per godown. Raise a requisition from any item below its minimum.", true, [
        v("reorderRm", "Below minimum"),
        v("rmLevels", "All levels"),
      ]),
      s("fgLevels", "fg-levels", "Finished-goods levels", "Minimum per SKU. Loose SKUs read FG stock, boxed SKUs read packing stock.", true, [
        v("reorderFg", "Below minimum"),
        v("fgLevels", "All levels"),
      ]),
    ],
  },
  {
    id: "sales",
    label: "Sales orders",
    icon: "receipt",
    screens: [
      s("orderInbox", "order-inbox", "Order inbox", "WhatsApp messages the ERP read as possible orders. Nothing becomes an order until someone accepts the draft.", true),
      s("orders", "orders", "Taken orders", "Every sales-order line, grouped by order number.", true),
      s("pendingOrders", "pending-orders", "Pending orders", "Open order lines that have not reached order details.", true),
      s("readyOrders", "ready-orders", "Under process and ready", "The godown's working list. Mark many lines Ready at once.", true),
      s("batchCodes", "batch-codes", "Batch codes", "Every lot allocated to an order line, grouped by godown.", true),
      s("labels", "labels", "Sales label printing", "Open orders by transporter, with labels to print.", true),
    ],
  },
  {
    id: "details",
    label: "Order details",
    icon: "file",
    screens: [s("orderDetails", "order-details", "Order details", "Billing and dispatch. Verify a line once it has left, with its dispatch date.", true)],
  },
  {
    id: "logistics",
    label: "Logistics",
    icon: "truck",
    screens: [
      s("transport", "transport", "Transport", "Every dispatched bill, its LR and where the consignment is.", true, [
        v("pendingLr", "Pending LR"),
        v("trackLr", "On the road"),
        v("transport", "All bills"),
        v("paidFreight", "Paid freight"),
      ]),
    ],
  },
  {
    id: "requests",
    label: "Complaints & credit notes",
    icon: "chat",
    screens: [
      s("requests", "requests", "Complaints & credit notes", "The customer's complaints and the credit notes they ask for — the same records the CRM keeps, whichever app raised them.", true, [
        v("requests", "All"),
        v("issueCn", "Credit notes"),
        v("complaints", "Without a credit note"),
      ]),
    ],
  },
  {
    id: "followup",
    label: "Order follow-up",
    icon: "phone",
    screens: [
      s("followup", "followup", "Order follow-up", "When each customer is likely to order again, and when to call them.", true),
      s("pivot", "pivot", "Party order pivot", "Per party: last order and the gap since.", true),
    ],
  },
  {
    id: "expenses",
    label: "Petty cash",
    icon: "wallet",
    screens: [
      s("expenses", "expenses", "Petty cash", "Funds given to people and what they spent, per godown and mode, with what is left.", true, [
        v("expenses", "Expenses"),
        v("credits", "Funds given"),
      ]),
    ],
  },
  {
    id: "help",
    label: "Help videos",
    icon: "play",
    screens: [s("videos", "videos", "Help videos", "Short walkthroughs, newest first. Search by title or tag.", true)],
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
