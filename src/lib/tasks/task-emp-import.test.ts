import test from "node:test";
import assert from "node:assert/strict";
import { routineProblems } from "./routines";
import { mapTaskList, mapToDoList, monthKey, sheetDate, sheetStamp, todoAsTask, type EmployeeRef, type SheetRow } from "./task-emp-import";

const people: EmployeeRef[] = [
  { id: "e-sarthika", code: "EMP-4030", name: "Sarthika Sandesh Londhe", active: true },
  { id: "e-puja", code: "EMP-2266", name: "Puja Jaysing Yadruk", active: true },
  { id: "e-rohini", code: "EMP-5613", name: "Rohini Ashok Mohite", active: false },
];
let n = 1;
const row = (cells: Record<string, string>): SheetRow => ({ rowNumber: ++n, cells });
const tl = (c: Partial<Record<string, string>>) =>
  row({ "Sr. No": "1", "Name Of Employee": "Puja Jaysing Yadruk", Task: "Count the stock", Frequency: "Daily", Category: "", Days: "", Date: "", "Till Date": "", "Start Time": "", "End Time": "", ...c } as Record<string, string>);

test("the sheet's dates are month first, and its odd spelling reads too", () => {
  assert.equal(sheetDate("10/3/2026"), "2026-10-03");
  assert.equal(sheetDate("1-Jul-2025"), "2025-07-01");
  assert.equal(sheetDate("13/1/2026"), undefined);
  assert.equal(sheetDate(""), null);
  assert.equal(sheetStamp("8/12/2023 16:12:50"), "2023-08-12T16:12:50+05:30");
  assert.equal(monthKey("102026"), "2026-10");
  assert.equal(monthKey("92023"), "2023-09");
});

test("a daily routine naming no days runs Monday to Saturday; times become HH:MM", () => {
  const { drafts } = mapTaskList([tl({ "Start Time": "14:00:00", "End Time": "16:00:00" })], people);
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0].weekdays, [1, 2, 3, 4, 5, 6]);
  assert.equal(drafts[0].frequency, "daily");
  assert.equal(drafts[0].startTime, "14:00");
  assert.equal(drafts[0].dueTime, "16:00");
});

test("named weekdays become numbers, and the renamed person is found under her login's name", () => {
  const { drafts } = mapTaskList([tl({ "Name Of Employee": "Vaishali Shivaji Chaudhari", Frequency: "Weekly", Days: "Tuesday , Friday" })], people);
  assert.equal(drafts[0]?.assigneeId, "e-sarthika");
  assert.deepEqual(drafts[0].weekdays, [2, 5]);
});

test("a switched-off login gets no routine, and a duplicate row is one routine", () => {
  const { drafts, skipped } = mapTaskList(
    [tl({ "Name Of Employee": "Rohini Ashok Mohite" }), tl({ "Sr. No": "2" }), tl({ "Sr. No": "3" })],
    people,
  );
  assert.equal(drafts.length, 1);
  assert.match(skipped[0].reason, /switched off/);
  assert.match(skipped[1].reason, /same routine as Sr\. No 2/);
});

test("a named correction applies only to the values it names", () => {
  const ok = mapTaskList([tl({ "Sr. No": "433", "Start Time": "11:00:00", "End Time": "05:00:00" })], people);
  assert.equal(ok.drafts[0].dueTime, "17:00");
  const changed = mapTaskList([tl({ "Sr. No": "433", "Start Time": "11:00:00", "End Time": "06:00:00" })], people);
  assert.equal(changed.drafts.length, 0);
  assert.match(changed.skipped[0].reason, /now reads/);
});

test("monthly: a till day of 0 is blank, the category is a priority, and every draft passes the form's own rule", () => {
  const { drafts } = mapTaskList(
    [tl({ Frequency: "Monthly", Category: "Urgent and Important", Date: "25", "Till Date": "0" }), tl({ "Sr. No": "2", Frequency: "Monthly", Date: "1", "Till Date": "3" })],
    people,
  );
  assert.deepEqual(drafts.map((d) => [d.dayOfMonth, d.completeByDay, d.priority]), [[25, null, "urgent"], [1, 3, "normal"]]);
  for (const d of drafts) assert.deepEqual(routineProblems({ ...d, app: "tasks" }), []);
});

