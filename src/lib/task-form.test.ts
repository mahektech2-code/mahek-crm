import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cleanTaskAnswers,
  summariseTaskField,
  TASK_FORM_TEMPLATES,
  taskAnswerPhotoIds,
  taskAnswerProblems,
  taskAnswersNote,
  taskFormProblems,
  tidyPhone,
  tidyTaskForm,
  visibleTaskFields,
  type TaskField,
} from "./task-form";
import { expandTaskAudience, taskAudienceProblem } from "./task-audience";

const stock = TASK_FORM_TEMPLATES.find((t) => t.key === "stock_check")!.fields;

test("every template is a form the builder would accept", () => {
  for (const t of TASK_FORM_TEMPLATES) assert.deepEqual(taskFormProblems(t.fields), [], t.key);
});

test("a follow-up shows only for the answer it hangs off", () => {
  const ids = (a: Record<string, unknown>) => visibleTaskFields(stock, a as never).map((f) => f.id);
  assert.deepEqual(ids({}), ["stocks", "shelf"]);
  assert.deepEqual(ids({ stocks: true }), ["stocks", "products", "cans", "shelf"]);
  assert.deepEqual(ids({ stocks: false }), ["stocks", "why_not", "shelf"]);
});

test("a field hangs off a hidden parent is hidden too", () => {
  const form: TaskField[] = [
    { id: "a", type: "yes_no", label: "A", required: true },
    { id: "b", type: "single_choice", label: "B", options: ["x", "y"], showIf: { field: "a", op: "is", value: "yes" } },
    { id: "c", type: "short_text", label: "C", showIf: { field: "b", op: "is", value: "x" } },
  ];
  assert.deepEqual(visibleTaskFields(form, { a: false, b: "x" }).map((f) => f.id), ["a"]);
  assert.deepEqual(visibleTaskFields(form, { a: true, b: "x" }).map((f) => f.id), ["a", "b", "c"]);
});

test("includes reads a multi-pick; is_not holds while unanswered", () => {
  const form: TaskField[] = [
    { id: "m", type: "multi_choice", label: "M", options: ["p", "q"] },
    { id: "n", type: "short_text", label: "N", showIf: { field: "m", op: "includes", value: "q" } },
    { id: "o", type: "short_text", label: "O", showIf: { field: "m", op: "is_not", value: "p" } },
  ];
  assert.deepEqual(visibleTaskFields(form, {}).map((f) => f.id), ["m", "o"]);
  assert.deepEqual(visibleTaskFields(form, { m: ["p", "q"] }).map((f) => f.id), ["m", "n"]);
});

test("only what is owed and showing is asked for", () => {
  assert.deepEqual(
    taskAnswerProblems(stock, { stocks: false }).map((p) => p.fieldId),
    ["why_not"],
  );
  assert.deepEqual(taskAnswerProblems(stock, { stocks: false, why_not: "Buys from Berger" }), []);
  assert.deepEqual(
    taskAnswerProblems(stock, { stocks: true, products: ["Nano Thinner"], cans: -3 }).map((p) => p.fieldId),
    ["cans"],
  );
});

test("a birthday must be a day the month has, and has no year", () => {
  const f: TaskField[] = [{ id: "b", type: "birthday", label: "B", required: true }];
  assert.equal(taskAnswerProblems(f, { b: { day: 29, month: 2 } }).length, 0);
  assert.equal(taskAnswerProblems(f, { b: { day: 31, month: 4 } }).length, 1);
  assert.equal(taskAnswerProblems(f, { b: { day: 0, month: 4 } }).length, 1);
});

test("a phone is ten digits once the country is taken off", () => {
  assert.equal(tidyPhone("+91 98200 11001"), "9820011001");
  assert.equal(tidyPhone("09820011001"), "9820011001");
  const f: TaskField[] = [{ id: "p", type: "phone", label: "P", required: true }];
  assert.equal(taskAnswerProblems(f, { p: "12345" }).length, 1);
  assert.deepEqual(cleanTaskAnswers(f, { p: "+91-98200-11001" }), { p: "9820011001" });
});

