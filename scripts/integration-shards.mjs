/**
 * Which integration files a shard runs.
 *
 * `scripts/run-integration.mjs` runs one file per process, one after the other,
 * because every suite truncates the same tables in its `before` hook. That rule
 * is about ONE DATABASE. Sharding does not relax it: each shard is its own CI
 * job with its own Postgres service container, runs its files serially, and
 * never shares a database with another shard.
 *
 * Pure and dependency-free, so `integration-shards.test.mjs` can pin it without
 * a database.
 */

/**
 * Seconds each file took in a real CI run (run 38178407137, main, 2026-10-11),
 * rounded. Only used to balance shards — a file missing here, or a figure that
 * has gone stale, costs balance and never correctness, because every file
 * always lands in exactly one shard.
 */
export const WEIGHTS = {
  "src/lib/mbos-columns.test.ts": 1,
  "src/lib/journeys.test.ts": 423,
  "src/lib/customer-create.test.ts": 9,
  "src/lib/lead-territory.test.ts": 6,
  "src/lib/lead-scope.test.ts": 4,
  "src/lib/order-change.test.ts": 7,
  "src/lib/erp/erp-foundation.test.ts": 3,
  "src/lib/erp/erp-designations.test.ts": 3,
  "src/lib/erp/erp-purchase.test.ts": 4,
  "src/lib/erp/erp-stock-check.test.ts": 3,
  "src/lib/erp/erp-scrap.test.ts": 3,
  "src/lib/erp/erp-returns.test.ts": 3,
  "src/lib/erp/erp-material-duties.test.ts": 2,
  "src/lib/erp/erp-departments.test.ts": 3,
  "src/lib/erp/erp-production.test.ts": 3,
  "src/lib/factory/factory.test.ts": 5,
  "src/lib/erp/erp-traceability.test.ts": 3,
  "src/lib/erp/erp-sales.test.ts": 3,
  "src/lib/erp/erp-logistics.test.ts": 3,
  "src/lib/erp/erp-book.test.ts": 3,
  "src/lib/erp/erp-ai.test.ts": 3,
  "src/lib/erp/erp-ai-reading.test.ts": 2,
  "src/lib/hrms/integration/restructure.test.ts": 2,
  "src/lib/hire/integration/core.test.ts": 1,
  "src/lib/call-intel.test.ts": 12,
  "src/lib/they-called-us.test.ts": 27,
  "src/lib/visit-intel.test.ts": 7,
  "src/lib/task-campaigns.test.ts": 10,
  "src/lib/accounts.test.ts": 45,
  "src/lib/vendor-payouts.test.ts": 2,
  "src/lib/bill-paging.test.ts": 12,
  "src/lib/timeline-fold.test.ts": 4,
  "src/lib/feedback.test.ts": 10,
  "src/lib/notification-apps.db.test.ts": 4,
  "src/lib/document-tagging.test.ts": 9,
  "src/lib/activity-location.test.ts": 54,
  "src/lib/salesman-day.test.ts": 2,
  "src/lib/activity-history.test.ts": 12,
  "src/lib/punch-out-reminders.test.ts": 3,
  "src/lib/positions-endpoint.test.ts": 9,
  "src/lib/field-book.test.ts": 11,
  "src/lib/leads-list.test.ts": 14,
  "src/lib/outstanding-import.test.ts": 10,
  "src/lib/monthly-targets.test.ts": 12,
  "src/lib/performance.test.ts": 39,
  "src/lib/owner-dashboard.test.ts": 21,
  "src/lib/founder-dashboard.test.ts": 5,
  "src/lib/expense-policy.test.ts": 45,
  "src/lib/travel-on-visit.test.ts": 17,
  "src/lib/expense-attachments.test.ts": 9,
  "src/lib/day-evidence.test.ts": 19,
  "src/lib/check-in-gate.test.ts": 12,
  "src/lib/credential-issue.test.ts": 12,
  "src/lib/whatsapp-api.test.ts": 27,
  "src/lib/whatsapp-automation.test.ts": 18,
  "src/lib/wati-backfill.test.ts": 3,
  "src/lib/lead-trash.test.ts": 3,
  "src/lib/change-password.test.ts": 6,
  "src/lib/otp.test.ts": 19,
  "src/lib/either-identifier.test.ts": 9,
  "src/lib/access-candidates.test.ts": 3,
  "src/lib/storage-fallback.test.ts": 1,
  "src/lib/relationship-handover.test.ts": 9,
  "src/lib/seat-mirrors.test.ts": 6,
  "src/lib/customer-contacts.integration.test.ts": 20,
  "src/lib/place-master.test.ts": 1,
  "src/lib/place-tree-filters.test.ts": 4,
  "src/lib/territory-requests.test.ts": 3,
  "src/lib/holidays.test.ts": 8,
  "src/lib/price-lists.integration.test.ts": 19,
  "src/lib/price-sheets.integration.test.ts": 12,
  "src/lib/sample-logistics.test.ts": 6,
  "src/lib/enquiries.test.ts": 74,
  "src/lib/lead-from-enquiry.test.ts": 25,
  "src/lib/lead-owner-choices.test.ts": 13,
  "src/lib/lead-calling-desk.test.ts": 65,
  "src/lib/lead-call-intel.test.ts": 5,
  "src/lib/intake-intel.test.ts": 8,
  "src/lib/verify-intel.test.ts": 11,
  "src/lib/convert-intel.test.ts": 13,
  "src/lib/lead-lost.test.ts": 14,
  "src/lib/lead-resume-hold.test.ts": 11,
  "src/lib/lead-worklist-views.test.ts": 10,
  "src/lib/lead-reopen.test.ts": 25,
  "src/lib/lead-bulk-lost.test.ts": 6,
  "src/lib/lead-move-to-suspect.test.ts": 7,
  "src/lib/telecaller-qualification.test.ts": 50,
  "src/lib/lead-intake-product.test.ts": 17,
  "src/lib/lead-source-scope.test.ts": 8,
  "src/lib/services/app-provisioning.test.ts": 7,
  "src/lib/sales-manager-pipeline.test.ts": 40,
  "src/lib/crm-sales-manager.test.ts": 52,
  "src/lib/lead-verifier-seat.test.ts": 9,
  "src/lib/qualification-flow.test.ts": 21,
  "src/lib/self-raised-approver.test.ts": 14,
  "src/lib/telecaller-verifier-routing.test.ts": 22,
  "src/lib/field-verifier-routing.test.ts": 25,
  "src/lib/convert-legacy-stage.test.ts": 8,
  "src/lib/lead-owner-visibility.test.ts": 9,
  "src/lib/sales-manager-desk-queues.test.ts": 10,
  "src/lib/queue-progress.test.ts": 5,
  "src/lib/typical-order-cache.test.ts": 7,
  "src/lib/projection-idempotence.test.ts": 10,
  "src/lib/staging-idempotence.test.ts": 7,
  "src/lib/numbers-from-sql.test.ts": 1,
  "src/lib/whatsapp-read-write.test.ts": 7,
};

