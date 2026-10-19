import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { APP_MODULES } from "@/lib/modules";
import { HUB_AREAS, allHubLinks, hubFor, hubHref, hubLanding, hubPlace } from "@/lib/lead-hub";

const crmLeadModules = APP_MODULES.filter(
  (m) =>
    m.app === "crm" &&
    !m.writeOf &&
    (m.href.startsWith("/crm/leads") || m.href.startsWith("/crm/samples")),
);

describe("the Leads frame covers every lead module and invents none", () => {
  it("every link names a real CRM module whose route it sits inside", () => {
    for (const l of allHubLinks()) {
      const mod = APP_MODULES.find((m) => m.key === l.module);
      assert.ok(mod, `${l.path} names ${l.module}`);
      const href = hubHref(l.path);
      assert.ok(
        href === mod!.href || href.startsWith(mod!.href + "/"),
        `${l.path} is inside ${mod!.href}`,
      );
    }
  });

  it("every CRM lead module has at least one link", () => {
    const named = new Set(allHubLinks().map((l) => l.module));
    for (const m of crmLeadModules) assert.ok(named.has(m.key), m.key);
  });

  it("no path is listed twice", () => {
    const paths = allHubLinks().map((l) => l.path);
    assert.equal(new Set(paths).size, paths.length);
  });
});

describe("what a person sees", () => {
  it("only what they hold", () => {
    const areas = hubFor(new Set(["crm.samples"]));
    assert.deepEqual(
      areas.map((a) => a.key),
      ["pipeline", "insights"],
    );
    assert.equal(hubLanding(new Set(["crm.samples"])), "/crm/samples/desk");
    assert.equal(hubLanding(new Set()), null);
  });

  it("a record sits in its desk with no tab lit", () => {
    const all = hubFor(new Set(APP_MODULES.map((m) => m.key)));
    const lead = hubPlace(all, "/crm/leads/cus_1");
    assert.equal(lead?.desk.key, "book");
    assert.equal(lead?.link, null);
    const sample = hubPlace(all, "/crm/samples/smp_1");
    assert.equal(sample?.desk.key, "samples");
    const tab = hubPlace(all, "/crm/leads/actions/overdue");
    assert.equal(tab?.area.key, "today");
    assert.equal(tab?.link?.label, "Overdue");
    assert.equal(hubPlace(all, "/crm/leads/actions/nurture")?.area.key, "insights");
  });

  it("four areas, in the order the work happens", () => {
    assert.deepEqual(
      HUB_AREAS.map((a) => a.label),
      ["Today", "Leads", "Pipeline", "Insights"],
    );
  });
});
