# Prompt for Claude Design — MahekOne HRMS (web, phone-first where staff use it)

> Copy everything below the line into Claude Design. It describes **what** must
> be on each screen and **how the product behaves**. It deliberately says
> nothing about visual style, layout, colour, typography, components or
> branding. Those decisions belong to Claude Design.

---

## Brief

Design the complete web application **"HRMS"** for Mahek Marketing India, a
paint-thinner and solvent manufacturer with offices and godowns (e.g.
Bhiwandi, Ambernath) and a field sales team. HRMS runs their people: employee
records, daily attendance with a location check, leave and holidays, monthly
attendance reports, payroll with payslips, salary advances, expense claims,
daily task checklists and assigned to-dos, sales-staff KPIs and performance
scores, customer calling and deactivation for the back office, journey plans,
company assets, documents, grievances, help requests and notifications.

HRMS replaces an AppSheet app the staff use today. It is one app inside a
suite called **MahekOne**: people sign in once to MahekOne and open HRMS from
its app launcher. **Most employees will use HRMS on a phone browser** (checking
in at the office door, applying for leave, ticking off tasks), while HR,
payroll and admins mostly use a desktop. Every screen must work well at phone
width and at desktop width. Field salesmen check in on a separate handset app
(MBOS); their days appear in HRMS like everyone else's.

Please produce designs for **every screen listed below**, including list,
record, create/edit form, bulk-action, confirmation, prompt, empty, loading,
error, location-denied and permission-restricted states. The field-level rules
are in the companion documents `01-HRMS-PRD.md` and
`02-HRMS-FUNCTIONAL-SPEC.md`. This brief is self-sufficient for designing, but
those documents are the reference for exact field lists.

### The one rule about duplication

**Every function appears exactly once in the product.** The old app reached
the same function through two or three screens ("OT" and "Your OT";
"Grievance" and "Grievance (Staff)"; "Documents" and "Documents (For Staff)";
the same leave list in three menus). HRMS has **one screen per function**; what
a person sees on it (only their own rows, their team's, or everyone's) is
decided by their access, never by a second copy of the screen. Menu groups may
only **link** to a screen, never contain a copy of it. Do not design two
screens that do the same job for different people. Where MahekOne already has
the facility (sign-in, the notification bell, global search, the "Tell us"
feedback button, the help-video library), HRMS uses it and does not get its
own.

### Who uses it

| Person | Main jobs |
|---|---|
| Every employee | Check in and out, see their attendance, apply for leave, see their monthly report and payslips, tick off today's tasks, work their to-dos and buddy tasks, send the end-of-day summary, read documents tagged to them, raise help requests and grievances, update their profile photo |
| Department head (position ends in "Head") | Mark attendance for field staff of their office, check people out, see their team's attendance |
| HR | Add employees, monitor attendance, holidays, documents, assets, expenses, sales KPIs, journey plans |
| Payroll clerks | Prepare, approve and pay salaries; payslips |
| Advance clerk | Give salary advances |
| Admin | Everything: approve leave with the paid / unpaid split, edit and import attendance, manage task templates and verify to-dos, resolve help and grievances, decide customer deactivations, see all performance |
| Owner / CEO | Payroll, staff timings, calling data, who can open which screens |
| Sales staff | Daily KPI entry, their daily performance score and chart |
| Back-office staff | Area-wise customer calling lists and follow-ups; customer deactivation requests |

### Access rules the design must express

- A person sees only the **modules and screens granted** to them. Navigation,
  home items and links never lead somewhere they cannot open.
- The same screen shows **mine / my team / all** depending on access. Where a
  person can switch scope, the current scope is always visible. Where they
  cannot, nothing suggests other people's rows exist.
- Some **fields are visible only to some people**: leave entitlements
  (monthly paid leave, yearly maximum leave), Aadhaar (masked to the last four
  digits for everyone except admin), the paid / unpaid split on a leave
  request, expense verification, customer status.