/** What an unlisted file is assumed to cost: a little above the median file. */
export const DEFAULT_WEIGHT = 10;

/**
 * `--shard 2/4` or `--shard=2/4` out of an argv, or null when absent (the
 * unsharded mode every developer uses). Throws a message fit to print on
 * anything malformed: a shard argument that is silently ignored would run the
 * whole suite in every job, or none of it.
 */
export function shardFromArgv(argv) {
  let raw = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--shard") {
      if (raw !== null) throw new Error("--shard was given more than once.");
      raw = argv[i + 1];
      if (raw === undefined || raw.startsWith("--")) {
        throw new Error("--shard needs a value like 2/4.");
      }
      i++;
    } else if (a.startsWith("--shard=")) {
      if (raw !== null) throw new Error("--shard was given more than once.");
      raw = a.slice("--shard=".length);
    } else {
      throw new Error(`Unknown argument "${a}". The only option is --shard i/N.`);
    }
  }
  return raw === null ? null : parseShard(raw);
}

export function parseShard(raw) {
  const m = /^(\d+)\/(\d+)$/.exec(String(raw).trim());
  if (!m) throw new Error(`Invalid shard "${raw}": expected i/N, for example 2/4.`);
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`Invalid shard "${raw}": N must be 1 or more.`);
  }
  if (!Number.isSafeInteger(index) || index < 1 || index > count) {
    throw new Error(`Invalid shard "${raw}": i must be between 1 and ${count}.`);
  }
  return { index, count };
}

/**
 * Splits `files` into `count` groups, longest-first onto the lightest group
 * (ties to the lowest index; files with equal weight ordered by name), so the
 * result depends only on the file list and the weights. Inside each group the
 * files keep the order they have in `files`, which is what the runner's own
 * comment asks for (the cheap column check first).
 *
 * Every file is in exactly one group. A repeated name is refused rather than
 * deduplicated: a file listed twice would otherwise run twice unsharded and
 * once sharded, and the two modes would stop meaning the same thing.
 */
export function assignShards(files, count, weights = WEIGHTS) {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("The shard count must be 1 or more.");
  }
  const seen = new Set();
  for (const f of files) {
    if (seen.has(f)) throw new Error(`"${f}" is listed more than once.`);
    seen.add(f);
  }
  const weight = (f) => weights[f] ?? DEFAULT_WEIGHT;
  const position = new Map(files.map((f, i) => [f, i]));
  const groups = Array.from({ length: count }, () => ({ load: 0, files: [] }));
  const order = [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const f of order) {
    let best = groups[0];
    for (const g of groups) if (g.load < best.load) best = g;
    best.files.push(f);
    best.load += weight(f);
  }
  return groups.map((g) => ({
    load: g.load,
    files: g.files.sort((a, b) => position.get(a) - position.get(b)),
  }));
}

/** The files one shard runs. */
export function filesForShard(files, shard, weights = WEIGHTS) {
  return assignShards(files, shard.count, weights)[shard.index - 1].files;
}
