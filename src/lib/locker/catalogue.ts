/* ---------------------------------------------------------------------------
 * The Locker's catalogue: the categories an asset sits in and the types it
 * starts from. PURE and client-safe — the add-asset form, the filters and the
 * migration that seeds `locker_asset_types` all read this one list.
 *
 * Categories are code, not a table: each one is a sidebar entry and a module
 * somebody can be granted, and a module is a destination in the navigation.
 * Types are a TABLE (seeded from TYPE_SEED) because an admin adds them.
 * ------------------------------------------------------------------------- */

export type TimeModel = "document" | "subscription" | "perpetual" | "term_contract";

export type Category = { slug: string; name: string; code: string; short: string; nav: string; icon: string; inNav: boolean };

/** In register order. `inNav` false: listed under All assets, no sidebar entry of its own. */
export const CATEGORIES: Category[] = [
  { slug: "statutory", name: "Legal & government", code: "STAT", short: "Statutory", nav: "Legal", icon: "doc", inNav: true },
  { slug: "hazardous", name: "Hazardous & safety", code: "HAZ", short: "Hazardous", nav: "Hazardous", icon: "flame", inNav: true },
  { slug: "insurance", name: "Insurance", code: "INS", short: "Insurance", nav: "Insurance", icon: "shield", inNav: true },
  { slug: "vehicles", name: "Vehicles & fleet", code: "VEH", short: "Vehicles", nav: "Vehicles", icon: "truck", inNav: true },
  { slug: "property", name: "Property & premises", code: "PROP", short: "Property", nav: "Property", icon: "home", inNav: true },
  { slug: "contracts", name: "Contracts & agreements", code: "CON", short: "Contracts", nav: "Contracts", icon: "file", inNav: true },
  { slug: "ip", name: "Brands & trademarks", code: "IP", short: "IP", nav: "Brands", icon: "tag", inNav: true },
  { slug: "cert", name: "Certifications & quality", code: "CERT", short: "Certificates", nav: "Certificates", icon: "doc", inNav: false },
  { slug: "banking", name: "Banking & finance", code: "BANK", short: "Banking", nav: "Banking", icon: "bank", inNav: true },
  { slug: "digital", name: "Digital services", code: "DIG", short: "Digital", nav: "Digital", icon: "globe", inNav: true },
  { slug: "software", name: "Software licences", code: "SW", short: "Software", nav: "Software", icon: "box", inNav: false },
  { slug: "corporate", name: "Corporate records", code: "CORP", short: "Corporate", nav: "Company records", icon: "building", inNav: true },
];

export const CATEGORY: Record<string, Category> = Object.fromEntries(CATEGORIES.map((c) => [c.slug, c]));
/** The categories that have a sidebar entry — and so a module of their own. */
export const NAV_CATEGORIES = CATEGORIES.filter((c) => c.inNav).map((c) => c.slug);
/**
 * Which category module opens a category. Certificates and Software have no
 * sidebar entry of their own in the design, so they ride on a neighbour —
 * quality certificates with Legal, software licences with Digital.
 */
export function categoryModuleSlug(cat: string): string {
  if (cat === "cert") return "statutory";
  if (cat === "software") return "digital";
  return cat;
}

export type TypeSeed = {
  code: string;
  name: string;
  category: string;
  model: TimeModel;
  validityMonths: number;
  leadDays: number;
  graceDays: number;
  criticality: 1 | 2 | 3 | 4;
  authority: string;
  typicalCostRupees: number;
  steps?: string[];
  consequence?: string;
  fields?: { key: string; label: string }[];
};

const T = (code: string, name: string, category: string, model: TimeModel, validityMonths: number, leadDays: number, graceDays: number, criticality: 1 | 2 | 3 | 4, authority: string, typicalCostRupees: number): TypeSeed =>
  ({ code, name, category, model, validityMonths, leadDays, graceDays, criticality, authority, typicalCostRupees });

