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
const PURCHASES = "erp.register";
const GRN = "erp.register.inward";
const REGISTER = "erp.register.register";
const LABELS = "erp.register.barcode";

function withPurchase(): AppGrantDraft {
  return setModule(emptyGrant("associate"), shape, "ERP · Purchase", true);
}

test("every built ERP page with tabs is listed, its tabs in the page's own order", () => {
  assert.deepEqual(
    tabsOfPage(PURCHASES).map((t) => t.key),
    [GRN, REGISTER, LABELS],
  );
  assert.ok(PAGE_TABS.has("erp.transport") && PAGE_TABS.has("erp.expenses"), "Logistics and Petty Cash too");
  assert.equal(tabsOfPage("erp.requisitions").length, 0, "a page of one list has no tabs to grant");
});

test("a page given holds every tab, with no tab entries stored", () => {
  const g = withPurchase();
  assert.ok(g.screens.has(PURCHASES));
  assert.deepEqual(tabsHeld(g.screens, PURCHASES), [GRN, REGISTER, LABELS]);
  assert.ok(![...g.screens.keys()].some((k) => k.startsWith(`${PURCHASES}.`)), "no rows means every tab");
});

test("unticking a tab lists the rest; ticking it back returns to no entries", () => {
  let g = setTab(withPurchase(), shape, REGISTER, false);
  assert.equal(holdsTab(g, REGISTER), false);
  assert.equal(holdsTab(g, GRN), true);
  assert.deepEqual([...g.screens.keys()].filter((k) => k.startsWith(`${PURCHASES}.`)).sort(), [LABELS, GRN].sort());
  g = setTab(g, shape, REGISTER, true);
  assert.ok(![...g.screens.keys()].some((k) => k.startsWith(`${PURCHASES}.`)), "every tab ticked is stored as none");
});

test("the last tab unticked takes the page away; a tab cannot be given without its page", () => {
  let g = withPurchase();
  g = setTab(g, shape, REGISTER, false);
  g = setTab(g, shape, LABELS, false);
  g = setTab(g, shape, GRN, false);
  assert.equal(g.screens.has(PURCHASES), false);
  assert.ok(![...g.screens.keys()].some((k) => k.startsWith(`${PURCHASES}.`)));
  assert.equal(setTab(g, shape, GRN, true), g, "refused while the page is not held");
});

test("taking the page or its module away takes its tab entries", () => {
  const narrowed = setTab(withPurchase(), shape, REGISTER, false);
  const noPage = setAccess(narrowed, shape, PURCHASES, false);
  assert.ok(![...noPage.screens.keys()].some((k) => k.startsWith(`${PURCHASES}.`)));
  const noModule = setModule(narrowed, shape, "ERP · Purchase", false);
  assert.ok(![...noModule.screens.keys()].some((k) => k.startsWith(`${PURCHASES}.`)));
});

test("the server's normalising keeps tabs under a held page only, without ticks, and folds 'all' to none", () => {
  const sent: AppGrantDraft = {
    position: "associate",
    modules: new Set(["ERP · Purchase"]),
    screens: new Map([
      [PURCHASES, { edit: true, delete: false, autoEdit: false }],
      [GRN, { edit: true, delete: true, autoEdit: false }],
      ["erp.transport.delivered", { edit: false, delete: false, autoEdit: false }],
      ["erp.not-a-tab", { edit: false, delete: false, autoEdit: false }],
    ]),
  };
  const g = normaliseGrant(sent, shape);
  assert.deepEqual(g.screens.get(GRN), { edit: false, delete: false, autoEdit: false }, "a tab is Access only");
  assert.equal(g.screens.has("erp.transport.delivered"), false, "its page is not held");
  assert.equal(g.screens.has("erp.not-a-tab"), false);
  const all = normaliseGrant({ ...sent, screens: new Map([...sent.screens, [REGISTER, sent.screens.get(GRN)!], [LABELS, sent.screens.get(GRN)!]]) }, shape);
  assert.ok(![...all.screens.keys()].some((k) => k.startsWith(`${PURCHASES}.`)), "every tab listed is the same as none");
  assert.deepEqual(normaliseGrant(g, shape), g, "running it twice changes nothing");
});

test("tabs never reach app_module_access, and powers still come from the page", () => {
  let g = setTab(withPurchase(), shape, REGISTER, false);
  g = { ...g, screens: new Map(g.screens).set(PURCHASES, { edit: true, delete: false, autoEdit: false }) };
  const legacy = legacyFromScreens("erp", g);
  assert.ok(legacy.modules.includes(PURCHASES));
  assert.ok(!legacy.modules.some((m) => m.startsWith(`${PURCHASES}.`)));
  assert.ok(legacy.powers?.includes("viewPurchaseMoney"), "Edit on Purchases still carries purchase money");
});

test("the ERP withholds exactly the unticked tabs' keys — and nothing where no tab is listed", () => {
  const pages = new Set(["register", "transport"]);
  assert.equal(withheldViews(pages, new Set()).size, 0);
  const w = withheldViews(pages, new Set([GRN]));
  assert.deepEqual([...w].sort(), ["barcode", "register"]);
  assert.equal(w.has("inward"), false);
  const stock = withheldViews(new Set(["stock"]), new Set(["erp.stock.rmStock"]));
  assert.ok(stock.has("sfgStock") && stock.has("sfgLog"), "a withheld tab takes its 'show every entry' toggle with it");
  assert.ok(!stock.has("rmStock") && !stock.has("rmLog"));
  assert.equal(withheldViews(new Set(), new Set([GRN])).size, 0, "rows under a page not held withhold nothing");
});
