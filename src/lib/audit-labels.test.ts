import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  AUDIT_GROUPS,
  auditGroup,
  describeAudit,
  isDescribed,
  piecesText,
  translate,
  type AuditNames,
} from "./audit-labels";

/* ---------------------------------------------------------------------------
 * EVERY CODE WRITTEN TO THE AUDIT LOG HAS AN ENGLISH SENTENCE.
 *
 * The Admin Console's audit log used to print the codes themselves, and the
 * reason it drifted there is that nothing stopped it: each feature added its
 * own codes and nobody added words. This reads the source the way
 * `timeline-coverage.test.ts` does — through the TypeScript parser rather than
 * a regex, because a code arrives three ways (an `action:` property on an
 * `insert(auditLog)` row, the second argument of one of the helpers called
 * `audit`/`erpAudit`/`hrmsAudit`, or an `action:` inside a helper's options) —
 * and fails on any code that has neither a written sentence nor a translation
 * made entirely of known words.
 * ------------------------------------------------------------------------- */

const ROOT = join(import.meta.dirname, "..");
const HELPERS = new Set(["audit", "erpAudit", "hrmsAudit"]);
const CODE = /^[a-z][a-zA-Z0-9_]*([.\-][a-zA-Z0-9_]+)+$|^[a-z]+$/;

/**
 * The codes a template literal can produce. A template the test does not know
 * fails it, so a new `${...}` code has to be spelled out here — which is the
 * point: the sentence for each value must exist.
 */
const TEMPLATES: Record<string, string[]> = {
  "mbos.approval.${}": ["approved", "rejected", "partially_approved"],
  "mbos.evidence.${}": ["accepted", "declined"],
  "expense.exception_${}": ["accepted", "rejected", "corrected"],
  "expense.day_${}": ["approved", "partially_approved", "rejected"],
  "catalogue.${}": ["formulation", "brand", "good", "category"],
  "catalogue.${}Active": ["formulation", "brand", "good", "category"],
  "erp.request.${}": ["accepted", "rejected"],
  "erp.expense.${}": ["verify", "pending"],
};

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function codesIn(node: ts.Node, out: Set<string>, unknownTemplates: string[]) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    if (CODE.test(node.text)) out.add(node.text);
    return;
  }
  /* `cond ? "a.b" : "a.c"` — the branches are codes, the condition is not. */
  if (ts.isConditionalExpression(node)) {
    codesIn(node.whenTrue, out, unknownTemplates);
    codesIn(node.whenFalse, out, unknownTemplates);
    return;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return;
  if (ts.isTemplateExpression(node)) {
    const shape = node.head.text + node.templateSpans.map((s) => "${}" + s.literal.text).join("");
    const values = TEMPLATES[shape];
    if (!values) unknownTemplates.push(shape);
    else for (const v of values) out.add(shape.replace("${}", v));
    return;
  }
  ts.forEachChild(node, (n) => codesIn(n, out, unknownTemplates));
}

/** Only the `action` property's value, wherever it sits inside `node`. */
function actionProps(node: ts.Node, out: Set<string>, unknownTemplates: string[]) {
  if (ts.isPropertyAssignment(node) && node.name.getText() === "action") {
    codesIn(node.initializer, out, unknownTemplates);
    return;
  }
  ts.forEachChild(node, (n) => actionProps(n, out, unknownTemplates));
}