const STEPS: Record<string, string[]> = {
  peso: [
    "Download Form XIV renewal from the PESO online portal",
    "Attach the current licence, site plan and earthing test report (within 12 months)",
    "Pay the fee online and save the challan",
    "Submit at least 120 days before end date — late applying risks a gap in validity",
    "Respond to any query from the Nagpur circle within 15 days",
    "Receive the renewed licence; upload it and check the dates and capacity",
  ],
  pcb: [
    "Log in to the MPCB XGN portal and open the consent renewal",
    "Upload water and air analysis reports from a recognised lab (last 3 months)",
    "Upload the hazardous waste returns (Form 4) for the year",
    "Pay the consent fee based on capital investment",
    "File at least 120 days before end date; applying on time is what keeps you safe in law",
    "Track site inspection and upload the consent order on receipt",
  ],
  fire: [
    "Book the fire safety audit with an approved agency",
    "Refill and tag every extinguisher; test the hydrant system",
    "Apply on the municipal fire portal with the audit report",
    "Pay the fee and schedule the inspection",
    "Upload the renewed NOC and check the validity",
  ],
};

const CONSEQUENCE: Record<string, string> = {
  peso: "Solvent storage must stop. Without a valid PESO licence the sites cannot hold petroleum class A/B products — operations halt and stock must be moved.",
  pcb: "Operating without consent is an offence under the Water and Air Acts. The board can order closure and disconnect power.",
  fire: "Without a valid Fire NOC the sites can be sealed, and insurance claims for fire may be refused.",
  factory: "Running the plant without a factory licence exposes the occupier to prosecution and stops production.",
  odlimit: "The working-capital limit runs out. Supplier payments and payroll depend on it.",
  gst: "Without an active registration invoices cannot be raised and input credit is lost.",
  hgt: "The tanker cannot carry hazardous goods. Dispatches on that vehicle stop.",
  wsp: "Email, calendar and every service that signs in with Google stop working.",
};

const F = (...labels: string[]) => labels.map((label) => ({ key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), label }));
const INSURANCE_FIELDS = F("Insurer", "Policy number", "Sum insured", "Coverage", "Deductible", "Broker");

/** The type-specific fields (spec §5.4); an admin adds more on Admin › Types. */
const FIELDS: Record<string, { key: string; label: string }[]> = {
  gst: F("GSTIN", "State", "Registration type", "Filing frequency"),
  vins: F("Registration number", "Policy number", "IDV", "NCB %", "Policy type"),
  puc: F("Registration number", "Test centre", "Reading"),
  tm: F("Application number", "Classes", "Registry", "Status", "Brand covered"),
  pcb: F("Consent number", "Category", "Capacity authorised", "Conditions"),
  peso: F("Licence number", "Capacity in KL", "Products authorised", "Premises approved"),
  domain: F("Registrar", "Nameservers", "Registrant", "Transfer lock", "WHOIS privacy", "DNSSEC"),
  ssl: F("CN", "SANs", "CA", "Issuance type", "Fingerprint"),
  odlimit: F("Sanctioned limit", "Drawing power", "Security offered", "Review date"),
  fireins: INSURANCE_FIELDS,
  stockins: INSURANCE_FIELDS,
  marine: INSURANCE_FIELDS,
  liab: INSURANCE_FIELDS,
  health: INSURANCE_FIELDS,
  wc: INSURANCE_FIELDS,
};

/** The steps every type without its own falls back to. */
export const DEFAULT_STEPS = [
  "Collect the current document and anything the issuer asks for",
  "Apply or pay before the time needed to renew runs out",
  "Save the acknowledgement or receipt",
  "Receive the renewed document",
  "Upload it and check the new dates against the original",
];

