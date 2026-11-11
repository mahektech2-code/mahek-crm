import { test } from "node:test";
import assert from "node:assert/strict";
import { audienceChoices, audienceProblems, audienceWords, readAudience, resolveAudience, type Audience, type AudienceKind, type AudiencePerson } from "./audience";
import { closeProblems } from "./rules";

/*
 * Vikram runs sales; Rahul is a team lead under him with Priya and Rakesh;
 * Anjali reports straight to Vikram. Priya and Anjali are Telecallers.
 */
const p = (id: string, name: string, extra: Partial<AudiencePerson> = {}): AudiencePerson => ({
  id,
  name,
  level: "associate",
  designation: null,
  department: "Sales",
  erpDesignation: null,
  managers: ["vikram"],
  ...extra,
});
const people = [
  p("rahul", "Rahul Mehta", { designation: "Team Lead", level: "manager" }),
  p("priya", "Priya Sharma", { designation: "Telecaller", managers: ["rahul", "vikram"] }),
  p("rakesh", "Rakesh Iyer", { designation: "Field Sales", managers: ["rahul", "vikram"] }),
  p("anjali", "Anjali Rao", { designation: "telecaller" }),
  p("deepa", "Deepa Menon", { department: "Accounts", designation: "Accountant" }),
];
const ids = (a: Audience) => resolveAudience(a, people).ids;
const rule = (kind: AudienceKind, value: string) => ({ kind, value, label: value });

test("a designation reaches everybody holding it, whatever the spelling's case", () => {
  assert.deepEqual(ids({ include: [rule("designation", "Telecaller")], exclude: [] }), ["anjali", "priya"]);
});

test("a team is everybody under that manager, at any depth, and not the manager", () => {
  assert.deepEqual(ids({ include: [rule("team", "rahul")], exclude: [] }), ["priya", "rakesh"]);
  assert.deepEqual(ids({ include: [rule("team", "vikram")], exclude: [] }).length, 5);
});

test("include a team, exclude one person", () => {
  assert.deepEqual(ids({ include: [rule("team", "rahul")], exclude: [rule("person", "rakesh")] }), ["priya"]);
});

test("exclude a whole team, but include one person in it by name — the person wins", () => {
  const a: Audience = { include: [rule("department", "Sales"), rule("person", "priya")], exclude: [rule("team", "rahul")] };
  assert.deepEqual(ids(a), ["anjali", "priya", "rahul"]);
  assert.equal(resolveAudience(a, people).why.get("priya")?.because, "Included by name");
  assert.match(resolveAudience(a, people).why.get("rakesh")?.because ?? "", /^Excluded/);
});

test("a person excluded by name never gets it, even if a group and their name include them", () => {
  assert.deepEqual(ids({ include: [rule("everyone", "*")], exclude: [rule("person", "deepa")] }).includes("deepa"), false);
});

test("a role and a level combine: every manager, except Rahul's own reports", () => {
  assert.deepEqual(ids({ include: [rule("level", "manager"), rule("designation", "Telecaller")], exclude: [rule("team", "rahul")] }), ["anjali", "rahul"]);
});

test("nobody outside the candidates is ever reached", () => {
  assert.deepEqual(ids({ include: [rule("person", "a-stranger")], exclude: [] }), []);
});

test("an audience must include somebody, and a rule cannot be on both lists", () => {
  assert.equal(audienceProblems({ include: [], exclude: [] })[0].field, "audience");
  assert.match(audienceProblems({ include: [rule("team", "rahul")], exclude: [rule("team", "rahul")] })[0].message, /both included and excluded/);
  assert.deepEqual(audienceProblems({ include: [rule("team", "rahul")], exclude: [] }), []);
});

test("the choices are read off the people, with counts", () => {
  const c = audienceChoices(people, new Map([["vikram", "Vikram Shah"], ["rahul", "Rahul Mehta"]]));
  assert.deepEqual(c.designation.find((d) => d.label.toLowerCase() === "telecaller")?.count, 2);
  assert.deepEqual(c.team.map((t) => t.label), ["Everyone under Vikram Shah", "Everyone under Rahul Mehta"]);
  assert.deepEqual(c.level.map((l) => l.value).sort(), ["associate", "manager"]);
});

test("stored rules read back, and junk is dropped", () => {
  assert.deepEqual(readAudience({ include: [{ kind: "team", value: "rahul", label: "Everyone under Rahul" }, { kind: "nope" }], exclude: "x" }), {
    include: [{ kind: "team", value: "rahul", label: "Everyone under Rahul" }],
    exclude: [],
  });
  assert.equal(readAudience(null), null);
  assert.equal(audienceWords({ include: [rule("team", "Rahul's team")], exclude: [rule("person", "Rakesh")] }), "Rahul's team — except Rakesh");
});

test("a remark can be made optional by the creator; the confirmation never can", () => {
  assert.deepEqual(closeProblems({ confirmed: true, remark: "", proofs: 0, proofRequired: false, remarkRequired: false }), []);
  assert.equal(closeProblems({ confirmed: true, remark: "", proofs: 0, proofRequired: false })[0].field, "remark");
  assert.equal(closeProblems({ confirmed: false, remark: "", proofs: 0, proofRequired: false, remarkRequired: false })[0].field, "confirmed");
});
