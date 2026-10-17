# MahekOne HRMS — Product Requirements Document

| | |
|---|---|
| Product | **HRMS**, the people app of MahekOne (web first, usable at phone width; field staff keep using MBOS on the handset) |
| Source of truth for scope | *Mahek EMP 2.0 — Application Documentation* (the client's AppSheet export, version 1.002151, generated 26 Sep 2026, 972 pages: 40 tables, 831 columns, 34 slices, 200 views, 43 format rules, 212 actions, 4 automation process tables) |
| Companion documents | `02-HRMS-FUNCTIONAL-SPEC.md` (every field, formula, rule, screen and action) · `03-HRMS-CLAUDE-DESIGN-PROMPT.md` (brief for the screen designs) |
| Status | Draft for build |

---

## 1. Purpose

Mahek Marketing India runs its staff on an AppSheet app called **Mahek EMP 2.0**
("Advance Bio-metrics Application can help Manage staff Timing and Solve staff
late issue"), backed by the *Employee Details* Google Sheet workbook and two
side workbooks (*Task EMP 2.0* and *Mahek EMP 2.0 – Performance*). The client
has asked for that application to be rebuilt as the **HRMS** app of MahekOne,
with **every feature it has today**, working end to end on the web.

HRMS covers the whole employee lifecycle the source app covers:

```
Employee sign-up → office, weekly timing, targets, leave entitlement, statutory data
  → Daily attendance (geo-fenced check-in / check-out, photos, late / early remark)
  → Officer-marked attendance for field staff · pending check-outs · absentee finder
  → Leave requests → approval (paid / unpaid split) → leave calendar · monthly leave credit
  → Holidays (tagged to employees) · Overtime · Help / correction requests
  → Monthly attendance report → Salary run (attendance-driven, PF / ESIC / PT,
    late-mark deduction, advance recovery) → approval → payment (UTR) → payslip PDF
  → Advances · Expense claims and payments
  → Daily task checklists · assigned to-dos with verification · buddy tasks · EOD summary
  → Sales staff: daily KPI entry, customer activity, customer calling, journey plans
  → Performance: daily sales score, monthly staff performance, period performance points
    (with review PDF), Employee of the Month
Side flows: assets (stock in, assign, restore) · documents · grievances with feedback
            · notifications · permissions
```

### 1.1 What "done" means

1. Every table, field, calculation, validation, list, filter, status, action,
   automation and permission in the source document has a working equivalent in
   HRMS. The functional spec maps them one by one (§20–§25 of the spec).
2. A person who works in Mahek EMP 2.0 today can do the same job in HRMS without
   losing a field, a check, a report or a message.
3. **No feature appears twice.** The source reaches several functions through
   two or three separate screens (for example "OT" and "Your OT", "Grievance"
   and "Grievance (Staff)", "Documents" and "Documents (For Staff)"). HRMS has
   **one** screen per function, and what a person sees on it is decided by
   their access. Where MahekOne already has the screen for a function (sign-in,
   notifications, search, feedback, the help-video library), HRMS uses that
   screen instead of building a second one. §3.2 lists every merge.
4. The data model and business logic live in shared services, so MBOS (the
   field handset) and any later mobile app use the same rules without a rewrite.

### 1.2 Scope rule

**HRMS builds what the source document contains. Nothing else is in scope.**
A capability that is not in the source is added only when one of the source's
own features cannot work on the web without it. Every such addition is listed
in §9 with the source feature it serves. Where the source's own formula
contradicts its evident intent, the spec implements the intent and lists the
case for sign-off (spec §19). Anything the client wants beyond that is a
separate request.

**Features that exist in the source but are switched off there stay switched
off.** QR-code attendance and Overtime have tables, forms and actions in the
source, but every screen that opens them is hidden from all users
(`show_if = userrole()=hide`). HRMS builds both, behind settings that default
to **off**, so turning them on is a decision and not a deploy.

---

## 2. Users and roles

### 2.1 Who uses it (as evidenced by the source)

| Persona | What they do in the source app |
|---|---|
| **Owner / CEO** | Sees payroll, calling data, security & permissions; sets which screens each employee may open; sets staff timings. |
| **Admin** (AppSheet admin role) | Everything: adds, edits, activates and deactivates employees; edits and imports attendance; approves or rejects leave and sets the paid-leave split; sets up monthly leave and holidays; runs payroll and advances; verifies expenses; manages task templates, assigns and verifies to-dos; resolves help requests and grievances; accepts customer deactivations; sees all performance; exports reports. |
| **HR** (HR email in the source) | Adds employees; attendance monitor; marks attendance for any active staff; can check in from up to 9 km away; holidays; documents; assets; expenses; KPI / sales activity / customers / journey planner; enters daily sales performance. |
| **Office / accounts** (office email) | Payroll deletion rights; advances visible; documents, assets, expenses. |
| **Payroll clerks** (two named people in the source) | Open the payroll register, approve and pay salaries. |
| **Advance clerk** (one named person in the source) | Gives salary advances. |
| **Journey planner** (one named person in the source) | Plans journeys for any employee, not only sales staff. |
| **Sales office** (two sales emails) | KPI KRA for all, sales activity, customers, journey planner, HR panel. |
| **Department head** (any employee whose Position ends in "Head") | Marks attendance for field / other staff of the same office; checks out staff on their behalf; sees the "Attendance By Officer" register. |
| **Back-office employee** | Takes an area's customers into a calling list, records calling status and follow-ups, requests customer deactivation. |
| **Sales staff** (Position Type = Sales) | Daily KPI KRA, customer activity, their daily performance score and chart. |
| **Office staff / other staff** | Daily task checklist, to-dos, buddy tasks, EOD summary to WhatsApp. |
| **Every employee** | Checks in and out, sees their attendance history and pending check-outs, applies for leave, sees their monthly report, payslips, OT, profile, documents, notifications; raises help requests and grievances. |

### 2.2 Access model

The source controls access in four layers. HRMS keeps all four.

1. **Sign-in.** The source signs people in through a settings form (Employee ID
   + password checked against the employee sheet; an inactive employee is
   refused with "Please Enter Valid Password or Contact DM Maybe You are
   inactive employee."). HRMS uses **MahekOne's single sign-in**. Only employees
   whose HRMS status is **Active** may sign in, which carries the source rule
   over. The source's "Change Password" action becomes MahekOne's own password
   change and reset.
2. **Screen permissions.** Each employee carries a list of permitted screens
   (`Employee Details → Ux Permission`): *Leave Monitor, Absent Finder
   Dashboard, Performance Point, Admin Pannel, ALL Staff Pending Check Out,
   Employee Leave, Apply Leave Request*. In HRMS these become **HRMS module
   access** per person, granted on MahekOne's one Access screen (spec §2.3).
   The source's second list, `Permissions`, is not read by any screen in the
   source; it is migrated as a read-only legacy value.
3. **Special powers.** These are hard-coded in the source against the admin
   role, seven email addresses and four named individuals. HRMS turns them into
   named **capabilities** granted to people (§5.3). No email address or name is
   hard-coded.
4. **Row scope.** Most lists in the source are filtered to "my rows" for staff
   (by the signed-in user's name) and show everything to admin / HR. HRMS keeps
   exactly this as **scope**: *mine*, *my team* (department heads, by the
   Report-To position) and *all* (holders of the matching capability).

---

## 3. Modules

### 3.1 Module list

These are HRMS's modules. Each one is a navigable area and a unit of access.

| # | Module | Source equivalent | Summary |
|---|---|---|---|
| H01 | **Attendance** | Make Attendance, Your Attendance History, Attendance Monitor, Attendance By Officer, Absent Finder Dashboard, pending check-out views, QR attendance (off) | Geo-fenced check-in/out with photos; my history; the attendance register for team / all; officer-marked attendance; pending check-outs; absentee finder; attendance chart; import/export |
| H02 | **Leave & Holidays** | Your Leave Request, Apply Leave Request, Leave Monitor (Leave Calendar, Pending, Employee Leave, Leave Setup, Holiday Setup) | Apply (self, or on behalf of field staff), approve / reject with paid-leave split, calendar, monthly leave credit, holiday calendar tagged to employees |
| H03 | **Overtime** *(off by default, as in source)* | OT, Your OT | OT before or after duty, derived from attendance |
| H04 | **Monthly Attendance Reports** | Your Monthly Reports, Monthly Employee Reports | Per employee per month: attendance count, late counts, half-days, missing dates, percentages; export |
| H05 | **Payroll** | Salary dashboard: Payroll, Salary Slip, Advanced Payment, Given Advanced Form | Monthly salary computed from attendance, leave and holidays; PF / ESIC / PT; late-mark deduction; advance recovery; approve → pay (UTR) → payslip PDF; advances ledger |
| H06 | **Expenses** | Expenses (Sales Expences) | Expense claims and expenses paid per employee, verification, monthly and total balance, export |
| H07 | **Tasks** | Task Management (Admin), Task Management (Staff), Buddy Task, Share Buddy Task, Task Verification | Task templates (daily / weekly / monthly), today's checklist, assigned to-dos with verification, buddy tasks, weekly not-done history, Task EOD to WhatsApp |
| H08 | **Performance** | KPI KRA, KPI KRA Sales, Performance, Staff Performance, Performance Point, charts, Employee of The Month | Daily sales KPI entry, daily sales performance score, monthly staff performance, period performance points with review form and PDF, Employee of the Month |
| H09 | **Sales Desk** | Customer Details, Customer Request (admin), Complaint Status (Staff), Calling Data, Sales Activity, Journey Planner | Customer details and deactivation requests; back-office area calling with follow-ups; sales activity log; journey plans on a calendar |
| H10 | **Employees** | Employee Sign Up, Security & Permission, Your Profile, Employee ID | Employee directory and record, sign-up, activate / deactivate, ID cards, my profile |
| H11 | **Offices & Timings** | Set Office Location, Set Staff Timing (Admin Pannel) | Office locations with geofence radius and attendance QR code; each employee's weekly in/out timing |
| H12 | **Assets** | My Assets (Inword Asset), Asset Managemnet | Asset stock-in, assignment to employees with photos, restore, stock and in-use counts |
| H13 | **Help & Grievance** | Help Us, EMP-Help, Grievance, Grievance (Staff) | Attendance/leave help requests with admin approval; grievances to CEO / HR / Company with solution and star feedback |
| H14 | **Documents** | Documents, Documents (For Staff) | Company documents (PDF/audio, image, video, link) tagged to employees |
| H15 | **Notifications** | Notification | Write a notification to a person; notification list |
| — | **Settings** | *(the sheet's value lists)* | Editable reference lists and HRMS settings (thresholds, payroll rates, QR attendance and Overtime switches) |

Shared MahekOne facilities used instead of rebuilding (see §3.2): sign-in,
Access screen, notifications bell, global search, "Tell us" feedback, help
videos library.

### 3.2 One screen per function (the de-duplication map)

Every row below is a place where the source reaches **one** function through
**several** screens. HRMS builds one.

| Function | Source screens that do it | HRMS screen |
|---|---|---|
| My attendance history | *Your Attendance History* (menu) and again inside *Attendance Monitor* | H01 My attendance |
| Check in / out | *Make Attendance* (bottom bar) and again inside *Attendance Monitor* | H01 Check in (home) |
| Attendance register | *Today's Attendance*, *All Attendance*, slice *ALL Today Attendance*, *Attendance By Officer* | H01 Attendance register (date filter; scope mine / team / all) |
| Pending check-outs | *Your Pending Check Out*, *ALL Staff Pending Check Out*, slice *Staff Pending Check Out* | H01 Pending check-outs (scope) |
| Marking attendance for others | *Attendance By Officer_Form*, *ALL Today Attendance_Form* | H01 "Mark attendance for staff" action on the register |
| Absentees | *Absent Finder Dashboard* (Absent Finder_Detail + Absent Result + ALL Staff Pending Check Out) | H01 Absentees (date picker) |
| Attendance QR | *Make Attendance QR Code*, *Your Attendance History Qr Code*, *All QR Code Attendance* | Folded into H01 as a second check-in method (off by default) |
| Leave requests | *Your Leave Request* (bottom bar), same view again in *HR Pannel*, *Apply Leave Request* form, *Employee Leave* (twice in *Leave Monitor*), *Pending*, slice *Staff Request individual.* | H02 Leave: My leave · Approvals · All requests · Calendar; one "Apply leave" form |
| Holidays | *Holiday Setup* in *Leave Monitor* and again in *HR Pannel* | H02 Holidays |
| Overtime | *OT* and *Your OT* | H03 Overtime (scope) |
| Monthly reports | *Your Monthly Reports* and *Monthly Employee Reports* | H04 Monthly reports (scope) |
| Salary | *Payroll* (register) and *Salary Slip* (employee) | H05 Payroll register (capability) · My payslips (own, paid only) — same records |
| Advances | *Advanced Payment* list and *Given Advanced Form* | H05 Advances with a "Give advance" action |
| Expenses | *Expenses* in *HR Pannel* and again in *Salary* | H06 Expenses |
| Task templates | *Task List* (admin) and *Your Task* (staff) | H07 Task templates (scope) |
| Daily checklist | *Daily Task* (admin), *Your Today Task*, *Weekly Task History (Not Done)* | H07 Daily checklist (Today · Not done this week · All) |
| To-dos | *Assign ToDo Task*, *Today ToDo Task*, *ToDo Task History (Staff)*, *Task Verification*, *Assign Today ToDo Task (staff)* form, *To Do List_Form* | H07 To-dos (Open · To verify · History); one assign form |
| Buddy tasks | *Buddy Task*, *Share Buddy Task*, slice *Buddy Task Staff*, two identical forms (*Budy Task_Form*, *Buddy Task Staff_Form*) | H07 Buddy tasks; one share form |
| KPI KRA | *KPI KRA* and *KPI KRA Sales* | H08 KPI KRA (scope) |
| Daily sales performance | *Performance* (table), slice *Sales Performance*, *Performance Chart (Admin)*, *Staff Performance Chart* | H08 Sales performance (table + chart, scope) |
| Staff performance | *Staff Performance* and *Staff Performance.* | H08 Staff performance (scope) |
| Employee of the Month | Card inside *Attendance Monitor* | H08 Employee of the Month (linked from H01) |
| Customers | *Customer Details*, *Active Customers For Calling*, *Deactive Customers*, *Pending Deactivation Request*, slice *Active Customers* | H09 Customers (status filter) |
| Calling | *Calling Data*, *Calling Followups*, *Followup Dates*, *Calling History* | H09 Calling (To call · Follow-ups due · History · All) |
| Help requests | *Help Us* (staff), *EMP-Help* (admin), slice *staff help* | H13 Help requests (scope) |
| Grievances | *Grievance* (admin) and *Grievance (Staff)* | H13 Grievances (scope) |
| Documents | *Documents* and *Documents (For Staff)* | H14 Documents (manage vs tagged-to-me) |
| Office settings | *Set Office Location* (card) and *Official Settings* detail | H11 Offices |
| Employee record | *Employee Sign Up*, *Security & Permission*, *Your Profile*, *Employee ID* gallery | H10 Employees (directory + record) · My profile |
| App issues | *Help* with type "App Issue" | MahekOne "Tell us" feedback (already in every app header) |
| Screen permissions | *Security & Permission* → Ux Permission action | MahekOne Access screen |
| Sign-in | *Settings* form (User ID, Password) | MahekOne sign-in |
| Search / assistant | *Assistant* view | MahekOne global search |
| Help videos | *Helpful Video* table (no list screen in the source) | The shared help-video library |

---

## 4. Functional requirements (summary)

The full logic for every item below is in `02-HRMS-FUNCTIONAL-SPEC.md`. This
section states what each module must let people do.

### 4.1 Attendance (H01)

- **Check in** once per day, stamped with date, time, GPS position, office and
  an optional photo. Refused when the person is further from their office than
  the office's radius ("You are out of office location ! Please Back To Office
  {name} Then Try to Check in Again!"); admin and HR may check in within 9 km.
  Refused a second time on the same day ("You Today Already Checked In!").
- **Late beyond grace**: when the check-in is more than 30 minutes after the
  person's official in-time for that weekday, the check-in is refused for
  ordinary staff with "Late Punch-in, Today Unpaid Leave. Contact Admin"; admin
  and HR can enter it with a remark (spec §6.2, anomaly A03).
- **Check out** (with photo) under the same geofence; unplanned stoppage can be
  recorded and is subtracted from the day's working hours.
- Derived per day: official in/out time and target duration (from the weekly
  staff timing), late or early duration, a late / early remark in the source's
  words, total working hours, working-hour %, Full Day (≥ 60%) or Half Day,
  current status (On Working / Present).
- **My attendance** (history) and **my pending check-outs**.
- **Attendance register** for team (heads) and all (admin / HR) — grouped by
  month, year, employee and date, with quick edit of remarks; admin can set the
  check-in time, check out on someone's behalf, edit, delete, import and export.
- **Mark attendance for staff** (heads, admin, HR): pick an active Sales /
  Other employee of your office not yet marked today (admin / HR: any active
  employee), excluding heads.
- **Check out by officer** with a time prompt.
- **Pending check-outs** across staff (Ux permission).
- **Absentees**: pick a date; list active employees with no attendance that
  day, not on a tagged holiday, not on leave.
- **Attendance chart**: attendance count per employee (histogram with trend).
- **QR attendance** (off by default): check in by scanning the office QR code.

### 4.2 Leave & Holidays (H02)

- **Apply leave** (Leave or Half Day), start and end date (same month only;
  a second request with the same start date is refused), full reason. Shows
  available paid leave for the month and available unpaid leave for the year.
- **Apply on behalf** (Ux permission "Apply Leave Request"): for active Sales /
  Other staff of your office.
- **Approvals queue** (requesting): Approve (prompt for the number of paid
  leave days; unpaid = duration − paid; checks available paid and unpaid
  balances), Reject, Admin remark. Stamps approver, date and time.
- **All requests** with status flags; **Leave calendar** (month view).
- **Monthly leave credit**: on the 1st of each month every active employee is
  credited their *Monthly Paid Leave* for that month (Leave Setup). Manual
  entries and edits allowed to admin.
- **Holidays**: date, category (Festival / Weekly / National / Nature holiday),
  name, tagged employees, remark; bulk add ("Add more holidays"), import and
  export; edits allowed only for dates in the last 366 days.

### 4.3 Overtime (H03) — off by default

One OT record per employee per date: Before Duty (from check-in to official
in-time) or After Duty (official out-time to check-out), OT hours derived and
refused under 10 minutes ("OT not Applicable"); monthly OT total.

### 4.4 Monthly Attendance Reports (H04)

Per employee per month: days attended, office open days, late count, late more
than 10 minutes, early (on-time) count, check-in %, overall monthly % (achieved
÷ target hours), total late duration on full days, half days, missing dates,
leave dates, holiday dates, remark; the highest achiever's seconds. Export.

### 4.5 Payroll (H05)

- **Salary run** for the previous month: one salary per active employee per
  month ("This Month Salary Paid"). Blocked while the employee has pending
  check-outs in the month ("Your Pending Checkout Count is n"), and while the
  day count does not reconcile ("Kindly Check Count Leave/Attendance n Days
  Missing").
- Computation exactly as the source: full days, half days, paid / unpaid leave,
  leave days, holidays during leave, official holidays, compensation days;
  basic (pro-rata), incentive, conveyance (pro-rata), special allowance
  (compensation days), gross; employee PF 12% (capped ₹1,800), ESIC 0.75%
  (gross < ₹21,000), PT (Maharashtra slabs by gender, February ₹300); advance
  deduction (defaults to the outstanding advance balance); late-mark deduction
  (half-days by late count); gross deduction; salary in hand; other payment;
  employer PF 13%, employer ESIC 3.25%, CTC; bank details.
- **Approve** (stamps approver), then **Pay** (prompt UTR number and payment
  date; stamps preparer). **Payslip PDF** generated automatically; Regenerate.
- **My payslips**: the employee's own salaries once paid (UTR present), with the
  PDF.
- **Advances**: give an advance (date, employee, amount, remark); running
  outstanding balance per employee (advances − salary deductions).
- Export of the salary register.

### 4.6 Expenses (H06)

Expense Claim or Expense Paid entries per employee: date, location, category
(Local Travel, Travel, Hotel Stay, Stationary, Food, Extra), particular,
amount, reason; paid entries are verified on entry, claims need verification;
monthly balance and total balance (verified claims − verified payments);
export.

### 4.7 Tasks (H07)

- **Task templates** per employee: task, frequency (Daily / Weekly / Monthly),
  weekdays (daily / weekly) or day of month and "before date" (monthly),
  category for monthly (Urgent and Important / Important / To-Do Only),
  start and end time; "Add more task".
- **Take my task**: copies today's weekday tasks into today's checklist (once a
  day). **Take monthly task**: copies monthly templates into the to-do list for
  this month (once a month).
- **Daily checklist**: Done (stamps time), Not Done (undo), N/A with reason,
  remark; time difference vs the task's end time; weekly not-done list.
- **To-dos**: assign to any employee with for-date, till-date, category, task;
  Done (confirmation; refused after the till-date), Not Done, remark; the
  assigner or admin Verifies; the assigner can set it back to Pending; working
  speed (days to complete).
- **Buddy tasks**: share one of your tasks for today with a colleague; the
  buddy accepts, then marks done.
- **Task EOD**: a formatted end-of-day summary (totals, done, pending, N/A with
  reasons, overdue to-dos) sent to WhatsApp.

### 4.8 Performance (H08)

- **KPI KRA** (sales staff, daily): area visited, visits, productive counters,
  litre sales, km travelled, unplanned stop, amount of sales, outstanding;
  punch in/out and time remark from attendance; on-field time.
- **Sales performance** (daily score out of 100): visits 10, time with customer
  5, description length 5, working hours 10, km 5, sales amount 20, litre sales
  20, outstanding 20, tasks 5; daily targets = monthly targets ÷ 25; chart.
- **Staff performance** (monthly, office "Mahek Marketing India" staff):
  working-hours %, on-time punctuality %, daily task (or KPI for sales) %,
  to-do performance, buddy-task performance, overall %; working speed text.
- **Employee of the Month**: overall ≥ 90%.
- **Performance points** (any date range): attendance, punctuality, working
  hours, tasks, and for sales: sales amount, litre sales, outstanding, time with
  customer, description; total by position; the review form ("LION form":
  issues faced, opportunities, next meeting plan, action for Sir); PDF report
  with regenerate.

### 4.9 Sales Desk (H09)

- **Customers**: name, address, mobile, alternate, rating (High / Medium / Low
  value), segmentation, area, state, sales person, tagged employee, special
  instructions, back-office employee, status (Active / Deactive, admin only);
  their activities and calls.
- **Deactivation requests**: a non-admin requests with a reason, can withdraw;
  admin accepts (customer → Deactive) or rejects; admin can re-activate.
- **Calling**: "Take follow-up" copies all active customers of an area where
  you are the back-office employee into your calling list (not if already
  called today); the calling form records status (Call Not Pick Up / Order
  Received / No Requirement / Reminder Call Back), second status, discussion
  note, follow-up date; follow-ups due; last 10 days' history; total orders and
  a suggestion ("Do FollowUp" / "Do Deactivate This Customer").
- **Sales activity**: salesperson, customer, date, time given (minutes),
  meeting note, issue, reminder date, mood, meeting type and purpose, area.
- **Journey planner**: employee, start / end date, location, plan, customers,
  remark, attachment; month calendar.

### 4.10 Employees (H10)

Directory grouped by status (inactive flagged red), full employee record
(personal, contacts, addresses with map, bank, position type and position,
office, report-to, joining / birth / anniversary / children's birthdays, salary
allocate, conveyance (sales), other salary, company mobile, Aadhaar (12 digits,
admin-editable), photo, sales targets (sales only), date of leaving, monthly
paid leave and yearly maximum leave (admin), PF/ESIC with UAN and ESIC number),
live working age, and every related record (attendance, timings, help, ID card,
advances, salaries, leave). Actions: sign up (add), edit, activate, deactivate,
upload photo, call / message / email, map, delete (admin). **My profile** for
every employee. **ID cards** gallery.

### 4.11 Offices & Timings (H11)

Offices: name, geofence radius (≤ 20,000 m), map pin, address, opening and
closing time, timing type (Full Day / Half Day / 24*7), duration, official paid
leave, image, attendance QR code text and its QR image. Staff timing: per
employee per weekday in-time, out-time, duty duration; "Add more time".

### 4.12 Assets (H12)

Stock-in: purchase date, asset name, category (Stationery / Tangible Assets /
Other), cost, quantity, description, location (office), warranty, invoice and
asset images (tangible), available stock. Assignment: asset, date, quantity,
from, to, responsibility & suggestion, two photos, status Assigned / Restored,
"Restored asset" prompt (date, by, quantity, remark, photo); in-use count.

### 4.13 Help & Grievance (H13)

- **Help requests**: type Other Help with issue (I Forgot Make Attendance, I
  Late Check In, I Forget Check Out, I Am Late Today, OT Not Approved, I Want
  to Lean App, Other), in / out time where relevant, text; admin remark
  (required for "I Am Late Today") and Approve. The source's "App Issue" type
  (Location Error, Login Issue, Password Issue, Other Technical Issue, with a
  required screenshot) is raised through MahekOne's "Tell us" feedback instead,
  so one app-issue channel serves every app.
- **Grievances**: issue to CEO / HR / Company (or a named employee), text;
  admin gives the solution (status Solve); the raiser rates it 1–5 stars.

### 4.14 Documents (H14)

Title, type (PDF File & Audio / Image / Video / Link), the file or link,
description, date, tagged employees. Managers see all and add; staff see those
tagged to them; open file / link / video.

### 4.15 Notifications (H15)

Write a notification (by, for, text); it is delivered to the recipient in
MahekOne's notification bell; list newest first with delete, edit, and email
sender / receiver.

---

## 5. Access, identity and scope

### 5.1 Sign-in

HRMS uses MahekOne's single sign-in (work number or email). The source's
Employee-ID-and-password form is replaced by it. An employee marked **Inactive**
in HRMS cannot sign in (their MahekOne sign-in is disabled with the status
change, and enabled again on activation).

### 5.2 Module access

Each HRMS module is granted on MahekOne's Access screen, per person. The Ux
Permission names map as follows (full table in spec §2.3): *Leave Monitor* →
H02 Approvals, All requests, Calendar, Leave setup, Holidays; *Absent Finder
Dashboard* → H01 Absentees; *ALL Staff Pending Check Out* → H01 Pending
check-outs (all); *Employee Leave* → H02 All requests; *Apply Leave Request* →
capability "apply on behalf"; *Performance Point* → H08 Performance points;
*Admin Pannel* → H11 Offices & Timings, H10 sign-up, H14 manage, H13 resolve,
H08 performance chart (all).

### 5.3 Capabilities

| Capability | Held in the source by | What it allows |
|---|---|---|
| `hrms.employee.manage` | admin; HR email | Add (sign up) and edit employees |
| `hrms.employee.admin` | admin | Activate / deactivate, delete, edit Aadhaar, see and edit monthly paid leave and yearly maximum leave |
| `hrms.attendance.all` | admin; HR email | Attendance register (all), attendance chart, check in / out up to 9 km from office, save a late (>30 min) check-in with remark |
| `hrms.attendance.edit` | admin | Edit attendance, set check-in time, delete, import |
| `hrms.attendance.officer` | admin; anyone whose Position ends in "Head" | Mark attendance for staff; check out by officer; team register |
| `hrms.leave.approve` | admin | Approve / reject, set paid leave, admin remark, edit / delete requests |
| `hrms.leave.applyOthers` | Ux permission "Apply Leave Request" | Apply leave on behalf of active Sales / Other staff of your office |
| `hrms.leave.setup` | admin (holidays: admin, HR email) | Leave setup; holiday add / edit (last 366 days) / import / export / delete |
| `hrms.ot.manage` | (OT screens hidden in source) | See all OT |
| `hrms.reports.all` | admin | All monthly reports, export |
| `hrms.payroll.run` | admin; CEO email; two named payroll clerks | Payroll register, add salary, approve, pay |
| `hrms.payroll.admin` | admin; office email | Delete a salary; export the register |
| `hrms.advance.manage` | admin; office email (view); one named advance clerk (give) | See all advances; give an advance; edit / delete (admin) |
| `hrms.expense.manage` | admin; HR email; office email | Expenses of everyone; verify (admin); export (admin, HR) |
| `hrms.task.manage` | admin | Task templates and daily checklists of everyone, assign to-dos to anyone, verify any to-do, edit / delete templates |
| `hrms.performance.manage` | admin; HR email | Add / edit daily sales performance; staff performance (all); performance chart (all) |
| `hrms.sales.all` | admin; HR email; two sales emails; CEO email (calling) | KPI KRA of everyone; sales activity; customers; journey planner; all calling data |
| `hrms.journey.anyone` | one named person | Plan journeys for any employee, not only sales staff |
| `hrms.customer.decide` | admin | Accept / reject deactivation; re-activate; set customer status; delete calling data |
| `hrms.customer.delete` | admin; HR email | Delete customers, activities, documents |
| `hrms.help.resolve` | admin | Help requests of everyone; approve; admin remark |
| `hrms.grievance.resolve` | admin | All grievances; give solution |
| `hrms.documents.manage` | admin; HR email; office email | Manage documents |
| `hrms.assets.manage` | admin; HR email; office email | Asset stock-in, assignments of everyone |
| `hrms.timing.manage` | admin; CEO email | Staff timings |
| `hrms.office.manage` | admin | Office locations |

Every capability is enforced on the server as well as in what is shown.

---

## 6. Home

The source opens on **Make Attendance** (its login form finishes there). HRMS
does the same: the home screen is today's check-in card, followed by the
signed-in person's items that are waiting today — their pending check-outs,
today's checklist, open to-dos and accepted buddy tasks, and, for people who
hold them, the approvals queue count, the pending check-out count and the
help / grievance counts. Every item is a link to its screen; nothing is shown
that the person cannot open. No figure is shown that the source does not
already compute.

---

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| Platform | The existing MahekOne `hrms` app, in the same Next.js / Postgres codebase, sharing the database, sign-in, launcher, app access and module access. The unbuilt "Attendance & People" placeholder app is retired into HRMS, so there is one people app. |
| Mobile | Every screen works at phone width: most staff check in from a phone browser. Field staff on MBOS keep using the handset; its attendance, leave and holidays are the same records (§8). |
| Shared services | Every read and write lives in shared services, not in page code, so MBOS and a later HRMS mobile app use the same rules. |
| Derived values | Working hours, late / early, full / half day, leave balances, report figures, salary figures and performance scores are computed from source records and can be rebuilt. A salary, once approved, keeps the figures it was approved with. |
| Numbering | Employee IDs, task template serials and expense serials are allocated safely under simultaneous use (the source uses random numbers and "max + 1"). |
| Money | Stored as integer paise, formatted only for display. PF, ESIC and PT rates, caps and slabs are configuration. |
| Time | Business dates and times are Asia/Kolkata. |
| Location | Check-in and check-out record the device position with its accuracy; distance to the office is computed on the server. |
| Photos and files | Check-in / check-out photos, employee photos, ID cards, help screenshots, asset images, documents, journey attachments, payslip and performance PDFs are stored with access following their record. |
| Audit | Every create, edit, delete, approval and status action records who and when. |
| Deletion | Delete exists where the source has it, restricted as in the source and confirmed. |
| Export | Each screen that exports in the source exports a CSV of the rows shown (attendance, QR attendance, reports, holidays, expenses, salary). |
| Import | Attendance import and holiday import accept CSV in the source's columns, with a preview and row-level errors. |
| Configuration | Open enum lists (bank names, areas, segmentation, states, issues, meeting types and purposes, locations, particulars, holiday names, asset names, notification recipients) are editable reference lists. Thresholds (grace minutes, full-day %, late bands, PF / ESIC / PT, working-day divisors, performance weights) are configuration. |
| Performance | Lists are paginated and searchable; monthly figures stay fast with years of attendance. |

---

## 8. Integration with the rest of MahekOne

HRMS is one app in a suite that already holds some of the same things. The rule
is **one record per real-world thing**, and **one screen per function**.

| Source table | Already in MahekOne | Requirement |
|---|---|---|
| Employee Details | The HRMS employee master (today a read-only mirror of this same tab, synced every minute) | HRMS becomes the author of the employee record. The sheet sync is retired at cut-over (Q1). Screens that read the mirror (Sales Dashboard salary, access grants, org chart) keep reading the same table. |
| `_Per User Settings` (login) | MahekOne sign-in and sessions | Replaced; no HRMS login form. |
| Ux Permission / Permissions | MahekOne app access and module access | Ux Permission becomes HRMS module access (§5.2); Permissions migrated read-only. |
| Attendance | MBOS attendance days for field salesmen (check-in with selfie, geofence, sessions). The sign-in log table named `attendance` is **not** attendance. | HRMS attendance is the attendance record for everyone. A field salesman's MBOS day is his attendance for that day and appears in the HRMS register, reports and payroll; he is not asked to check in twice (Q3). |
| Staff Request (leave) | MBOS leave requests and leave balances | One leave system. MBOS's leave screen is the handset door into the same requests; the source's rules (paid / unpaid split on approval, monthly paid credit, yearly unpaid maximum) govern (Q4). |
| Holiday Setup | MBOS holidays | One holiday calendar; it gains category, tagged employees and remark. |
| Customer Details | MahekOne customers (already imported from this very tab by the customer-master sync) | H09 reads and writes the MahekOne customer; fields the customer lacks (rating, segmentation, special instructions, tagged employee, deactivation request) are added to it. |
| Activity | Field activity: MBOS visits, plus this tab's history already synced onto the customer timeline | H09 Sales activity shows the same records; adding an activity from the web writes the same record a handset visit writes. |
| Journey Planner | MBOS tours (start, end, cities, purpose) | One journey record; tours gain customers, remark and attachment (Q5). |
| Calling Data | The CRM's calls on the customer timeline | Each calling row is also recorded on the customer's timeline so every app sees the contact (Q6). |
| KPI KRA, Performance, Performance Point, Staff Performance | Sales Dashboard targets and salesman score | HRMS keeps the source's appraisal model exactly. Where MahekOne already holds a KPI input (visits, sales amount, litres, outstanding, km), the KPI entry form pre-fills it and says where it came from; the person can still change it (Q7). |
| Sales Expences | MBOS expense claims | One claim record: MBOS claims appear in H06 as claims; H06 adds payments and verification (Q8). |
| Mehak Documentation | MBOS document library | One document library; it gains per-employee tagging and the Image / Video / Link types. |
| Helpful Video | The shared help-video library | HRMS links to it; no second library. |
| Notification | MahekOne notifications (the bell) | Writing a notification delivers it to the recipient's bell. |
| Help (App Issue) | MahekOne "Tell us" feedback | App issues go there. |
| Advance Payment / Employee Salary | — | New in HRMS. |

---

## 9. Additions that are not in the source, and why each is needed

| Addition | Needed by |
|---|---|
| MahekOne sign-in instead of an ID/password form | Replaces the source's own sign-in (§5.1) |
| Capabilities instead of hard-coded emails and names | Keeps the source's special powers without code changes when people change (§5.3) |
| One screen per function with scope (§3.2) | The client's instruction that no feature appears twice |
| Server-side scheduled jobs (monthly leave credit, payslip and performance PDFs, notification delivery) with a manual re-run | The source runs these as AppSheet automation bots; on the web they become idempotent jobs |
| Concurrency-safe numbering | The source's random IDs and "max + 1" collide |
| Editable reference lists for open enums | The source keeps these values in the sheet; the web needs a place to edit them |
| Settings for switched-off features (QR attendance, Overtime) | They exist in the source but are hidden from everyone |
| Audit trail | Replaces the source's "User / Timestamp / Create By" columns faithfully across edits |
| Anomaly fixes (spec §19) | Where a source formula contradicts its evident intent, HRMS implements the intent. Each case is listed for sign-off. |
| KPI pre-fill from MahekOne data | Avoids entering the same figure twice in two apps (§8) |
| Bell notifications when a leave request is decided, a help request or grievance is answered, or a to-do is assigned | In the source these outcomes are statuses the person has to go and look at; MahekOne tells the affected person of a decision (spec §18.5). The screens and statuses are unchanged. |

---

## 10. Out of scope

Anything not in the source. That includes biometric devices, shift rostering
beyond the weekly timing, statutory filing (PF / ESIC / PT returns), Form 16 and
income tax, bank payment files, gratuity and full-and-final settlement,
recruitment, appraisals beyond the source's performance screens, the "One Time
Task" and "Repeated Task" tables (referenced by three source actions but not
defined in the document — Q9), and a native HRMS mobile app.

---

## 11. Open questions for the client

1. **Q1 Cut-over.** Does HRMS replace the *Employee Details* workbook on day one
   (sheet sync retired), or run alongside it for a period?
2. **Q2 Special people.** Who holds each capability in §5.3? The source ties
   them to the admin role, *hr.mahekmarketinginda@gmail.com*,
   *mahekmarketingindia@gmail.com*, *mahekmarketingindiaceo@gmail.com*,
   *mahekmarketing1@gmail.com*, *sales.mahek2025@gmail.com*,
   *mahekmarketing.sales@gmail.com*, and to Rohini Ashok Mohite, Pooja Ajay
   Kumar Dev, Puja Jaysing Yadruk and Pritesh Bipin Doshi.
3. **Q3 Field staff attendance.** Confirm that a salesman's MBOS check-in is his
   attendance, and that "Attendance By Officer" remains for staff without the
   handset.
4. **Q4 Leave.** MBOS has leave types; the source has Leave / Half Day with a
   paid / unpaid split decided on approval. Confirm the source model governs
   both.
5. **Q5 Journey planner.** Confirm that a journey plan and an MBOS tour are the
   same thing.
6. **Q6 Calling.** Confirm the back-office calling list stays in HRMS (it is not
   the CRM telecaller Call Log), with each call also on the customer timeline.
7. **Q7 Two performance models.** The Sales Dashboard already scores salesmen on
   a different model. Confirm HRMS keeps the source's appraisal alongside it.
8. **Q8 Expenses.** Confirm that MBOS expense claims should appear in the HRMS
   expense ledger.
9. **Q9 Missing tables.** Three source actions write notifications from tables
   "One Time Task" and "Repeated Task", which the document does not define.
   Are they from another app, and are they wanted?
10. **Q10 Empty dashboards.** The source menu has "Customer Request (admin)" and
    "Complaint Status (Staff)" with no screens inside them. HRMS assumes they
    held the customer deactivation screens and the calling screens respectively
    (both otherwise unreachable). Confirm.
11. **Q11 Anomalies.** Sign-off on each item in spec §19.
12. **Q12 Opening data.** Is history migrated in full (attendance, leave,
    salaries, advances, tasks, performance), or does HRMS open with balances
    (advance balances, leave credits for the current month)?
13. **Q13 Self-edit.** The source lets an employee update their own profile
    record. Which fields may staff change themselves (proposed: photo, contact
    numbers, addresses, email, children's and anniversary dates)?
