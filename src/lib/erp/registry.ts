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

export type ErpScreen = {
  /** Stable key; the module key is `erp.<key>`. Never renamed — it is a grant. */
  key: string;
  /** URL segment under /erp. The dashboard is the app root. */
  slug: string;
  label: string;
  /** The sentence under the title, from the design. */
  sub: string;
  built: boolean;
};

export type ErpGroup = {
  id: string;
  label: string;
  icon: ErpIcon;
  screens: ErpScreen[];
};

const s = (key: string, slug: string, label: string, sub: string, built = false): ErpScreen => ({
  key,
  slug,
  label,
  sub,
  built,
});

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
      s("alerts", "alerts", "Alerts", "Unusual activity the ERP noticed overnight and through the day. Each alert names the records and the figures behind it."),
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
      s("godowns", "godowns", "Godowns", "Every godown by region, plus the reserved Item Lost Record godown that only write-offs use.", true),
      s("priceLists", "price-lists", "Price lists", "Rates by list. Rate excluding GST is calculated.", true),
      s("employees", "employees", "Employees", "Directory. Legacy permission values are shown read-only; ERP access is managed in the Admin Console.", true),
      s("powers", "powers", "ERP powers", "Who may see money and cost, verify tests, write off stock and decide requests. An ERP administrator holds every power.", true),
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
    id: "rm",
    label: "Raw-material inventory",
    icon: "flask",
    screens: [
      s("rmStock", "rm-stock", "Available raw-material stock", "One row per lot and godown with stock above zero.", true),
      s("rmLog", "rm-log", "Inventory log", "Every raw-material entry, newest first. Entries are written by purchases and transfers only.", true),
    ],
  },
  {
    id: "sfg",
    label: "Semi-finished",
    icon: "beaker",
    screens: [
      s("sfgBatches", "sfg-batches", "SFG batches", "Liquid made from raw-material lots. One line per lot consumed.", true),
      s("sfgStock", "sfg-stock", "Available SFG stock", "Semi-finished lots with litres remaining.", true),
      s("sfgLog", "sfg-log", "SFG log", "Every semi-finished entry, newest first.", true),
    ],
  },
  {
    id: "fg",
    label: "Finished goods",
    icon: "can",
    screens: [
      s("fgFill", "fg-fill", "FG filling", "SFG filled into cans or drums.", true),
      s("fgStock", "fg-stock", "Available FG stock", "Loose finished goods, lot by lot.", true),
      s("fgLog", "fg-log", "FG log", "Every finished-goods entry, newest first.", true),
    ],
  },
  {
    id: "pack",
    label: "FG packing",
    icon: "box",
    screens: [
      s("packBatches", "pack-batches", "Packing batches", "Loose cans packed into boxes. A batch posts only when the cans used match the boxes.", true),
      s("packStock", "pack-stock", "Available packing stock", "Boxed stock, grouped by SKU.", true),
      s("packLog", "pack-log", "Packing log", "Every packing entry, newest first.", true),
    ],
  },
  {
    id: "transfer",
    label: "Item transfer",
    icon: "swap",
    screens: [s("transfers", "transfers", "Item transfers", "Stock moved between godowns, including write-offs to Item Lost Record.", true)],
  },
  {
    id: "reorder",
    label: "Re-order",
    icon: "refresh",
    screens: [
      s("rmLevels", "rm-levels", "Raw-material levels", "Minimum and maximum per godown. Sorted by how close each item is to its minimum.", true),
      s("fgLevels", "fg-levels", "Finished-goods levels", "Minimum per SKU. Loose SKUs read FG stock, boxed SKUs read packing stock.", true),
      s("reorderRm", "reorder-rm", "Re-order raw items", "Followed items below their minimum. Raise a requisition from any row.", true),
      s("reorderFg", "reorder-fg", "Re-order finished goods", "Followed SKUs below their minimum.", true),
    ],
  },
  {
    id: "sales",
    label: "Sales orders",
    icon: "receipt",
    screens: [
      s("orderInbox", "order-inbox", "Order inbox", "WhatsApp messages the ERP read as possible orders. Nothing becomes an order until someone accepts the draft."),
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
      s("transport", "transport", "All transport", "Every dispatched bill, its LR and where the consignment is.", true),
      s("pendingLr", "pending-lr", "Pending LR", "Dispatched bills without an LR number yet.", true),
      s("trackLr", "track-lr", "Track LR", "Consignments still on the road. Update the stage and the next reminder call.", true),
      s("paidFreight", "paid-freight", "Transportation paid", "Paid-freight lines still without their extra expense, grouped by transporter.", true),
    ],
  },
  {
    id: "requests",
    label: "Requests & credit notes",
    icon: "chat",
    screens: [
      s("requests", "requests", "Customer requests", "Complaints and credit-note requests raised by sales, grouped by status.", true),
      s("issueCn", "issue-cn", "Issue credit note", "Accepted requests that need a credit note issued.", true),
      s("complaints", "complaints", "Customer complaints", "Requests without a credit note, grouped by complaint type.", true),
      s("pendingCn", "pending-cn", "Pending CN", "Order lines whose credit-note amount has not reached the margin yet.", true),
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
    label: "Expenses",
    icon: "wallet",
    screens: [
      s("credits", "credits", "Petty-cash credits", "Funds given to employees, per godown and mode.", true),
      s("expenses", "expenses", "Expenses", "Petty-cash spending, verified by the manager.", true),
    ],
  },
  {
    id: "mycust",
    label: "My customers",
    icon: "people",
    screens: [s("myCustomers", "my-customers", "My customers", "Your own customers and what they have raised.", true)],
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

export function erpScreen(key: string): ErpScreen | undefined {
  return ERP_SCREENS.find((x) => x.key === key);
}

export function erpScreenBySlug(slug: string): ErpScreen | undefined {
  return ERP_SCREENS.find((x) => x.slug === slug);
}

export function erpHref(screen: ErpScreen): string {
  return screen.slug ? `/erp/${screen.slug}` : "/erp";
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
