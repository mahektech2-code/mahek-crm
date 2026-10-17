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

/* ------------------------------------------------- linked to the customer */

import {
  expandTaskForm,
  guessTaskLink,
  linkedTaskComplete,
  type TaskLinkContext,
} from "./task-form";

const ctx = (over: Partial<TaskLinkContext> = {}): TaskLinkContext => ({
  contacts: [
    { id: "c1", name: "Ramesh", role: "owner", phone: "9820011001", email: null, birthDay: 14, birthMonth: 8, isPrimary: true },
    { id: "c2", name: "Sunil", role: "accounts", phone: "9820011002", email: null, birthDay: null, birthMonth: null, isPrimary: false },
  ],
  shop: { email: null, address: "Shop 4, MG Road", lat: null, lng: null },
  ...over,
});

test("a linked question starts from what the record holds and says so", () => {
  const form: TaskField[] = [
    { id: "b", type: "birthday", label: "Owner's birthday", required: true, link: { target: "contact.birthday", mode: "fill", scope: "primary" } },
    { id: "a", type: "long_text", label: "Address", required: false, link: { target: "shop.address", mode: "update" } },
  ];
  const out = expandTaskForm(form, ctx());
  assert.deepEqual(out.prefill, { b: { day: 14, month: 8 }, a: "Shop 4, MG Road" });
  assert.match(out.fields[0].help ?? "", /On the customer record: 14 Aug/);
  assert.equal(out.links.b.contactId, "c1");
});

test("a question about every contact is asked once per person, conditions following the person", () => {
  const form: TaskField[] = [
    { id: "has", type: "yes_no", label: "Do they celebrate?", link: undefined },
    { id: "b", type: "birthday", label: "Birthday", required: true, link: { target: "contact.birthday", mode: "fill", scope: "each" } },
    { id: "m", type: "phone", label: "Mobile", required: false, link: { target: "contact.mobile", mode: "update", scope: "each" } },
  ];
  const out = expandTaskForm(form, ctx());
  assert.deepEqual(out.fields.map((f) => f.id), ["has", "b@c1", "b@c2", "m@c1", "m@c2"]);
  assert.equal(out.fields[2].label, "Birthday — Sunil");
  assert.deepEqual(out.prefill["b@c1"], { day: 14, month: 8 });
  assert.equal(out.prefill["b@c2"], undefined);
});

test("a shop with no contacts yet asks once, and the shop's own number stands in", () => {
  const out = expandTaskForm(
    [{ id: "b", type: "birthday", label: "Birthday", required: true, link: { target: "contact.birthday", mode: "fill", scope: "each" } }],
    ctx({ contacts: [] }),
  );
  assert.deepEqual(out.fields.map((f) => f.id), ["b"]);
});

test("a fill task is complete from the record only when every question is linked and filled", () => {
  const birthday: TaskField = { id: "b", type: "birthday", label: "Birthday", required: true, link: { target: "contact.birthday", mode: "fill", scope: "primary" } };
  assert.equal(linkedTaskComplete([birthday], ctx()), true);
  assert.equal(linkedTaskComplete([{ ...birthday, link: { ...birthday.link!, scope: "each" } }], ctx()), false, "Sunil has none");
  assert.equal(linkedTaskComplete([{ ...birthday, link: { ...birthday.link!, mode: "update" } }], ctx()), false, "checking is the work");
  assert.equal(linkedTaskComplete([birthday, { id: "p", type: "photo", label: "Shop photo", max: 2 }], ctx()), false, "a photo still needs a visit");
  assert.equal(linkedTaskComplete([birthday], null), false);
});

test("the keyword guess links only what plainly is the record's", () => {
  assert.equal(guessTaskLink({ id: "x", type: "birthday", label: "Owner's birthday" })?.target, "contact.birthday");
  assert.equal(guessTaskLink({ id: "x", type: "birthday", label: "Birthdays of all staff" })?.scope, "each");
  assert.equal(guessTaskLink({ id: "x", type: "phone", label: "Owner's WhatsApp number" })?.target, "contact.mobile");
  assert.equal(guessTaskLink({ id: "x", type: "short_text", label: "Shop email" })?.target, "shop.email");
  assert.equal(guessTaskLink({ id: "x", type: "location", label: "Where the shop is" })?.target, "shop.location");
  assert.equal(guessTaskLink({ id: "x", type: "short_text", label: "Which brand do they buy?" }), null);
  assert.equal(guessTaskLink({ id: "x", type: "photo", label: "Shop photo" }), null);
});

test("a link the question type cannot hold is refused by the builder and dropped by tidying", () => {
  const bad: TaskField = { id: "x", type: "short_text", label: "Birthday", link: { target: "contact.birthday", mode: "fill" } };
  assert.ok(taskFormProblems([bad]).some((p) => p.includes("cannot be saved")));
  assert.equal(tidyTaskForm([bad])[0].link, undefined);
});
