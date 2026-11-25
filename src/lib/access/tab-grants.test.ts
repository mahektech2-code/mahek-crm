/**
 * Tabs as grants — the third level of Manage access (`tab-grants.ts`), pure.
 *
 *   npm run test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyGrant, holdsTab, normaliseGrant, setAccess, setModule, setTab, type AppGrantDraft } from "./permission-rules";
import { moduleShape } from "./screen-permissions";
import { legacyFromScreens } from "./legacy-from-screens";
import { PAGE_TABS, tabsHeld, tabsOfPage, withheldViews } from "./tab-grants";

const shape = moduleShape("erp");
/* Supplier returns: three tabs, and the page's own key is also its first tab's
   (Purchase returns) — the shape that tests "the page still opens". The names
   below say what each stands for in these tests. */
const PAGE = "erp.vendorReturns";
const KEPT = "erp.vendorReturns.debitNotes";
const OWN = "erp.vendorReturns.vendorReturns";
const OTHER = "erp.vendorReturns.returnOutwards";
const MODULE = "ERP · Material returns";

function withReturns(): AppGrantDraft {
  return setModule(emptyGrant("associate"), shape, MODULE, true);
}

test("every built ERP page with tabs is listed, its tabs in the page's own order", () => {
  assert.deepEqual(
    tabsOfPage(PAGE).map((t) => t.key),
    [OWN, KEPT, OTHER],
  );
  assert.ok(PAGE_TABS.has("erp.transport") && PAGE_TABS.has("erp.expenses"), "Logistics and Petty Cash too");
  assert.equal(tabsOfPage("erp.requisitions").length, 0, "a page of one list has no tabs to grant");
});

test("a page given holds every tab, with no tab entries stored", () => {
  const g = withReturns();
  assert.ok(g.screens.has(PAGE));
  assert.deepEqual(tabsHeld(g.screens, PAGE), [OWN, KEPT, OTHER]);
  assert.ok(![...g.screens.keys()].some((k) => k.startsWith(`${PAGE}.`)), "no rows means every tab");
});

test("unticking a tab lists the rest; ticking it back returns to no entries", () => {
  let g = setTab(withReturns(), shape, OWN, false);
  assert.equal(holdsTab(g, OWN), false);
  assert.equal(holdsTab(g, KEPT), true);
  assert.deepEqual([...g.screens.keys()].filter((k) => k.startsWith(`${PAGE}.`)).sort(), [OTHER, KEPT].sort());
  g = setTab(g, shape, OWN, true);
  assert.ok(![...g.screens.keys()].some((k) => k.startsWith(`${PAGE}.`)), "every tab ticked is stored as none");
});

test("the last tab unticked takes the page away; a tab cannot be given without its page", () => {
  let g = withReturns();
  g = setTab(g, shape, OWN, false);
  g = setTab(g, shape, OTHER, false);
  g = setTab(g, shape, KEPT, false);
  assert.equal(g.screens.has(PAGE), false);
  assert.ok(![...g.screens.keys()].some((k) => k.startsWith(`${PAGE}.`)));
  assert.equal(setTab(g, shape, KEPT, true), g, "refused while the page is not held");
});

test("taking the page or its module away takes its tab entries", () => {
  const narrowed = setTab(withReturns(), shape, OWN, false);
  const noPage = setAccess(narrowed, shape, PAGE, false);
  assert.ok(![...noPage.screens.keys()].some((k) => k.startsWith(`${PAGE}.`)));
  const noModule = setModule(narrowed, shape, MODULE, false);
  assert.ok(![...noModule.screens.keys()].some((k) => k.startsWith(`${PAGE}.`)));
});

test("the server's normalising keeps tabs under a held page only, without ticks, and folds 'all' to none", () => {
  const sent: AppGrantDraft = {
    position: "associate",
    modules: new Set([MODULE]),
    screens: new Map([
      [PAGE, { edit: true, delete: false, autoEdit: false }],
      [KEPT, { edit: true, delete: true, autoEdit: false }],
      ["erp.transport.delivered", { edit: false, delete: false, autoEdit: false }],
      ["erp.not-a-tab", { edit: false, delete: false, autoEdit: false }],
    ]),
  };
  const g = normaliseGrant(sent, shape);
  assert.deepEqual(g.screens.get(KEPT), { edit: false, delete: false, autoEdit: false }, "a tab is Access only");
  assert.equal(g.screens.has("erp.transport.delivered"), false, "its page is not held");
  assert.equal(g.screens.has("erp.not-a-tab"), false);
  const all = normaliseGrant({ ...sent, screens: new Map([...sent.screens, [OWN, sent.screens.get(KEPT)!], [OTHER, sent.screens.get(KEPT)!]]) }, shape);
  assert.ok(![...all.screens.keys()].some((k) => k.startsWith(`${PAGE}.`)), "every tab listed is the same as none");
  assert.deepEqual(normaliseGrant(g, shape), g, "running it twice changes nothing");
});

test("tabs never reach app_module_access, and powers still come from the page", () => {
  let g = setTab(withReturns(), shape, OWN, false);
  g = { ...g, screens: new Map(g.screens).set(PAGE, { edit: true, delete: false, autoEdit: false }) };
  const legacy = legacyFromScreens("erp", g);
  assert.ok(legacy.modules.includes(PAGE));
  assert.ok(!legacy.modules.some((m) => m.startsWith(`${PAGE}.`)));
  assert.ok(legacy.powers?.includes("returnApprove"), "Edit on the page still carries its power");
});

test("the ERP withholds exactly the unticked tabs' keys — and nothing where no tab is listed", () => {
  const pages = new Set(["vendorReturns", "transport"]);
  assert.equal(withheldViews(pages, new Set()).size, 0);
  const w = withheldViews(pages, new Set([KEPT]));
  assert.deepEqual([...w].sort(), ["returnOutwards", "vendorReturns"]);
  assert.equal(w.has("debitNotes"), false);
  const stock = withheldViews(new Set(["stock"]), new Set(["erp.stock.rmStock"]));
  assert.ok(stock.has("sfgStock") && stock.has("sfgLog"), "a withheld tab takes its 'show every entry' toggle with it");
  assert.ok(!stock.has("rmStock") && !stock.has("rmLog"));
  assert.equal(withheldViews(new Set(), new Set([KEPT])).size, 0, "rows under a page not held withhold nothing");
});
