/* ---------------------------------------------------------------------------
 * The search engine's benchmark: questions people actually type, and the page
 * that answers each. `retrieve.test.ts` runs it against the real written docs
 * and fails if accuracy drops, so a change to the ranking is measured rather
 * than guessed at. Typos, abbreviations, half-typed words and whole questions
 * are all in it on purpose — they are what a search box is really given.
 *
 * Each entry accepts one or more pages: where two pages genuinely answer the
 * question, either is right.
 * ------------------------------------------------------------------------- */

export type BenchmarkCase = { q: string; pages: string[]; note?: string };

export const SEARCH_BENCHMARK: BenchmarkCase[] = [
  // ---- the CRM
  { q: "why is a customer not on my call log", pages: ["crm/call-log"] },
  { q: "no answer ladder", pages: ["crm/call-log"] },
  { q: "quiet window after an order", pages: ["crm/call-log"] },
  { q: "callback reminder snooze", pages: ["crm/reminders"] },
  { q: "who called whom yesterday call history", pages: ["crm/history"] },
  { q: "payment follow up stages", pages: ["crm/payments"] },
  { q: "promise to pay", pages: ["crm/payments"] },
  { q: "send a whatsapp reminder", pages: ["crm/whatsapp"] },
  { q: "wati template", pages: ["crm/whatsapp", "platform/integrations"] },
  { q: "who owes us money", pages: ["crm/outstanding"] },
  { q: "aging buckets of a bill", pages: ["crm/bills", "crm/outstanding"] },
  { q: "reassign account manager", pages: ["crm/customers"] },
  { q: "raise a complaint", pages: ["crm/complaints", "erp/complaints-and-credit-notes"] },
  { q: "price list for a shop", pages: ["crm/price-lists"] },
  { q: "close a customer account", pages: ["crm/status-requests"] },
  { q: "suspect to prospect", pages: ["crm/lead-calling-desk", "crm/leads", "crm/lead-intake-and-qualification", "mbos/leads"] },
  { q: "lead stage gates", pages: ["crm/leads"] },
  { q: "sample trial review", pages: ["crm/samples"] },
  { q: "distributor appointment", pages: ["crm/lead-commercial"] },
  { q: "end of day report", pages: ["crm/eod"] },
  { q: "monthly customer target shortfall", pages: ["crm/targets"] },
  { q: "opportunity from a call", pages: ["crm/opportunities"] },
  { q: "next action nurture tasks", pages: ["crm/lead-actions"] },
  // ---- the Sales Dashboard
  { q: "live map of salesmen", pages: ["sales/live-map"] },
  { q: "approve expense claim", pages: ["sales/expenses"] },
  { q: "allocate a territory", pages: ["sales/territory"] },
  { q: "set a salesman target", pages: ["sales/targets"] },
  { q: "performance score weights", pages: ["sales/performance", "crm/performance", "mbos/performance"] },
  { q: "approve a leave request", pages: ["sales/leave-and-holidays"] },
  { q: "plan a journey for tomorrow", pages: ["sales/journeys", "mbos/journeys"] },
  { q: "who has not punched in today", pages: ["sales/attendance", "sales/today"] },
  { q: "publish a document to the field", pages: ["sales/enablement"] },
  { q: "assign a task to a salesman", pages: ["sales/tasks"] },
  { q: "mileage meter reading", pages: ["sales/travel", "mbos/expenses"] },
  // ---- the handset
  { q: "punch in selfie", pages: ["mbos/attendance", "sales/attendance"] },
  { q: "check in refused too far from the shop", pages: ["mbos/visit"] },
  { q: "take an order on the handset", pages: ["mbos/orders"] },
  { q: "collect a cheque", pages: ["mbos/payments"] },
  { q: "offline maps download", pages: ["mbos/offline-maps"] },
  { q: "outbox sync", pages: ["mbos/sync"] },
  { q: "install the app and sign in", pages: ["mbos/setup"] },
  // ---- the ERP
  { q: "scan a box at dispatch", pages: ["erp/dispatch"] },
  { q: "raise a purchase order", pages: ["erp/purchase-orders"] },
  { q: "quotation comparison", pages: ["erp/quotation-manager"] },
  { q: "goods receipt testing", pages: ["erp/goods-receipt-and-testing"] },
  { q: "sfg batch qc approval", pages: ["erp/production"] },
  { q: "reorder level", pages: ["erp/stock-levels"] },
  { q: "transfer stock between godowns", pages: ["erp/stock"] },
  { q: "trace a box back to its lot", pages: ["erp/traceability"] },
  { q: "lr number transport", pages: ["erp/transport"] },
  { q: "petty cash funds given", pages: ["erp/petty-cash"] },
  { q: "erp designation preview as", pages: ["erp/access-and-designations"] },
  // ---- the platform
  { q: "deploy to digitalocean", pages: ["platform/deploy-digitalocean"] },
  { q: "restore a backup", pages: ["platform/backups"] },
  { q: "release a new apk", pages: ["platform/handset-release"] },
  { q: "cloudflare r2 file storage", pages: ["platform/storage-r2"] },
  { q: "google sheet sync cron", pages: ["platform/sheets-and-jobs"] },
  { q: "add a new setting", pages: ["platform/configuration"] },
  { q: "run it on my laptop", pages: ["platform/local-setup"] },
  // ---- typos, abbreviations, half-typed
  { q: "dispach scaning", pages: ["erp/dispatch"], note: "two typos" },
  { q: "purchse ordr aproval", pages: ["erp/purchase-orders"], note: "three typos" },
  { q: "po approval", pages: ["erp/purchase-orders"], note: "abbreviation" },
  { q: "grn", pages: ["erp/goods-receipt-and-testing"], note: "abbreviation" },
  { q: "otp sign in", pages: ["platform/integrations", "platform/architecture", "mbos/setup"], note: "abbreviation" },
  { q: "traceab", pages: ["erp/traceability"], note: "half typed" },
  { q: "offline ma", pages: ["mbos/offline-maps"], note: "half typed" },
];
