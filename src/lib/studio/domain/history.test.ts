import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_STATUSES,
  HISTORY_STATUS_HINT,
  HISTORY_STATUS_LABEL,
  activeFilterCount,
  forwardStatus,
  needsForwarded,
  parseFilters,
  parseKey,
  posterStatus,
} from "./history";

describe("poster forwarding history — status words", () => {
  test("a made poster is Not forwarded until WhatsApp was opened from it; making it is not forwarding", () => {
    assert.equal(posterStatus(0), "not_forwarded");
    assert.equal(posterStatus(1), "opened");
    assert.equal(posterStatus(7), "opened");
  });

  test("a forward recipient keeps its stored status; anything unknown is Not Started, never sent", () => {
    for (const s of ["pending", "opened", "sent", "skipped"] as const) assert.equal(forwardStatus(s), s);
    assert.equal(forwardStatus("delivered"), "pending");
    assert.equal(forwardStatus(""), "pending");
  });

  test("the labels are the approved four plus Not forwarded, and nothing claims delivery", () => {
    assert.deepEqual(HISTORY_STATUSES.map((s) => HISTORY_STATUS_LABEL[s]), ["Not Started", "Chat Opened", "Marked Sent", "Skipped", "Not forwarded"]);
    const all = [...Object.values(HISTORY_STATUS_LABEL), ...Object.values(HISTORY_STATUS_HINT)].join(" ").toLowerCase();
    assert.ok(!/delivered|successfully sent|received|read receipt/.test(all.replace("whatsapp delivery is not confirmed", "")));
    assert.match(HISTORY_STATUS_HINT.sent, /not confirmed/i);
  });
});

describe("poster forwarding history — filters come from a URL, so each is checked", () => {
  test("defaults", () => {
    const f = parseFilters({});
    assert.deepEqual(f, { q: "", poster: "", recipient: "", mode: null, status: null, from: null, to: null, user: null, show: "all", page: 1 });
    assert.equal(activeFilterCount(f), 0);
  });

  test("unknown modes and statuses are dropped, known ones kept", () => {
    assert.equal(parseFilters({ mode: "bulk_upload" }).mode, "bulk_upload");
    assert.equal(parseFilters({ mode: "drop table" }).mode, null);
    assert.equal(parseFilters({ status: "sent" }).status, "sent");
    assert.equal(parseFilters({ status: "delivered" }).status, null);
  });

  test("dates must be real calendar days", () => {
    assert.equal(parseFilters({ from: "2026-11-13" }).from, "2026-11-13");
    assert.equal(parseFilters({ from: "2026-02-30" }).from, null);
    assert.equal(parseFilters({ to: "13/11/2026" }).to, null);
    assert.equal(parseFilters({ to: "2026-11-13'; --" }).to, null);
  });

  test("text is trimmed, collapsed, control characters removed and capped; page is a positive whole number", () => {
    assert.equal(parseFilters({ q: "  shree \n  paints  " }).q, "shree paints");
    assert.equal(parseFilters({ q: "x".repeat(500) }).q.length, 80);
    assert.equal(parseFilters({ page: "-3" }).page, 1);
    assert.equal(parseFilters({ page: "abc" }).page, 1);
    assert.equal(parseFilters({ page: "4" }).page, 4);
    assert.equal(parseFilters({ q: ["a", "b"] }).q, "a");
  });

  test("a user filter must look like an id", () => {
    assert.equal(parseFilters({ user: "usr_abc-123" }).user, "usr_abc-123");
    assert.equal(parseFilters({ user: "a' or 1=1" }).user, null);
  });

  test("a status other than Not forwarded, or Forwarded only, can only be answered by forwarded rows", () => {
    assert.equal(needsForwarded(parseFilters({ status: "sent" })), true);
    assert.equal(needsForwarded(parseFilters({ status: "not_forwarded" })), false);
    assert.equal(needsForwarded(parseFilters({ show: "forwarded" })), true);
    assert.equal(needsForwarded(parseFilters({})), false);
  });
});

describe("poster forwarding history — row keys", () => {
  test("only p:<id> and f:<id> are keys", () => {
    assert.deepEqual(parseKey("p:abc_123"), { kind: "poster", id: "abc_123" });
    assert.deepEqual(parseKey("f:fwr_9"), { kind: "forward", id: "fwr_9" });
    for (const bad of ["", "x:1", "p:", "p:a b", "p:a;b", "pabc", null, undefined]) assert.equal(parseKey(bad as string), null);
  });
});