export const TYPE_SEED: TypeSeed[] = [
  T("gst", "GST registration", "statutory", "perpetual", 0, 0, 0, 4, "GST Department", 0),
  T("shops", "Shops & Establishment licence", "statutory", "document", 60, 60, 0, 3, "Municipal Corporation", 4500),
  T("trade", "Trade licence", "statutory", "document", 12, 45, 15, 3, "Municipal Corporation", 8000),
  T("factory", "Factory licence", "statutory", "document", 12, 90, 0, 4, "Directorate of Industrial Safety & Health", 32000),
  T("ptax", "Professional tax registration", "statutory", "document", 12, 30, 30, 2, "State Sales Tax Department", 2500),
  T("lmet", "Legal Metrology registration", "statutory", "document", 12, 45, 0, 3, "Legal Metrology Department", 6000),
  T("iec", "Import Export Code", "statutory", "perpetual", 0, 0, 0, 2, "DGFT", 0),
  T("peso", "PESO petroleum storage licence", "hazardous", "document", 36, 120, 0, 4, "PESO, Nagpur Circle", 58000),
  T("pcb", "Pollution Board consent to operate", "hazardous", "document", 60, 120, 0, 4, "State Pollution Control Board", 145000),
  T("fire", "Fire NOC", "hazardous", "document", 12, 60, 15, 4, "Fire & Emergency Services", 18500),
  T("hwaste", "Hazardous waste authorisation", "hazardous", "document", 60, 90, 0, 3, "State Pollution Control Board", 22000),
  T("msds", "MSDS register review", "hazardous", "document", 12, 30, 0, 2, "Internal · Safety Officer", 0),
  T("extg", "Fire extinguisher refill", "hazardous", "document", 12, 30, 0, 2, "Fire safety vendor", 9500),
  T("saudit", "Third-party safety audit", "hazardous", "document", 24, 60, 0, 3, "Approved safety auditor", 65000),
  T("fireins", "Fire & special perils policy", "insurance", "document", 12, 45, 0, 3, "Insurer", 210000),
  T("stockins", "Stock insurance", "insurance", "document", 12, 45, 0, 3, "Insurer", 88000),
  T("marine", "Marine transit policy", "insurance", "document", 12, 45, 0, 3, "Insurer", 64000),
  T("liab", "Public liability policy", "insurance", "document", 12, 45, 0, 3, "Insurer", 42000),
  T("health", "Group health policy", "insurance", "document", 12, 45, 0, 2, "Insurer", 380000),
  T("wc", "Workmen compensation policy", "insurance", "document", 12, 45, 0, 3, "Insurer", 56000),
  T("rc", "Registration certificate", "vehicles", "document", 180, 60, 0, 2, "RTO", 0),
  T("vins", "Vehicle insurance", "vehicles", "document", 12, 30, 0, 3, "Insurer", 38000),
  T("puc", "PUC certificate", "vehicles", "document", 6, 15, 0, 2, "Authorised PUC centre", 300),
  T("fit", "Fitness certificate", "vehicles", "document", 12, 30, 0, 3, "RTO", 2800),
  T("permit", "National permit", "vehicles", "document", 60, 45, 0, 3, "RTO", 16500),
  T("hgt", "Hazardous goods transport licence", "vehicles", "document", 12, 45, 0, 4, "RTO · PESO", 4200),
  T("lease", "Lease agreement", "property", "term_contract", 36, 90, 0, 3, "Landlord", 0),
  T("rent", "Leave & licence agreement", "property", "term_contract", 11, 60, 0, 2, "Landlord", 0),
  T("proptax", "Property tax", "property", "document", 12, 30, 30, 2, "Municipal Corporation", 42000),
  T("dealer", "Dealer agreement", "contracts", "term_contract", 24, 30, 0, 2, "Dealer", 0),
  T("amc", "Annual maintenance contract", "contracts", "term_contract", 12, 60, 0, 2, "Vendor", 48000),
  T("vendor", "Vendor supply contract", "contracts", "term_contract", 24, 60, 0, 2, "Vendor", 0),
  T("nda", "Non-disclosure agreement", "contracts", "term_contract", 36, 30, 0, 1, "Other party", 0),
  T("transp", "Transporter agreement", "contracts", "term_contract", 12, 45, 0, 3, "Transporter", 0),
  T("tm", "Trademark registration", "ip", "document", 120, 180, 180, 3, "Trade Marks Registry, Mumbai", 9000),
  T("copy", "Copyright registration", "ip", "perpetual", 0, 0, 0, 1, "Copyright Office", 0),
  T("design", "Design registration", "ip", "document", 120, 180, 0, 2, "Patent Office", 4000),
  T("iso", "ISO 9001 certificate", "cert", "document", 36, 90, 0, 3, "Certification body", 125000),
  T("bis", "BIS product certificate", "cert", "document", 12, 90, 0, 3, "Bureau of Indian Standards", 38000),
  T("test", "Product test report", "cert", "document", 12, 30, 0, 2, "NABL lab", 6500),
  T("odlimit", "OD / CC limit renewal", "banking", "document", 12, 60, 0, 4, "Bank", 85000),
  T("bg", "Bank guarantee", "banking", "document", 12, 45, 0, 3, "Bank", 12000),
  T("kyc", "Current account KYC re-check", "banking", "document", 24, 30, 0, 2, "Bank", 0),
  T("dsc", "Digital signature certificate", "banking", "document", 24, 30, 0, 3, "Certifying office", 1800),
  T("loan", "Term loan", "banking", "term_contract", 60, 90, 0, 3, "Bank", 0),
  T("domain", "Domain registration", "digital", "subscription", 12, 30, 30, 3, "Registrar", 1100),
  T("ssl", "SSL certificate", "digital", "subscription", 12, 21, 0, 3, "Certificate office", 0),
  T("cloud", "Cloud hosting", "digital", "subscription", 1, 7, 0, 3, "Provider", 0),
  T("saas", "SaaS subscription", "digital", "subscription", 12, 30, 0, 2, "Provider", 0),
  T("wsp", "Email & workspace", "digital", "subscription", 12, 30, 0, 4, "Provider", 0),
  T("tally", "Tally licence", "software", "perpetual", 0, 30, 0, 3, "Tally Solutions", 22500),
  T("ms", "Microsoft 365 licence", "software", "subscription", 12, 30, 0, 2, "Microsoft", 0),
  T("av", "Antivirus licence", "software", "subscription", 12, 30, 0, 2, "Vendor", 0),
  T("dsn", "Design software", "software", "subscription", 12, 30, 0, 1, "Vendor", 0),
  T("incorp", "Certificate of incorporation", "corporate", "perpetual", 0, 0, 0, 2, "Registrar of Companies", 0),
  T("moa", "MOA & AOA", "corporate", "perpetual", 0, 0, 0, 2, "Registrar of Companies", 0),
  T("roc", "Annual ROC filing", "corporate", "document", 12, 60, 0, 3, "Registrar of Companies", 8000),
  T("auditor", "Statutory auditor appointment", "corporate", "term_contract", 60, 90, 0, 2, "Board", 0),
  T("resol", "Board resolution register", "corporate", "perpetual", 0, 0, 0, 1, "Board", 0),
].map((t) => ({ ...t, steps: STEPS[t.code], consequence: CONSEQUENCE[t.code], fields: FIELDS[t.code] ?? [] }));

/** The default reminder schedule per importance — days relative to the action day. */
export const DEFAULT_LADDERS: Record<1 | 2 | 3 | 4, number[]> = {
  4: [-180, -120, -90, -60, -45, -30, -21, -14, -7, -3, -1, 0, 1],
  3: [-90, -60, -30, -14, -7, -1, 0, 1],
  2: [-45, -30, -14, -7, 0, 3],
  1: [-30, -7, 0],
};

export const CREDENTIAL_KINDS = [
  "Web login",
  "API key",
  "Banking",
  "Government portal",
  "SSH key",
  "Database",
  "Wi-Fi",
  "Device admin",
  "Email inbox",
  "Payment card portal",
] as const;

/** The secret fields a login of each kind usually carries. */
export const DEFAULT_FIELDS: Record<string, string[]> = {
  "API key": ["API key"],
  Banking: ["Login password", "Transaction password"],
  "SSH key": ["Private key", "Passphrase"],
  "Email inbox": ["Password", "Backup codes"],
};

export const AUTH_LABEL: Record<string, string> = {
  direct: "Own password",
  federated_sso: "Signs in with another account",
  api_key: "API key",
  ssh_key: "SSH key",
  shared_secret: "Shared secret",
};