test("a weekly task with no weekday is held back with a question", () => {
  const { drafts, skipped } = mapTaskList([tl({ Frequency: "Weekly" })], people);
  assert.equal(drafts.length, 0);
  assert.match(skipped[0].reason, /which day/);
});

const td = (c: Partial<Record<string, string>>) =>
  row({ "To Do Task Id": "A1", Date: "10/1/2026", "For Date": "10/3/2026", "Till Date": "", "Assign From": "Monthly Task", "Assign To": "Puja Jaysing Yadruk", Category: "Urgent and Important", "Assign Task": "File GST", Status: "", "Recheck Status": "", Remark: "", "Month ID": "102026", Timestamp: "", ...c } as Record<string, string>);

test("a to-do keeps a giver with no login as a name, and a switched-off person's to-do is kept", () => {
  const { drafts } = mapToDoList(
    [td({ "Assign From": "Poonam Pashte", "Month ID": "" }), td({ "To Do Task Id": "A2", "Assign To": "Rohini Ashok Mohite", "Assign Task": "x" })],
    people,
  );
  assert.equal(drafts[0].fromLabel, "Poonam Pashte");
  assert.equal(drafts[0].fromUserId, null);
  assert.equal(drafts[0].monthlyKey, null);
  assert.equal(drafts[1].toUserId, "e-rohini");
  assert.equal(drafts[1].monthlyKey, "2026-10");
  assert.equal(drafts[1].urgent, true);
});

test("a to-do for somebody with no login is held back", () => {
  const { drafts, skipped } = mapToDoList([td({ "Assign To": "Poonam Pashte" })], people);
  assert.equal(drafts.length, 0);
  assert.match(skipped[0].reason, /no MahekOne login/);
});

test("a done to-do carries when it was done; a monthly copy made twice is one to-do, the finished one", () => {
  const { drafts, merged } = mapToDoList(
    [td({}), td({ "To Do Task Id": "A2", Status: "Done", "Recheck Status": "Verified", Timestamp: "10/4/2026 9:05:00" })],
    people,
  );
  assert.equal(merged, 1);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].sheetId, "A2");
  assert.equal(drafts[0].doneOn, "2026-10-04");
  assert.equal(drafts[0].recheck, "Verified");
});

test("a done, verified to-do becomes a closed task that keeps its day and says who verified", () => {
  const { drafts } = mapToDoList(
    [td({ "Assign From": "Sarthika Sandesh Londhe", Category: "Important", "Till Date": "10/9/2026", Status: "Done", "Recheck Status": "Verified", Timestamp: "10/4/2026 9:05:00", Remark: "sent" })],
    people,
  );
  const t = todoAsTask(drafts[0]);
  assert.equal(t.status, "done");
  assert.equal(t.priority, "high");
  assert.equal(t.dueDate, "2026-10-09");
  assert.equal(t.assigneeId, "e-puja");
  assert.equal(t.createdById, "e-sarthika");
  assert.equal(t.closedById, "e-puja");
  assert.equal(t.closeRemark, "sent");
  assert.equal(t.closedAt?.toISOString(), "2026-10-04T03:35:00.000Z");
  assert.deepEqual(t.events.map((e) => e.kind), ["created", "closed", "note"]);
});

test("a monthly or orphaned to-do is created by its holder, and the note says where it came from", () => {
  const monthly = todoAsTask(mapToDoList([td({})], people).drafts[0]);
  assert.equal(monthly.createdById, "e-puja");
  assert.equal(monthly.status, "todo");
  assert.equal(monthly.priority, "urgent");
  assert.equal(monthly.closedAt, null);
  assert.match(monthly.note!, /A monthly task\./);
  const orphan = todoAsTask(mapToDoList([td({ "Assign From": "Somebody Who Left", "Month ID": "" })], people).drafts[0]);
  assert.match(orphan.note!, /Given by Somebody Who Left\./);
});

test("a done to-do with no stamp closes on its own day, and a long title keeps its full text in the note", () => {
  const long = "x".repeat(250);
  const t = todoAsTask(mapToDoList([td({ "Assign Task": long, Status: "Done" })], people).drafts[0]);
  assert.equal(t.title.length, 200);
  assert.ok(t.note!.includes(long));
  assert.equal(t.closedAt?.toISOString(), "2026-10-03T12:30:00.000Z");
  assert.equal(t.closeRemark, "Marked done in Task EMP 2.0.");
});