test("cleaning drops hidden, unknown and ill-shaped answers", () => {
  const cleaned = cleanTaskAnswers(stock, {
    stocks: false,
    products: ["Nano Thinner"], // hidden by stocks = no
    why_not: "  Too costly  ",
    shelf: ["m1", "m2", "m3", "m4"], // more than the max of 3
    nonsense: "x",
  });
  assert.deepEqual(cleaned, { stocks: false, why_not: "Too costly", shelf: ["m1", "m2", "m3"] });
  assert.deepEqual(taskAnswerPhotoIds(stock, cleaned), ["m1", "m2", "m3"]);
  assert.deepEqual(cleanTaskAnswers(stock, "not an object"), {});
  assert.deepEqual(cleanTaskAnswers(stock, { stocks: "yes please" }), {});
});

test("the answers read back as a note, one line a question", () => {
  const note = taskAnswersNote(stock, { stocks: true, products: ["Nano Thinner", "PU Thinner"], cans: 12 });
  assert.equal(
    note,
    "Do they stock our products?: Yes\nWhich ones are on the shelf?: Nano Thinner, PU Thinner\nRoughly how many cans in all?: 12 cans",
  );
});

test("the builder refuses what no salesman could answer", () => {
  const bad: TaskField[] = [
    { id: "a", type: "single_choice", label: "Pick", options: ["only one", " "] },
    { id: "b", type: "short_text", label: "", showIf: { field: "z", op: "is", value: "x" } },
    { id: "c", type: "photo", label: "Photo", min: 3, max: 2 },
  ];
  const problems = taskFormProblems(bad);
  assert.ok(problems.some((p) => p.includes("at least two options")));
  assert.ok(problems.some((p) => p.includes("needs a question")));
  assert.ok(problems.some((p) => p.includes("does not come before it")));
  assert.ok(problems.some((p) => p.includes("lowest is above")));
  assert.deepEqual(
    tidyTaskForm([{ id: "a", type: "multi_choice", label: " X ", options: [" a ", "", "b"] }]),
    [{ id: "a", type: "multi_choice", label: "X", required: false, options: ["a", "b"] }],
  );
});

test("a question is summed across everybody who was asked it", () => {
  const yesNo: TaskField = { id: "y", type: "yes_no", label: "Y" };
  const s = summariseTaskField(yesNo, [true, true, false, undefined]);
  assert.deepEqual(s, { kind: "counts", answered: 3, counts: [{ label: "Yes", count: 2 }, { label: "No", count: 1 }] });
  const n = summariseTaskField({ id: "n", type: "number", label: "N" }, [2, 4, undefined]);
  assert.equal(n.kind === "numbers" && n.average, 3);
});

test("an audience is one task per salesman per shop, never shared", () => {
  const shops = [
    { id: "s1", carrierId: "u1" },
    { id: "s2", carrierId: null },
    { id: "s3", carrierId: "u9" },
  ];
  const team = (id: string) => id !== "u9";

  const own = expandTaskAudience(shops, { kind: "carrier" }, team);
  assert.deepEqual(own.pairs, [{ salesmanId: "u1", customerId: "s1" }]);
  assert.equal(own.noCarrier, 1);
  assert.equal(own.outsideTeam, 1);

  const both = expandTaskAudience(shops.slice(0, 2), { kind: "chosen", salesmanIds: ["u1", "u2", "u1"] }, team);
  assert.equal(both.pairs.length, 4);

  const people = expandTaskAudience(null, { kind: "chosen", salesmanIds: ["u1", "u2"] }, team);
  assert.deepEqual(people.pairs, [
    { salesmanId: "u1", customerId: null },
    { salesmanId: "u2", customerId: null },
  ]);

  assert.ok(taskAudienceProblem({ shops: { kind: "none" }, assignees: { kind: "carrier" } }));
  assert.ok(taskAudienceProblem({ shops: { kind: "list", customerIds: [] }, assignees: { kind: "carrier" } }));
  assert.equal(taskAudienceProblem({ shops: { kind: "none" }, assignees: { kind: "chosen", salesmanIds: ["u1"] } }), null);
});