- Some **actions appear only** for certain people or record states (e.g.
  Approve on a leave request is admin-only and only while it is not already
  approved; "Give feedback" on a grievance only for the person who raised it,
  after it is solved). When an action is unavailable, decide whether to hide it
  or show it disabled **with the reason**.
- Two features are **switched off by default** (QR-code check-in and
  Overtime). Design them fully, and design how they are absent when off.

### Global behaviours to design for

- **Location-checked attendance.** Check-in and check-out read the phone's
  location and compare it with the office's radius. Design: asking for
  location permission; waiting for a fix; inside the radius; outside it
  ("You are out of office location ! Please Back To Office {name} Then Try to
  Check in Again!"); location denied; already checked in today ("You Today
  Already Checked In!"); late beyond the 30-minute grace ("Late Punch-in,
  Today Unpaid Leave. Contact Admin"). Optional photo at check-in and at
  check-out.
- **Search, filter, sort, group** on every list. Many lists are grouped (by
  date, month, year, employee, status, category, area) with a count or a sum
  per group (e.g. sum of salary in hand per month; sum of advance amounts;
  sum of time given per area). Show the groups and their aggregate.
- **Date filters** on every history list (attendance defaults to the last 400
  days; sales activity to 500 days).
- **Bulk selection and bulk actions** (approve many leave requests; activate
  or deactivate employees; mark checklist items done; approve and pay
  salaries).
- **"Add more" / copy-as-new** on staff timings (another weekday), holidays,
  and task templates.
- **Derived fields** (read-only, computed) sit next to input fields: working
  hours, late / early, full or half day, leave days, available leave,
  every salary figure, every performance score. Their read-only nature must be
  clear.
- **Conditional fields** appear only when relevant (sales targets only for
  sales staff; UAN and ESIC numbers only when PF/ESIC applies; in/out time on
  a help request only for the attendance issues that need them; category for
  monthly tasks and weekdays for daily/weekly ones; claim amount vs paid
  amount on an expense; warranty and invoice images only for tangible assets).
- **Validation messages** are specific and shown at the field they concern,
  in the source's words, including: "You Today Already Checked In!", "Late
  Punch-in, Today Unpaid Leave. Contact Admin", "Insufficient Paid Leave",
  "Insufficient Unpaid Leave", "This Date Is already added ! Request Type
  {type} {status}", "Please Select leave End Date of Same Month! For Next Month
  apply Separate Leave", "OT Already Added", "OT not Applicable", "This Month
  Salary Paid", "Your Pending Checkout Count is {n}", "Kindly Check Count
  Leave/Attendance {n} Days Missing", "Enter 12 Digit Valid Adhar Number",
  "Set Range less than 20 km", "Before Should be Greater Than Selected Date !",
  "Before Date should Be Greater Than For Date!", "{task} Task of {date} Date
  Expired".
- **Confirmations** with the source's wording: "Are You Sure! Your Task Is
  Done", "Are You Sure ! You Want Delete This Request", and a confirmation on
  every delete.
- **Prompts** that ask for one or more values before an action: paid leave
  days (approve leave); admin remark; check-out time (officer); check-in time;
  remark; payment UTR number and payment date (pay salary); solution
  (grievance); star feedback 1–5; deactivation reason; calling status, second
  status, discussion note and follow-up date (calling form); the four review
  questions (performance review); restored date, by, quantity, remark and
  photo (restore asset); "Not Applicable" reason (checklist).
- **Flags / states** that must be distinguishable at a glance: inactive
  employee; late / early remark; on working vs present; late check-in;
  leave approved / rejected / requesting; leave vs half day; wait-for-approval
  vs enjoy-leave line; help approved; checklist done; checklist item still
  blank this week; to-do done; to-do given to me vs given by me; urgent and
  important to-do; five-star feedback; salary approved; salary paid; asset in
  stock; asset assigned-to; customer total orders; second call still to make.
- **Contact actions** on phone and email fields (call, message, email) and map
  links on addresses and coordinates.
- **Media**: take or upload photos (check-in, check-out, employee photo, ID
  card, assets, invoices), attach files (journey plans, documents), open PDFs
  (payslips, performance reports), play videos and open links (documents).
- **Export** of the list as shown (CSV) where marked, and **import** (CSV)
  with a preview and row-level errors for attendance and holidays.
- **Share to WhatsApp**: the end-of-day task summary opens WhatsApp with a
  formatted message.
- Every record shows who created it and when.

---

## Screens to design

### 0. App frame
- Navigation between modules and the screens inside them, showing only
  granted items. Modules: Attendance, Leave & Holidays, Overtime (when on),
  Monthly Reports, Payroll, Expenses, Tasks, Performance, Sales Desk,
  Employees, Offices & Timings, Assets, Help & Grievance, Documents,
  Notifications. The old app's convenience groupings (Staff panel, HR panel,
  Admin panel, Salary, Attendance Monitor, Leave Monitor, Task Management) may
  exist as menu groups **that link** to the screens — never as copies.
