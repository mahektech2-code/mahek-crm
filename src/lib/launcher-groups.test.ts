import test from "node:test";
import assert from "node:assert/strict";
import { APPS } from "./apps";
import { LAUNCHER_GROUPS, groupApps, roleTone } from "./launcher-groups";

test("every web app is on a launcher shelf", () => {
  const placed = LAUNCHER_GROUPS.flatMap((g) => g.apps);
  for (const app of APPS.filter((a) => !a.mobileOnly && !a.retiredInto)) {
    assert.ok(placed.includes(app.id), `${app.id} is on no shelf`);
  }
});

test("empty groups are dropped and an unplaced app is kept", () => {
  const groups = groupApps([{ id: "crm" as const }, { id: "people" as const }]);
  assert.deepEqual(groups.map((g) => g.id), ["sell", "company"]);
  assert.deepEqual(groups[1].apps.map((a) => a.id), ["people"]);
});

test("the role badge is toned by its word", () => {
  assert.equal(roleTone("Admin"), "admin");
  assert.equal(roleTone("Associate"), "associate");
  assert.equal(roleTone("HR Head"), "manager");
});
