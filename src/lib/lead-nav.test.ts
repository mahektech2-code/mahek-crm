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
  it("the CRM keeps five, in the order the work happens", () => {
    assert.deepEqual(
      crmItems().filter((i) => !i.legacy).map((i) => i.label),
      ["All Leads", "Add a lead", "Calling desk", "Sales Manager", "Lost"],
    );
  });

  it("the Sales Dashboard keeps the same, minus the two that are the CRM's own", () => {
    assert.deepEqual(
      salesItems().filter((i) => !i.legacy).map((i) => i.label),
      ["All Leads", "Add a lead", "Sales Manager"],
    );
    assert.ok(!salesItems().some((i) => i.label === "Calling desk" || i.label === "Lost"));
  });

  it("the rows that stay are the same set in both apps, apart from those two", () => {
    const strip = (labels: string[]) => labels.filter((l) => l !== "Calling desk" && l !== "Lost");
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

describe("the CRM draws Leads as a group of desks", () => {
  const all = crmItems().map((i) => i.href);
  const leadsRows = (allowed: string[]) =>
    navForModules(allowed)
      .filter((g) => g.label === "Leads")
      .flatMap((g) => g.items);

  it("whoever holds the whole CRM gets a row per desk, My day first", () => {
    const rows = leadsRows(all);
    assert.deepEqual(rows.map((r) => r.label), [
      "My day", "All leads", "Calling desk", "Sales Manager desk", "Verify & qualify",
      "Samples & trials", "Negotiation", "Handovers", "Lead reports",
    ]);
    assert.equal(rows[0].href, "/crm/leads/dashboard");
    for (const gone of ["Add a lead", "Oversight", "Lead control", "Distributors", "Follow-ups"]) {
      assert.ok(!rows.some((r) => r.label === gone), `${gone} is not in the sidebar`);
    }
  });

  it("whoever holds one section alone still has a door, onto that section", () => {
    assert.equal(leadsRows(["/crm/samples"])[0].href, "/crm/samples/desk");
    assert.equal(leadsRows(["/crm/leads/oversight"])[0].href, "/crm/leads/oversight");
    assert.equal(leadsRows(["/crm/leads/lost"])[0].href, "/crm/leads/lost");
  });

  it("nobody holding a lead module gets no row", () => {
    assert.equal(leadsRows(["/crm/customers"]).length, 0);
  });

  it("a desk's row lights on every screen of the desk", () => {
    const reports = leadsRows(all).find((r) => r.label === "Lead reports")!;
    assert.ok(reports.match?.includes("/crm/samples/feedback"));
    assert.ok(reports.match?.includes("/crm/leads/qualify/validation"));
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
