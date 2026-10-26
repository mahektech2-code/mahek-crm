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
 * Seconds each file took in a real CI run (run 40286046608, PR #873,
 * 2026-10-26 — the first on the in-memory, no-fsync Postgres), rounded, at
 * least 1. Only used to balance shards — a file missing here, or a figure that
 * has gone stale, costs balance and never correctness, because every file
 * always lands in exactly one shard.
 *
 * Refresh them when a shard runs a minute longer than the others: the figures
 * from 11 October put 469 seconds of work in shard 1 and 428 in shard 4, and on
 * the faster database shard 4 finished a minute after shard 3.
 */
export const WEIGHTS = {
  "src/lib/mbos-columns.test.ts": 1,
  "src/lib/journeys.test.ts": 210,
  "src/lib/customer-create.test.ts": 4,
  "src/lib/lead-territory.test.ts": 3,
  "src/lib/lead-scope.test.ts": 2,
  "src/lib/order-change.test.ts": 3,
  "src/lib/erp/erp-foundation.test.ts": 2,
  "src/lib/erp/erp-designations.test.ts": 2,
  "src/lib/erp/erp-purchase.test.ts": 4,
  "src/lib/erp/erp-stock-check.test.ts": 3,
  "src/lib/erp/erp-stock-adjust.test.ts": 2,
  "src/lib/erp/erp-scrap.test.ts": 3,
  "src/lib/erp/erp-returns.test.ts": 2,
  "src/lib/erp/erp-can-groups.test.ts": 2,
  "src/lib/erp/erp-departments.test.ts": 2,
  "src/lib/erp/erp-production.test.ts": 3,
  "src/lib/factory/factory.test.ts": 6,
  "src/lib/erp/erp-traceability.test.ts": 4,
  "src/lib/erp/erp-sales.test.ts": 2,
  "src/lib/erp/erp-logistics.test.ts": 3,
  "src/lib/erp/erp-money.test.ts": 3,
  "src/lib/bank-statements.test.ts": 2,
  "src/lib/erp/erp-book.test.ts": 3,
  "src/lib/erp/erp-scale.test.ts": 32,
  "src/lib/erp/erp-ai.test.ts": 2,
  "src/lib/erp/erp-ai-reading.test.ts": 2,
  "src/lib/hrms/integration/restructure.test.ts": 2,
  "src/lib/hire/integration/core.test.ts": 1,
  "src/lib/call-intel.test.ts": 5,
  "src/lib/they-called-us.test.ts": 8,
  "src/lib/visit-intel.test.ts": 3,
  "src/lib/task-campaigns.test.ts": 5,
  "src/lib/accounts.test.ts": 15,
  "src/lib/vendor-payouts.test.ts": 1,
  "src/lib/website-cms/website-cms.test.ts": 17,
  "src/lib/website-cms/review-schema.test.ts": 6,
  "src/lib/website-cms/review-workflow.test.ts": 24,
  "src/lib/website-cms/review-visibility.test.ts": 16,
  "src/lib/website-cms/review-notifications.test.ts": 14,
  "src/lib/bill-paging.test.ts": 5,
  "src/lib/timeline-fold.test.ts": 2,
  "src/lib/feedback.test.ts": 3,
  "src/lib/notification-apps.db.test.ts": 2,
  "src/lib/document-tagging.test.ts": 4,
  "src/lib/activity-location.test.ts": 18,
  "src/lib/salesman-day.test.ts": 1,
  "src/lib/activity-history.test.ts": 4,
  "src/lib/punch-out-reminders.test.ts": 1,
  "src/lib/positions-endpoint.test.ts": 4,
  "src/lib/field-book.test.ts": 4,
  "src/lib/leads-list.test.ts": 6,
  "src/lib/outstanding-import.test.ts": 4,
  "src/lib/monthly-targets.test.ts": 5,
  "src/lib/performance.test.ts": 14,
  "src/lib/owner-dashboard.test.ts": 6,
  "src/lib/founder-dashboard.test.ts": 2,
  "src/lib/expense-policy.test.ts": 16,
  "src/lib/travel-on-visit.test.ts": 7,
  "src/lib/expense-attachments.test.ts": 4,
  "src/lib/day-evidence.test.ts": 6,
  "src/lib/check-in-gate.test.ts": 4,
  "src/lib/credential-issue.test.ts": 5,
  "src/lib/whatsapp-api.test.ts": 10,
  "src/lib/whatsapp-automation.test.ts": 5,
  "src/lib/wati-backfill.test.ts": 2,
  "src/lib/lead-trash.test.ts": 2,
  "src/lib/lead-twins.test.ts": 2,
  "src/lib/change-password.test.ts": 2,
  "src/lib/otp.test.ts": 8,
  "src/lib/either-identifier.test.ts": 3,
  "src/lib/website-access-save.test.ts": 4,
  "src/lib/access-candidates.test.ts": 1,
  "src/lib/storage-fallback.test.ts": 1,
  "src/lib/relationship-handover.test.ts": 3,
  "src/lib/seat-mirrors.test.ts": 3,
  "src/lib/customer-contacts.integration.test.ts": 8,
  "src/lib/place-master.test.ts": 1,
  "src/lib/place-tree-filters.test.ts": 2,
  "src/lib/territory-requests.test.ts": 2,
  "src/lib/holidays.test.ts": 4,
  "src/lib/price-lists.integration.test.ts": 8,
  "src/lib/price-sheets.integration.test.ts": 4,
  "src/lib/sample-logistics.test.ts": 3,
  "src/lib/enquiries.test.ts": 24,
  "src/lib/lead-from-enquiry.test.ts": 8,
  "src/lib/lead-owner-choices.test.ts": 7,
  "src/lib/lead-calling-desk.test.ts": 21,
  "src/lib/lead-call-intel.test.ts": 2,
  "src/lib/intake-intel.test.ts": 3,
  "src/lib/verify-intel.test.ts": 5,
  "src/lib/convert-intel.test.ts": 5,
  "src/lib/lead-lost.test.ts": 5,
  "src/lib/lead-resume-hold.test.ts": 5,
  "src/lib/lead-worklist-views.test.ts": 4,
  "src/lib/lead-reopen.test.ts": 10,
  "src/lib/lead-bulk-lost.test.ts": 3,
  "src/lib/lead-bulk-hold.test.ts": 8,
  "src/lib/lead-move-to-suspect.test.ts": 3,
  "src/lib/telecaller-qualification.test.ts": 16,
  "src/lib/lead-intake-product.test.ts": 6,
  "src/lib/lead-source-scope.test.ts": 3,
  "src/lib/services/app-provisioning.test.ts": 2,
  "src/lib/sales-manager-pipeline.test.ts": 14,
  "src/lib/crm-sales-manager.test.ts": 19,
  "src/lib/lead-verifier-seat.test.ts": 4,
  "src/lib/qualification-flow.test.ts": 10,
  "src/lib/self-raised-approver.test.ts": 5,
  "src/lib/telecaller-verifier-routing.test.ts": 9,
  "src/lib/field-verifier-routing.test.ts": 10,
  "src/lib/org-chart-verifier-routing.test.ts": 25,
  "src/lib/convert-legacy-stage.test.ts": 3,
  "src/lib/lead-owner-visibility.test.ts": 4,
  "src/lib/sales-manager-desk-queues.test.ts": 4,
  "src/lib/queue-progress.test.ts": 2,
  "src/lib/typical-order-cache.test.ts": 3,
  "src/lib/projection-idempotence.test.ts": 5,
  "src/lib/staging-idempotence.test.ts": 2,
  "src/lib/numbers-from-sql.test.ts": 1,
  "src/lib/whatsapp-read-write.test.ts": 3,
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