- The current user (name, position, office) and the way back to the MahekOne
  launcher, the notification bell, global search and "Tell us".
- Phone navigation that puts **Check in**, **Leave**, **Notifications** and the
  person's tasks within one tap, as the old app's bottom bar did.

### 1. Home — Check in
The landing screen for everyone (the old app opened on "Make Attendance").
- Today's attendance card: check in (with optional photo), then check out
  (with optional photo); current status (On Working / Present); official in and
  out time for today; late or early duration and the remark ("You Are late …
  Punctuality Is The Key To Success …" / "You Are Early … That's Superb 👌 And
  We Value Your Dedication !"); working hours so far and working-hour %; full
  or half day once checked out; distance from the office.
- Every check-in state listed under Global behaviours.
- Below it, only items waiting today that the person can act on: pending
  check-outs, today's checklist progress, open to-dos, buddy tasks shared with
  them, and — for those who hold them — leave requests awaiting approval,
  staff pending check-out, help requests and grievances waiting.
- QR check-in (when switched on): scan the office QR code instead of the
  location check.

### 2. Attendance
- **My attendance:** my days newest first, grouped by date; check in, check
  out, duration; late/early flag; photos; remark.
- **My pending check-outs:** my days with a check-in and no check-out, with
  Check out.
- **Attendance register** (team for heads, all for HR/admin): employee, date,
  check in, check out, duration, remark, working hour %, distance and the
  rest; grouped by month, year, employee, date with counts; a "Today" tab;
  quick edit of remark; per-row actions: check out, check out by officer, set
  check-in time, remark, edit, delete; import and export.
- **Mark attendance for staff** (heads, HR, admin): pick an employee (only
  active field/other staff of my office not yet marked today, never heads),
  date, check in, check out, unplanned stoppage, office, photo; distance and
  working hours shown.
- **Attendance record:** every field incl. official in/out time, target
  duration, late/early, unplanned stoppage, total working hours, working hour
  %, work day, current status, time remark, location on a map, both photos,
  employee photo, who created it.
- **Pending check-outs (all):** everyone checked in and not out, grouped by
  date.
- **Absentees:** pick a date; list of active employees with no attendance,
  not on a tagged holiday, not on leave (name, ID, count); beside it the
  pending check-outs.
- **Attendance chart:** attendance count per employee with a trend line; tap
  through to the rows.

### 3. Leave & Holidays
- **My leave:** my requests newest first as cards: dates, days, type, status
  (flagged), and the line "{name} Wait For Admin Approval" / "{name} Enjoy
  Leave". Record: date, request ID, type, start, end, days, reason, approved
  by, approved on, officer remark, status time.
- **Apply leave:** type (Leave / Half Day), start date, end date (same month
  only), days (derived), reason; available paid leave this month and available
  unpaid leave this year visible **while applying**. With the "apply on
  behalf" power, an employee picker (field/other staff of my office).
- **Approvals** (admin): requests awaiting a decision grouped by employee,
  with photo, dates, days, available paid, available unpaid, holidays inside
  the leave, reason. Actions: **Approve** (prompt: paid leave days; shows the
  resulting unpaid days and both balances; refuses with "Insufficient Paid
  Leave" / "Insufficient Unpaid Leave"), **Reject**, **Admin remark**; bulk.
- **All requests:** every request with status and type flags, filters.
- **Leave calendar:** month view, one bar per request, labelled by employee.
- **Leave setup:** monthly paid-leave credits per employee per month (created
  automatically on the 1st; admin can add and edit); a "Run now".
- **Holidays:** date, day, category (Festival / Weekly / National / Nature),
  holiday name, tagged employees, remark; add, "add more", edit (only within
  the last year), delete, import and export.

### 4. Overtime (switched off by default)
One OT record per employee per date: slot (Before Duty / After Duty), start
and end (pre-filled from attendance), OT hours (derived, at least 10 minutes),
remark; monthly total. Mine / all. Design the "off" state (absent from
navigation).

### 5. Monthly Reports
Per employee per month: days attended, office open days, late count, late
over 10 minutes, on-time count, check-in %, overall monthly %, total late
duration, half days, **missing dates**, leave dates, holiday dates, remark
(editable). Grouped by year and month. Mine / all. Export.

### 6. Payroll
- **Payroll register:** employee, fixed salary, basic, attendance count, in
  hand, advance deduction, late deduction, PT, incentive, conveyance, special
  allowance, remark; grouped by year and month with the **sum of in-hand** per
  month; approved and paid states flagged. Bulk approve and pay. Export.
- **Salary form:** salary date → the month it pays (previous month) → employee
  (only those not yet paid that month) → the whole computation laid out as a
  readable payslip: days in month and the reconciliation hint (full + half +
  leave + official holidays − holidays inside leave − compensation days); full
  days, half days, paid / unpaid leave, leave days, official holidays,
  compensation days (input), attendance count; earnings (basic, incentive
  input, conveyance, special allowance, gross); deductions (employee PF,
  ESIC, PT, advance deduction pre-filled from the outstanding advance, late
  deduction from late half-days, gross deduction); **salary in hand**; other
  payment shown beside it; employer PF, employer ESIC, CTC; bank details.
  The two blocking errors ("Your Pending Checkout Count is n", "Kindly Check
  Count Leave/Attendance n Days Missing") must read clearly.
- **Salary record** with header in hand and other payment; actions
  **Approve**, **Pay** (prompt UTR and payment date), **Regenerate payslip**,
  **Open payslip**.
- **My payslips:** my paid salaries by year and month with the PDF.
- **Advances:** advances by year and month with the sum; each employee's
  outstanding balance; **Give advance** form (date, employee, amount, remark).

### 7. Expenses
Entries per employee: serial, date, payment type (Expense Claim / Expense
Paid), location, category, particular, claim or paid amount (only the one that
applies), reason, verify state; **monthly balance and total balance** visible.
Grouped by employee, year, month, verify. Quick verify for admin. Export.

### 8. Tasks
- **My tasks** (templates): my daily / weekly / monthly tasks, with my name
  highlighted, and **Take my task** (copy today's weekday tasks into today's
  checklist, once a day), **Take monthly task** (copy monthly tasks into my
  to-dos, once a month), and the **Task EOD** message with **Send to
  WhatsApp** (preview the formatted message: totals, completed, pending, not
  applicable with reasons, overdue to-dos).
- **Task templates** (admin, all employees): employee, task, frequency,
  weekdays or day-of-month and before-date, category, start and end time; add
  more; grouped by employee.
- **Today's checklist:** task, status, start/end, working time, time
  difference, remark; actions **Done**, **Not done** (undo), **N/A** (prompt
  reason), **Write remark**; bulk.
- **Not done this week** and **All checklists** (admin, grouped by date and
  employee).
- **To-dos:** tabs *Open* (given to me or by me; overdue marked), *To verify*,
  *History*, *All* (admin). Record: for date, till date, from, to, category,
  task, status, recheck status, remark, days taken, days given, average days.
  Actions: **Assign to-do** (one form), **Done** (confirmation), **Not done**,
  **Write remark**, **Verified**, **Pending**. Flags for "given to me" vs
  "given by me", urgent and important, done.
- **Buddy tasks:** share one of today's tasks with a colleague (task
  suggested from my templates for today); the buddy **Accepts**, then marks
  **Task done**; tab "Shared with me today".

### 9. Performance
- **KPI KRA** (sales staff daily; all for HR/admin): date, employee, area
  visited, visits, productive counters, litre sales, km, unplanned stop,
  amount of sales, outstanding; punch in/out and time remark from attendance;
  on-field time. Values pre-filled from other MahekOne data show where they
  came from and stay editable.
- **Sales performance:** daily score out of 100 per salesman with the nine
  components and their targets (visits 10, time with customer 5, note length
  5, working hours 10, km 5, sales 20, litres 20, outstanding 20, tasks 5); the
  day's meeting notes; a **chart** of daily performance (mine / all) with
  trend line and "Data".
- **Staff performance** (monthly): working hours %, on-time punctuality %,
  daily task (or KPI) %, to-do performance, buddy-task performance, overall
  %, working-speed sentence. Mine / all.
- **Employee of the Month:** everyone at ≥ 90% overall, by month.
- **Performance points** (any date range): employee, position, from, to; each
  count and point (attendance, punctuality, working hours, tasks with N/A
  reasons; for sales: sales amount, litres, outstanding, time with customer,
  note length); total; the **review form** (issues faced last time,
  opportunities and new ideas, next meeting plan, action for Sir); PDF report
  with download and regenerate. Grouped by position and employee.

### 10. Sales Desk
- **Customers** with tabs *Active*, *Pending deactivation*, *Deactive*: name,
  address (map), mobile and alternate (call / message), rating (High / Medium
  / Low value), segmentation, area, state, sales person, tagged employee,
  special instructions, back-office employee, status, deactivation request
  and remark; the customer's activities and calls inside the record. Actions:
  **Take follow-up** (adds every active customer of this area where I am the
  back-office employee to my calling list), **Deactivation request** (prompt
  reason), **Withdraw request**, **Accept** / **Reject** deactivation (admin),
  **Make active again** (admin).
- **Calling** with tabs *To call*, *Follow-ups due*, *History (10 days)*,
  *All*: customer, grade, mobile, area, special instruction, sales person,
  calling date, status (Call Not Pick Up / Order Received / No Requirement /
  Reminder Call Back), second status (when not picked up), discussion note,
  follow-up date, total orders, suggestion ("Do FollowUp" / "Do Deactivate
  This Customer"). The **calling form** prompt. Flag rows still needing a
  second call.
- **Sales activity:** date, customer, meeting note, time given (minutes),
  mood, issue, reminder date, area, meeting type and purpose; grouped by area
  and customer with the sum of time given.
- **Journey planner:** month calendar of plans (employee, start–end, location);
  form with plan text, customers (multi-pick), remark, attachment.

### 11. Employees
- **Directory:** grouped by status with counts; inactive flagged; search.
  Actions: **Sign up** (new employee), **Activate**, **Deactivate** (bulk),
  **Manage access** (opens MahekOne's access screen).
- **Employee record:** photo, live working age, and sections — personal
  (gender, birth, anniversary, children's birthdays), contact (personal,
  alternate, emergency, company mobile with call / message; email), addresses
  with map, job (office, position type, position, report-to, joining, leaving),
  pay (salary allocated, conveyance for sales, other salary, bank, account,
  IFSC), statutory (PF/ESIC, UAN, ESIC number, Aadhaar masked), sales targets
  (sales only: area, visits, km, litres, working hours, amount), leave
  entitlement (admin only), access (read-only with link), and related lists:
  attendance, timings, help requests, ID card, advances, salaries, leave.
- **Sign-up / edit form** with the conditional sections.
- **My profile:** my record as a card, photo upload, change password (via
  MahekOne), the self-editable fields.
- **ID cards:** gallery of ID card images.

### 12. Offices & Timings
- **Offices:** cards with office image; record: name, map pin (pick on map),
  address, radius in metres (max 20 km), opening and closing time, timing type
  (Full Day / Half Day / 24*7), duration, official paid leave note,
  attendance QR code text and the **printable QR image**.
- **Staff timings:** per employee per weekday, in time, out time, duty
  duration; grouped by employee; quick edit; **Add more time** (copy to
  another weekday).

### 13. Assets
- **Asset stock:** purchase date, asset name, category (Stationery / Tangible
  Assets / Other), cost, quantity, description, location (office), warranty,
  invoice and asset images (tangible only), **available stock**; grouped by
  category.
- **Assignments:** assigned to, asset, quantity, from, date, responsibility &
  suggestion, two photos, status (Assigned / Restored), restored details, in
  use; grouped by assigned-to. **Assign asset** form; **Restored asset**
  prompt (date, by, quantity, remark, photo). A warning when assigning more
  than is available.

### 14. Help & Grievance
- **Help requests:** type and issue (I Forgot Make Attendance, I Late Check
  In, I Forget Check Out, I Am Late Today, OT Not Approved, I Want to Lean App,
  Other), in / out time where relevant, the text, status, admin remark (required
  for "I Am Late Today"); **Approve** for admin; a link to the attendance day
  concerned. Choosing "App issue" hands the person to MahekOne's "Tell us"
  with their text and screenshot — design that hand-off.
- **Grievances:** to (CEO / HR / Company or a named person), the issue,
  status (Pending / Solve), solution, star feedback; **Give solution** (admin),
  **Give feedback** (raiser, after solve, 1–5 stars); grouped by status and
  recipient.

### 15. Documents
Cards: title, type (PDF & audio / image / video / link), description, date,
tagged employees. Managers see all and add; everyone else sees what is tagged
to them. Open PDF / play audio / view image / play video / open link.

### 16. Notifications
Write a notification (to, text, landing screen); list newest first (from,
text, time, seen); delete, edit, email the sender or the receiver. Received
notifications arrive in the MahekOne bell.

### 17. Settings
Reference lists (bank names, positions, areas, holiday categories and names,
expense categories / particulars / locations, customer segmentation, states,
activity issues, moods, meeting types and purposes, journey locations, asset
names) and the HRMS settings (grace minutes, full-day %, payroll rates and
slabs, performance weights, QR attendance on/off, Overtime on/off, WhatsApp
number for the EOD).

---

## End-to-end flows to storyboard

1. **A day at the office (phone):** allow location → check in 12 minutes late
   (within grace, shown as early/late correctly) → tick three checklist items,
   mark one N/A with a reason → accept a buddy task and finish it → send Task
   EOD to WhatsApp → check out with a photo → the day reads Full Day.
2. **Too far / too late:** check-in refused outside the radius; then refused
   for arriving 45 minutes late ("Late Punch-in, Today Unpaid Leave. Contact
   Admin"); raise a help request "I Am Late Today"; admin adds a remark,
   approves, and sets the check-in time on the register.
3. **Field staff:** a head marks attendance for two salesmen of the office; at
   the end of the day checks one of them out with a time.
4. **Leave:** apply for three days in the same month → admin approves with 2
   paid days (1 unpaid) → the calendar shows it → the employee's card reads
   "Enjoy Leave" → next month's credit arrives on the 1st.
5. **Payroll month end:** monthly report shows missing dates → an open
   check-out blocks a salary ("Your Pending Checkout Count is 1") → fixed →
   salary computed with a late half-day deduction and an advance recovery →
   approve → pay with UTR → employee opens the payslip PDF.
6. **Back-office calling:** take follow-up for an area → call down the list →
   one customer "Call Not Pick Up" then a second status → follow-up due
   tomorrow → another customer's suggestion reads "Do Deactivate This
   Customer" → deactivation request with a reason → admin accepts.
7. **Performance review:** sales KPI entered for a week → daily scores and
   chart → performance points for the month → the review form filled → PDF
   downloaded.

## States to cover on every screen
Empty (new installation), loading, error with retry, no permission (and the
navigation that avoids it), scope switch (mine / team / all), a long list
with grouping and pagination, a record with every optional field empty, and
the same screen at phone and desktop width.
