import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  commitIsInBuild,
  fixActions,
  fixStage,
  isCommitBuild,
  issueBody,
  readMarker,
  redact,
  routeHint,
  type FixState,
} from "./feedback-fix";

const base: FixState = { need: null, issueNumber: null, aiFixRequestedAt: null, prState: null, deployedAt: null };

describe("feedback fix — what goes to GitHub", () => {
  test("phones, emails, GSTIN, PAN and Aadhaar are taken out; names stay", () => {
    const out = redact(
      "Shree Ganesh Paints (ram@shop.in, 98200 11001, +91 9820011001) GST 27AAPFU0939F1ZV PAN ABCDE1234F aadhaar 1234 5678 9012",
    );
    assert.match(out, /Shree Ganesh Paints/);
    assert.doesNotMatch(out, /ram@shop\.in|9820011001|98200 11001|27AAPFU0939F1ZV|ABCDE1234F|1234 5678 9012/);
    assert.match(out, /\[email\]/);
    assert.match(out, /\[phone\]/);
    assert.match(out, /\[GSTIN\]/);
  });

  test("a route hint keeps the route and hides record ids", () => {
    assert.equal(routeHint("/crm/customers/cus_ab12cd34ef/edit?tab=1"), "src/app/crm/customers/[…]/edit/page.tsx");
    assert.equal(routeHint("/erp/orders"), "src/app/erp/orders/page.tsx");
    assert.equal(routeHint(null), null);
  });

  test("the issue carries the marker the PR is matched back on, and the instructions", () => {
    const body = issueBody({
      ref: "FB-1042",
      rowId: "fb_abc123",
      kind: "Bug",
      impact: "can't work",
      app: "CRM",
      path: "/crm/queue",
      title: "Save does nothing",
      body: "Call Priya on 9820011001 — save spins forever",
      byName: "Priya Sharma",
      sentOn: "12 Nov 2026",
      browser: "Chrome on Windows",
      also: [],
      thread: [],
      screenshots: 2,
      diagnosis: null,
      consoleUrl: null,
    });
    assert.deepEqual(readMarker(body), { ref: "FB-1042", rowId: "fb_abc123" });
    assert.match(body, /Feedback: FB-1042/);
    assert.match(body, /Fixes #/);
    assert.doesNotMatch(body, /9820011001/);
  });
});

describe("feedback fix — what is offered", () => {
  test("only a code change can go to GitHub or Claude", () => {
    for (const need of ["data_fix", "setting", "access", "how_to", "not_a_fault"] as const) {
      const a = fixActions({ ...base, need }, { platformAdmin: true, connected: true });
      assert.equal(a.sendToDeveloper, false, need);
      assert.equal(a.askClaude, false, need);
    }
    const code = fixActions({ ...base, need: "code_change" }, { platformAdmin: true, connected: true });
    assert.equal(code.sendToDeveloper, true);
    assert.equal(code.askClaude, true);
  });

  test("only a platform administrator may ask Claude, and the refusal says so", () => {
    const a = fixActions({ ...base, need: "code_change" }, { platformAdmin: false, connected: true });
    assert.equal(a.askClaude, false);
    assert.equal(a.sendToDeveloper, true);
    assert.match(a.askClaudeWhyNot ?? "", /platform administrator/);
  });

  test("nothing GitHub without a token, and nothing twice", () => {
    const off = fixActions({ ...base, need: "code_change" }, { platformAdmin: true, connected: false });
    assert.equal(off.sendToDeveloper || off.askClaude, false);
    const asked = fixActions({ ...base, need: "code_change", issueNumber: 3, aiFixRequestedAt: "x" }, { platformAdmin: true, connected: true });
    assert.equal(asked.sendToDeveloper || asked.askClaude, false);
  });

  test("the stage reads the furthest step reached", () => {
    assert.equal(fixStage(null), "none");
    assert.equal(fixStage({ ...base, need: "access" }), "team");
    assert.equal(fixStage({ ...base, need: "code_change" }), "read");
    assert.equal(fixStage({ ...base, need: "code_change", issueNumber: 1 }), "issue");
    assert.equal(fixStage({ ...base, need: "code_change", issueNumber: 1, prState: "merged" }), "merged");
    assert.equal(fixStage({ ...base, need: "code_change", issueNumber: 1, prState: "merged", deployedAt: "x" }), "live");
  });

  test("a merge is live only when the serving build contains it", () => {
    assert.equal(commitIsInBuild("ahead"), true);
    assert.equal(commitIsInBuild("identical"), true);
    assert.equal(commitIsInBuild("behind"), false);
    assert.equal(commitIsInBuild("diverged"), false);
    assert.equal(isCommitBuild("dev"), false);
    assert.equal(isCommitBuild("97d96bf0a1"), true);
  });
});
