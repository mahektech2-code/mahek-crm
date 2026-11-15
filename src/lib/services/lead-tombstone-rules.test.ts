import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { seatsMoved, withoutResentLeads } from "./lead-tombstone-rules";

test("a pull never tombstones a lead it is also sending", () => {
  const groups = [
    { entity: "leads", ids: ["a", "b", "c"] },
    { entity: "customers", ids: ["a"] },
  ];
  assert.deepEqual(withoutResentLeads(groups, ["b"]), [
    { entity: "leads", ids: ["a", "c"] },
    { entity: "customers", ids: ["a"] },
  ]);
  // Only the leads entity is touched: the shop's own tombstone is another rule.
  assert.deepEqual(withoutResentLeads(groups, ["a", "b", "c"]), [{ entity: "customers", ids: ["a"] }]);
  assert.equal(withoutResentLeads(groups, []), groups);
});

test("seats moved compares nulls as nobody", () => {
  assert.equal(seatsMoved([null, "u1"], [undefined, "u1"]), false);
  assert.equal(seatsMoved(["u1"], ["u2"]), true);
});

/* The writers that take a lead out of `openLeads` must say so to the phones.
   Read as text, because a missing call fails silently on a handset. */
test("every writer that drops a lead from the leads channel writes a tombstone", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const service = read("./lead-service.ts");
  assert.match(service, /tombstoneLeadFor\(tx, lead\.id, null, "lead_lost"\)/);
  assert.match(read("../mbos-jobs.ts"), /tombstoneLeadFor\(tx, rows\.map\(\(r\) => r\.id\), null, "lead_archived"\)/);
  const sales = read("../actions/sales.ts");
  assert.equal((sales.match(/"lead_archived"/g) ?? []).length, 4, "archive, restore and their bulk forms");
  assert.equal((sales.match(/syncLeadHolders\(/g) ?? []).length, 2, "reassignLead and bulkReassignLeads");
  assert.match(read("../actions/lead-desk-assignment.ts"), /syncLeadHolders\(tx, lead\.id, holdersBefore\)/);
  assert.match(read("./account-manager-service.ts"), /syncLeadHolders\(tx, row\.id/);
  const mbos = read("./mbos-service.ts");
  assert.match(mbos, /withoutResentLeads\(deletionRows\.groups/);
  assert.match(mbos, /openLeads\(principal\.user\.id, sinceIso, ids\)/);
  assert.match(mbos, /openLeads\(principal\.user\.id, null, \[\], missing\)/);
});

test("the leads delta moves when a distributor approval or agreement does", () => {
  const mbos = readFileSync(new URL("./mbos-service.ts", import.meta.url), "utf8");
  const at = mbos.indexOf("async function openLeads(");
  const body = mbos.slice(at, mbos.indexOf("\n}", at));
  assert.match(body, /au\.updated_at > \$\{since\}/);
  assert.match(body, /mu\.updated_at > \$\{since\}/);
  assert.match(body, /dp\.updated_at > \$\{since\}/);
});
