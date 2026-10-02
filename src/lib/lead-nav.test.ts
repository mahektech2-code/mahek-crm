/**
 * THE SIMPLIFIED LEAD MANAGEMENT NAVIGATION — pinned, in both apps.
 *
 * Seven sections left the main navigation and nothing else changed: they are
 * still modules, routes and grants. What these tests keep true is that the two
 * apps cannot end up with two different Lead Management structures, that no
 * section is hidden from somebody whose grant is for that section alone, and
 * that the sections which left are exactly the ones the shared list names.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { NAV, navForModules } from "@/components/shell/nav";
import { SALES_NAV } from "@/app/sales/nav";
import {
  LEAD_SECTIONS,
  NAV_RETIRED_SLUGS,
  OTHER_DESK_SLUGS,
  leadHref,
  leadSection,
} from "@/lib/lead-workspace";

const lead = (label: string) => NAV.find((g) => g.label === "Lead Management")!.items.filter((i) => label === "*" || i.label === label);
const crmItems = () => NAV.find((g) => g.label === "Lead Management")!.items;
const salesItems = () => SALES_NAV.find((g) => g.label === "Lead Management")!.items;

describe("what stays in the main navigation", () => {
  it("the CRM keeps six, in the order the work happens", () => {
    assert.deepEqual(
      crmItems().filter((i) => !i.legacy).map((i) => i.label),
      ["All Leads", "Intake", "Telecaller", "Sales Manager", "Distributor appointments", "Lost"],
    );
  });

  it("the Sales Dashboard keeps the same, minus the two that are the CRM's own", () => {
    assert.deepEqual(
      salesItems().filter((i) => !i.legacy).map((i) => i.label),
      ["All Leads", "Intake", "Sales Manager", "Distributor appointments"],
    );
    assert.ok(!salesItems().some((i) => i.label === "Telecaller" || i.label === "Lost"));
  });

  it("the rows that stay are the same set in both apps, apart from those two", () => {
    const strip = (labels: string[]) => labels.filter((l) => l !== "Telecaller" && l !== "Lost");
    assert.deepEqual(
      strip(crmItems().filter((i) => !i.legacy).map((i) => i.label)).sort(),
      salesItems().filter((i) => !i.legacy).map((i) => i.label).sort(),
    );
  });
});

describe("what left, and that it is one list", () => {
  it("both apps hide exactly the sections the shared list names, and no others", () => {
    const want = NAV_RETIRED_SLUGS.map((s) => leadSection(s)!.path).sort();
    const crm = crmItems().filter((i) => i.legacy).map((i) => i.href.replace(/^\/crm\//, "")).sort();
    const sales = salesItems().filter((i) => i.legacy).map((i) => i.href.replace(/^\/sales\//, "")).sort();
    assert.deepEqual(crm, want, "CRM");
    assert.deepEqual(sales, want, "Sales Dashboard");
  });

  it("every retired slug is a real shared section — a typo would hide nothing and say nothing", () => {
    for (const slug of NAV_RETIRED_SLUGS) assert.ok(LEAD_SECTIONS.some((s) => s.slug === slug), slug);
  });

  it("Oversight is retired but is not offered as an operational desk", () => {
    assert.ok((NAV_RETIRED_SLUGS as readonly string[]).includes("lead-oversight"));
    assert.ok(!(OTHER_DESK_SLUGS as readonly string[]).includes("lead-oversight"));
    assert.equal(OTHER_DESK_SLUGS.length, NAV_RETIRED_SLUGS.length - 1);
  });

  it("nothing a section needs was removed: every shared section still has its route and tabs", () => {
    for (const slug of NAV_RETIRED_SLUGS) {
      const s = leadSection(slug)!;
      assert.ok(s.tabs.length >= 1, slug);
      assert.equal(leadHref("crm", s.path), `/crm/${s.path}`);
    }
  });
});

describe("hiding a row does not strand somebody", () => {
  const all = crmItems().map((i) => i.href);

  it("whoever holds All Leads sees only the six", () => {
    const labels = navForModules(all).flatMap((g) => g.items.map((i) => i.label));
    assert.ok(labels.includes("All Leads"));
    for (const hidden of ["Qualification", "Samples & trials", "Commercial", "Next actions & nurture", "Handovers", "Funnel & conversion", "Oversight"]) {
      assert.ok(!labels.includes(hidden), `${hidden} is not in the sidebar`);
    }
  });

  it("whoever holds a retired section and NOT All Leads still has their door", () => {
    const only = ["/crm/samples", "/crm/leads/qualify", "/crm/leads/oversight"];
    const labels = navForModules(only).flatMap((g) => g.items.map((i) => i.label));
    assert.deepEqual(labels.sort(), ["Oversight", "Qualification", "Samples & trials"].sort());
  });

  it("a kept row is never hidden by the rule", () => {
    const labels = navForModules(["/crm/leads/lost", "/crm/leads/sales-manager"]).flatMap((g) => g.items.map((i) => i.label));
    assert.deepEqual(labels.sort(), ["Lost", "Sales Manager"]);
  });
});

describe("the one lead badge", () => {
  it("All Leads carries it, and the row that used to carry the red one is gone from the badge list", () => {
    const hub = crmItems().find((i) => i.label === "All Leads")!;
    assert.equal(hub.badge, "leadsAttention");
    assert.ok(!crmItems().some((i) => i.badge === "leadsOverdue" || i.badge === "leadsDueToday"));
    assert.equal(lead("*").length, crmItems().length);
  });
});