function writtenCodes(): { codes: string[]; unknownTemplates: string[] } {
  const out = new Set<string>();
  const unknownTemplates: string[] = [];
  for (const f of files(ROOT)) {
    const text = readFileSync(f, "utf8");
    if (!/auditLog|Audit\(|audit\(/.test(text)) continue;
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        /* db.insert(auditLog).values({...}) */
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "values" &&
          ts.isCallExpression(callee.expression) &&
          callee.expression.arguments[0]?.getText() === "auditLog"
        ) {
          n.arguments.forEach((a) => actionProps(a, out, unknownTemplates));
        }
        /* audit(who, "code", …), erpAudit(ctx, "code", …), audit(tx, ctx, { action }) */
        if (ts.isIdentifier(callee) && HELPERS.has(callee.text)) {
          if (n.arguments[1]) codesIn(n.arguments[1], out, unknownTemplates);
          n.arguments.forEach((a) => actionProps(a, out, unknownTemplates));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  /* Constants named rather than spelled at the write. */
  out.add("lead.duplicate.dismissed");
  /* auth.ts passes its sign-in code through a parameter typed as the union. */
  out.add("sign-in");
  out.add("sign-in-code");
  /* Strings that pass the shape test but are not codes: entity types and
     argument values that sit in the second position of a helper. */
  for (const notACode of ["user", "default", "customer"]) out.delete(notACode);
  return { codes: [...out].sort(), unknownTemplates };
}

const NAMES: AuditNames = { users: {}, customers: {}, employees: {}, settings: {} };

test("the source scan finds the codes it should", () => {
  const { codes } = writtenCodes();
  /* A scan that silently found nothing would pass every test below. */
  for (const known of ["payment.reverse", "sign-in", "erp.rawMaterial.create", "hrms.leave.approve", "pricelist.publish"]) {
    assert.ok(codes.includes(known), `scan missed ${known}`);
  }
  assert.ok(codes.length > 300, `only ${codes.length} codes found`);
});

test("every template-built code is spelled out in TEMPLATES", () => {
  assert.deepEqual(writtenCodes().unknownTemplates, []);
});

test("every audited code reads as English", () => {
  const unreadable = writtenCodes()
    .codes.filter((code) => !isDescribed(code))
    .map((code) => ({ code, ...translate(code) }))
    .filter((t) => t.unknown.length > 0)
    .map((t) => `${t.code} (unknown: ${t.unknown.join(", ")})`);
  assert.deepEqual(unreadable, [], "add these words to VERBS/NOUNS or a sentence to DESCRIBE");
});

test("no sentence shows a code, a table name or an id", () => {
  for (const code of writtenCodes().codes) {
    const d = describeAudit(
      { action: code, entityType: "some_table", entityId: "cus_x", before: null, after: null, subjectId: null },
      NAMES,
    );
    const text = piecesText(d.says);
    assert.ok(text.length > 3, `${code} produced no sentence`);
    /* A one-word code ("create") is an English word and may appear in its
       own sentence; a dotted or hyphenated one never may. */
    if (/[.\-]/.test(code)) assert.ok(!text.includes(code), `${code} printed itself: ${text}`);
    assert.ok(!/(usr|cus|emp)_/.test(text), `${code} printed an id: ${text}`);
    assert.ok(!text.includes("some_table"), `${code} printed the table: ${text}`);
  }
});

test("every code lands in a group an owner would look under", () => {
  const strays = writtenCodes().codes.filter((c) => auditGroup(c) === "other");
  assert.deepEqual(strays, []);
});

test("a group is the longest matching prefix, not the first", () => {
  assert.equal(auditGroup("mbos.priceList.set"), "money");
  assert.equal(auditGroup("mbos.journey.propose"), "field");
  assert.equal(auditGroup("whatsapp.rule_update"), "settings");
  assert.equal(auditGroup("whatsapp.sent_api"), "customers");
  assert.equal(auditGroup("sign-in-code-sent"), "signin");
  assert.equal(auditGroup("set-app-access"), "access");
});

test("group slugs are unique", () => {
  const slugs = AUDIT_GROUPS.map((g) => g.slug);
  assert.equal(new Set(slugs).size, slugs.length);
});

test("a payment reversal names the customer and the amount", () => {
  const d = describeAudit(
    {
      action: "payment.reverse",
      entityType: "payment_receipt",
      entityId: "rcp_1",
      before: { status: "confirmed" },
      after: { amount: 2509700, reason: "Wrong entry", status: "reversed" },
      subjectId: "cus_1",
    },
    { ...NAMES, customers: { cus_1: "Colour Camp" } },
  );
  assert.match(piecesText(d.says), /reversed a confirmed payment of ₹25,097 from Colour Camp/);
  assert.equal(d.note, "Wrong entry");
});

test("a setting change says the setting's own label and both values", () => {
  const d = describeAudit(
    {
      action: "config.update",
      entityType: "app_setting",
      entityId: "workingDay.shiftStart",
      before: { value: "09:00" },
      after: { value: "10:30" },
      subjectId: null,
    },
    { ...NAMES, settings: { "workingDay.shiftStart": "Shift start" } },
  );
  assert.equal(piecesText(d.says), "changed the setting Shift start");
  assert.deepEqual(d.changes, [{ field: "Value", from: "09:00", to: "10:30" }]);
});

test("an edit lists what changed in words, without the bookkeeping fields", () => {
  const d = describeAudit(
    {
      action: "customer.update",
      entityType: "customer",
      entityId: "cus_1",
      before: { name: "M V Company", phone: "7021715607" },
      after: { name: "M V Company", phone: "9702033972", creditTermDays: 30, updatedAt: "2026-10-01T00:00:00Z", updatedById: "usr_9" },
      subjectId: null,
    },
    NAMES,
  );
  assert.deepEqual(d.changes, [
    { field: "Phone", from: "7021715607", to: "9702033972" },
    { field: "Credit term (days)", from: "", to: "30" },
  ]);
});

test("an id inside a change becomes a name", () => {
  const d = describeAudit(
    {
      action: "lead.reassigned",
      entityType: "customer",
      entityId: "cus_1",
      before: { ownerId: "usr_a" },
      after: { ownerId: "usr_b" },
      subjectId: null,
    },
    { ...NAMES, users: { usr_a: "Priya", usr_b: "Rakesh" } },
  );
  assert.match(piecesText(d.says), /from Priya to Rakesh/);
});

test("a translated code reads as a sentence", () => {
  assert.equal(translate("erp.rawMaterial.create").says, "added a raw material in the Factory app");
  assert.equal(translate("hrms.leave.approve").says, "approved a leave request in HRMS");
  assert.equal(translate("expense_policy.rule_added").says, "added a rule to the expense policy");
  assert.equal(translate("set-role").says, "set a role");
});

test("the console's audit tabs are exactly the groups", async () => {
  const { ADMIN_TABS } = await import("./admin-routes");
  assert.deepEqual(
    ADMIN_TABS.audit.map((t) => [t.slug, t.label]),
    [["all", "Everything"], ...AUDIT_GROUPS.map((g) => [g.slug, g.label])],
  );
});

test("the access screen's shorthand is said in words, numbers kept", async () => {
  const { accessWords } = await import("./audit-labels");
  assert.equal(accessWords("changed crm 17/30 → 18/30"), "Telecaller CRM: now 18 of 30 screens (was 17)");
  assert.equal(accessWords("granted sales (26/26 modules)"), "Gave Sales Dashboard (all 26 screens)");
  assert.equal(accessWords("revoked crm, hrms"), "Took away Telecaller CRM, HRMS");
  assert.equal(
    accessWords("Bharat Singh · EMP-5368 · associate · field (1/1)"),
    "Bharat Singh · EMP-5368 · associate in Salesman App",
  );
});
