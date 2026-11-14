# MahekOne HRMS — Functional Specification (all features, all logic)

| | |
|---|---|
| Source | *Mahek EMP 2.0 — Application Documentation*, AppSheet export v1.002151, 26 Sep 2026, 972 pages |
| Companion documents | `01-HRMS-PRD.md` (what and why) · `03-HRMS-CLAUDE-DESIGN-PROMPT.md` (screen design brief) |
| Coverage | 40 source tables (§25), 831 columns (§4–§17), 34 slices (§21), 200 views (§20), 212 actions (§22), 43 format rules (§23), 4 automation processes (§18) |

---

## 1. Conventions and glossary

### 1.1 How to read the field tables

Each record type has a field table with these columns:

| Column | Meaning |
|---|---|
| **Field** | The HRMS name. The source column name follows in brackets where it differs, so every source column can be traced. |
| **Type** | text, long text, number, decimal, money (paise), percent, date, time, duration, date-time, enum, multi-enum, ref (a link to another record), image, file, url, phone, email, address, geo (lat/long). |
| **Rule** | *Input* — typed or picked. *Default* — pre-filled, editable. *Derived* — computed, read-only, never typed. *Stamp* — set by the system at an event. *Prompt* — asked for by an action. |
| **Logic** | Default formula, derivation, validation (with the exact error message), visibility, requiredness and who may edit. |

Messages in "double quotes" are the source's own wording and are shown to the
user verbatim (spelling tidied only where it would otherwise read as a fault:
the tidied form is given, the original follows in the §19 anomaly list).

### 1.2 Glossary

| Term | Meaning |
|---|---|
| **Employee** | A row in the HRMS employee master. Carries the MahekOne user it signs in as. |
| **Me** | The signed-in employee (source: `usersettings(user name)` / `usersettings(user id)`). |
| **My office** | The office on my employee record (source: `usersettings(your office)`). |
| **My position** | The Position on my employee record (source: `usersettings(position)`). |
| **Head** | An employee whose Position ends in "Head" (e.g. *Sales State Head*, *Production Head*). |
| **Field / other staff** | Position Type = *Sales* or *Other*. |
| **Official in / out time, target duration** | From the employee's staff timing for the weekday of the date (§5.2). |
| **Month key** | Month + year of a date. The source writes it as `month&year` (e.g. "92026"); HRMS stores a real year-month. |
| **Scope** | Which rows a list shows: *mine*, *my team* (heads: employees whose Report To equals my Position), *all* (capability holders). |
| **Working day divisor** | The fixed 25 (daily targets) or 30 (point targets) the source divides monthly targets by. Configuration. |

### 1.3 Identifiers

| Record | Source key | HRMS rule |
|---|---|---|
| Employee (Employee Id) | `"EMP-" & RANDBETWEEN(1000,9999)` | Keep the "EMP-nnnn" format for continuity; allocate the next unused number, never a random one. Migrated IDs are kept. |
| Attendance (Attend ID) | `UPPER(UNIQUEID())` | Internal id. |
| QR attendance (Attend ID) | `"QR" & UPPER(UNIQUEID())` | Internal id; the "QR" prefix is not needed once the method is a field. |
| Staff request / leave (Request ID) | `UPPER(UNIQUEID())` | Internal id. |
| Staff timing (Unique ID) | `RANDBETWEEN(10000,99999)` | Internal id. |
| Office (Office ID) | `UPPER(UNIQUEID())` | Internal id. |
| Reports (Report ID) | `UPPER(UNIQUEID()&TODAY())` | Derived report, keyed by employee + month (§9). |
| OT (OT ID) | `UPPER(UNIQUEID())` | Internal id. |
| Salary (Salary ID) | `"ES-" & RANDBETWEEN(100000,99999999)` | Keep "ES-" prefix; sequential, unique. |
| Task template (Sr. No) | `MAX(Sr. No)+1` | Sequential serial, concurrency-safe. |
| Sales expense (Sr. No.) | `MAX(Sr. No.)+1` | Sequential serial, concurrency-safe. |
| Grievance (Grievance ID) | `RANDBETWEEN(10000,99999)` | Sequential number. |
| Holiday (Holiday ID) | `"Holiday" & UPPER(UNIQUEID())` | Internal id. |
| Leave setup (Leave Assign ID) | `"Assign" & UPPER(UNIQUEID())`; automated rows `"AUTOASSIGNLEAVE"&…` | Internal id; the row records whether the monthly job or a person created it. |
| Inward asset (Asset Id) | `[Asset Name]&[Category]&RANDBETWEEN(1000,9999)` | Sequential asset code, unique. |
| Asset assignment (Track ID) | `[Asset ID]&[Asset Name]&"-"&[Assigned To]&" "&RANDBETWEEN(1000,9999)` | Internal id; the readable label is derived. |
| Calling row (CDID) | `"CD" & UPPER(UNIQUEID())` | Internal id. |
| Customer | Customer Name (the name is the key) | The MahekOne customer id; the name is a field. |
| Advance (Advance ID), To-do (To Do Task Id), KPI entry (KPI ID), Activity (Activity ID), Document (Document ID), Buddy task (Buddy ID), Staff performance (Staff Performance ID), Journey (Journey ID), Help (Help ID), Performance point (ID), Daily performance (Uniqueid), Checklist item (Task ID), Help video (VideoID) | `UPPER(UNIQUEID())` or random | Internal ids. |
| Notification (Notification ID) | `UPPER("NOTIFI" & UNIQUEID())`; automated `"AUTONOTIFI"&…` | Internal id. |

### 1.4 Common fields

Every record carries created-by, created-at, updated-by, updated-at (the audit
trail). Source columns that only stamp the creator or the time ("Timestamp",
"User", "Create By", "Entry User", "Reportstamp", "Taskstamp") are kept where a
screen shows them, and are read from the audit trail otherwise.

### 1.5 Time and money

- Dates and times are Asia/Kolkata. A "time" field is a wall-clock time on the
  record's date.
- Durations are stored in seconds and shown as h:mm:ss (or hh:mm).
- Money is stored in paise. The source's "Price" columns are money with the
  source's "Rs." symbol shown as ₹.

---

## 2. Access

### 2.1 Sign-in (source table `_Per User Settings`)

The source's login form holds: User ID (must be an existing Employee Id),
Password (must match the employee's password **and** the employee must be
active: "Please Enter Valid Password or Contact DM Maybe You are inactive
employee."), then derives User Name, Level (Position Type), Employee Status,
Your Office, Report To and Position; the form finishes on *Make Attendance*.

HRMS:

- Signs in with MahekOne's sign-in. The employee record links to the MahekOne
  user. No HRMS password column is kept (the source's plaintext password is
  never migrated).
- An employee whose status is not Active cannot sign in. Setting an employee
  Inactive (§4.3) disables the linked sign-in and ends its sessions; setting
  Active enables it.
- After sign-in, HRMS knows *me*, *my office*, *my position*, *my position
  type* and *my report-to* from the employee record; nothing is typed.
- Landing screen: H01 Check in (§6.4). The source's form ends on Make
  Attendance.

### 2.2 Scope rules

| List | Mine | My team | All |
|---|---|---|---|
| Attendance, pending check-outs | own rows | rows of employees whose Report To = my Position (heads) | `hrms.attendance.all` |
| Leave requests | own | — | `hrms.leave.approve`, or module *All requests* (Ux "Employee Leave") |
| OT, monthly reports, payslips, advances, expenses, KPI KRA, sales performance, staff performance, help, grievances | own | — | matching capability |
| Tasks | own templates, own checklist, to-dos assigned to or by me, buddy tasks where I am sender or buddy | — | `hrms.task.manage` |
| Documents | tagged to me | — | `hrms.documents.manage` |
| Calling | rows I created | — | `hrms.sales.all` |

Source security filters are kept as **default list windows**, not as limits on
the data: attendance 400 days, sales activity 500 days, to-dos and checklist
from today (see anomaly A35). Each list has a date filter to reach older rows.

### 2.3 Ux Permission → HRMS access

| Source Ux Permission value | Source screen it opens | HRMS grant |
|---|---|---|
| Leave Monitor | Leave Monitor dashboard (Leave Calendar, Pending, Employee Leave ×2, Holiday Setup, Leave Setup) | H02 screens *Approvals*, *All requests*, *Calendar*, *Leave setup*, *Holidays* (each still needs its own capability to change anything, as in the source) |
| Absent Finder Dashboard | Absent Finder_Detail, Absent Result, ALL Staff Pending Check Out | H01 *Absentees* |
| ALL Staff Pending Check Out | ALL Staff Pending Check Out | H01 *Pending check-outs* with scope *all* |
| Employee Leave | Employee Leave | H02 *All requests* |
| Apply Leave Request | Apply Leave Request form | `hrms.leave.applyOthers` |
| Performance Point | Performance Point | H08 *Performance points* |
| Admin Pannel | Performance Chart(Admin), Set Staff Timing, Set Office Location, Employee Sign Up, Documents, EMP-Help, Grievance | H11 module + H10 *Sign up* + H14 manage + H13 resolve + H08 chart (all); each inner screen keeps its own condition (admin, HR, CEO) |

The source's `Permissions` column is read by no screen. It is migrated as a
read-only "Legacy permissions" value on the employee record.

### 2.4 Module visibility (source menu conditions)

| HRMS screen | Source condition carried over |
|---|---|
| H01 Check in, My attendance, My pending check-outs | signed in |
| H01 Attendance register (all), attendance chart, Today's attendance | admin or HR (`hrms.attendance.all`) |
| H01 Attendance register (team), Mark attendance for staff, Check out by officer | admin or Head (`hrms.attendance.officer`) |
| H01 Absentees | Ux "Absent Finder Dashboard" |
| H01 Pending check-outs (all) | Ux "ALL Staff Pending Check Out" |
| H02 My leave, Apply | signed in and not admin (admins apply on behalf through Approvals) |
| H03 Overtime | hidden from everyone in the source → setting `hrms.ot.enabled` (default off) |
| H04 My monthly reports | signed in, not admin; all: admin |
| H05 My payslips | signed in |
| H05 Payroll register | admin, CEO, the two payroll clerks (`hrms.payroll.run`) |
| H05 Advances | admin (list); advance clerk (give) |
| H06 Expenses | admin, HR, office |
| H07 Task templates (all), Assign to-do (all), Daily checklist (all), Task verification | admin |
| H07 My templates, today's checklist, weekly not-done | signed in, not admin, position type not Sales |
| H07 To-dos, Buddy tasks | signed in |
| H08 KPI KRA (mine) | position type Sales; (all): admin, HR, two sales emails |
| H08 Sales performance (all), chart (all) | admin, HR |
| H08 Sales performance chart (mine) | signed in, not admin |
| H08 Staff performance | mine: signed in, not admin; all: admin |
| H08 Performance points | Ux "Performance Point" |
| H08 Employee of the Month | inside Attendance Monitor (admin, HR) |
| H09 Customers, Sales activity, Journey planner | admin, HR, sales emails |
| H09 Deactivation requests, Deactive customers | admin (see Q10) |
| H09 Calling (mine) | signed in, not admin/HR/office (see Q10); all: CEO |
| H10 Employee directory, Sign up | admin, HR |
| H10 Security & permissions | admin, CEO → MahekOne Access screen |
| H10 ID cards | admin |
| H10 My profile | signed in |
| H11 Offices | admin; Staff timings: admin, CEO |
| H12 Assets | admin, HR, office (My Assets additionally requires being signed in) |
| H13 Help (mine) | signed in, not admin; all: admin |
| H13 Grievances (mine) | signed in, not admin; all: admin |
| H14 Documents (manage) | admin, HR, office; (tagged to me): signed in |
| H15 Notifications | everyone |

---

## 3. Reference lists (editable, "Settings → Reference lists")

The source leaves these enums open (values typed into the sheet). HRMS keeps
each as an editable list. Retired values stay readable on old records.

| List | Used by | Seed values from the source |
|---|---|---|
| Bank names | Employee → Bank Name | *(open in source; seed from migrated data)* |
| Position types | Employee → Position Type | Sales, OfficeStaff, Other |
| Positions | Employee → Position | Sales State Head, Sales Executives Level3, Sales Executives Level 2, Sales Executives Level1, Ambernath Office, Production Head, DeliveryStaff |
| Areas | Employee → Area Allocated; KPI → Area Visited | *(open)* |
| Holiday categories | Holiday → Category | Festival Holiday, Weekly Holiday, National Holiday, Nature Holiday |
| Holiday names | Holiday → Holiday Name | *(open)* |
| Expense categories | Expense → Categories | Local Travel, Travel, Hotel Stay, Stationary, Food, Extra |
| Expense particulars | Expense → Particular | *(open)* |
| Expense locations | Expense → Location | *(open)* |
| Customer segmentation | Customer → Segmentation | *(open)* |
| States | Customer → State | *(open)* |
| Activity issues | Activity → Issue | *(open)* |
| Moods | Activity → Mood | Happy, Normal |
| Meeting types | Activity → Meeting Type | *(open)* |
| Meeting purposes | Activity → Meeting Purpose | *(open)* |
| Journey locations | Journey → Location | *(open)* |
| Asset names | Inward asset → Asset Name | Visiting Card |
| Notification recipients | Notification → For | *(open; employee names)* |
| Task frequencies | Task template → Frequency | Daily, Weekly, Monthly |

Fixed lists (not editable, because rules depend on the exact value): gender,
Yes/No, request type, request status, timing type, week names, month names,
to-do status, recheck status, task category, calling status, customer status,
rating, document type, asset category, asset status, grievance status, feedback
stars, grievance recipients, help types and issue types, OT slot, expense
payment type, verify.

---

## 4. Employees (H10) — source table `Employee Details`

### 4.1 Employee record

| Field | Type | Rule | Logic |
|---|---|---|---|
| Employee ID (Employee Id) | text | Default, unique | "EMP-" + next free 4-digit number (§1.3). Key. |
| Name (Name Of Employee) | text | Input, required | |
| Gender | enum | Input | Male / Female (buttons). Drives PT (§10.2). |
| Office (Office Name) | ref → Office | Input | Must be an existing office (Valid_If `Official Settings[Office Name]`). |
| Report To | enum | Input | Pick from the **positions** held by employees whose Position ends in "Head" (the source stores a position, not a person). Defines *my team* for that head. |
| Address | address | Input | Geocoded; "View map". |
| Personal mobile (Personal Mobile No.) | phone | Input | Call, message. |
| Emergency contact number | phone | Input | Call, message. |
| Permanent address | address | Input | Geocoded; "View map". |
| Bank name | enum (ref list) | Input | Open list. |
| Account number | text (digits) | Input | Stored as text to keep leading zeros. |
| IFSC code | text | Input | |
| Alternate number | phone | Input | Call, message. |
| Position type | enum | Input | Sales / OfficeStaff / Other (open list). |
| Position | enum | Input | Positions list (open). |
| Date of joining | date | Input | |
| Date of birth | date | Input | |
| Status | enum | Stamp | Active / Inactive. Set only by Activate / Deactivate (§4.3). A new employee starts **blank** in the source; HRMS starts Active on sign-up (see A48). |
| Marriage anniversary (Marrage Anniversary) | date | Input | |
| Email | email | Input | "Compose email". |
| Child 1 birthday, Child 2 birthday (Date Of Child-1 Birthday, Date Of Child-2 Birthday) | date | Input | |
| Salary allocated (Salary Allocate) | money | Input | Monthly fixed salary; base of payroll. |
| Conveyance | money | Input | Visible and used only when Position type = Sales. |
| Other salary | money | Input | Paid separately as "Other payment" (§10.2). |
| Company mobile (Company Mobile No.) | phone | Input | Call, message. |
| Aadhaar number (Adhar Number) | text (12 digits) | Input | Must be exactly 12 digits: "Enter 12 Digit Valid Adhar Number". Editable only with `hrms.employee.admin`. Shown masked (last four) to everyone else. |
| Photo | image | Input | Also "Upload employee image" action (§4.3). |
| Area allocated | enum (Areas) | Input | Visible and **required** when Position type = Sales. |
| Visit target | number | Input | Sales only (monthly). |
| Km target | number | Input | Sales only (monthly). |
| Litre sales target (Liter Sales Target) | number | Input | Sales only (monthly). Source types it as Price; it is litres. |
| Working hour target | number | Input | Sales only (monthly hours). |
| Amount of sale target | money | Input | Sales only (monthly). |
| Date of leaving (Date of Leave) | date | Input | An employee with a date of leaving is excluded from sales pickers (§12, §14). |
| Monthly paid leave | decimal | Input | Visible only with `hrms.employee.admin`. Credited every month (§7.4). |
| Yearly maximum leave | number | Input | Visible only with `hrms.employee.admin`. The yearly cap of **unpaid** leave (§7.3). |
| Legacy permissions (Permissions) | multi-enum | Read-only | Migrated; read by nothing (§2.3). |
| Ux Permission | multi-enum | — | Moves to MahekOne access (§2.3); shown read-only as "Access" with a link to manage. |
| PF/ESIC applicable? | enum | Input | Yes / No (buttons). |
| UAN no. | text | Input | Visible when PF/ESIC = Yes. |
| ESIC no. | text | Input | Visible when PF/ESIC = Yes. |
| Live working age | text | Derived | "{years} Years {months} Months" since joining (see A47 for the source's month arithmetic). |
| ID card image | image | Input | Source table `Employee ID` (one row per employee: Emp ID, Employee Name, ID Card Image). |

**Related records on the employee page** (source `REF_ROWS` virtual columns and
the detail view's order): attendance, staff timings, QR attendance, help
requests, ID card, advances, salaries, leave requests.

**Detail header** (source detail view): Live working age, Aadhaar (masked),
then all fields, then related lists; photo as the main image; sorted by status
in the directory.

### 4.2 Directory (source *Employee Sign Up* card, *Security & Permisstion* deck, *Employee Details_Detail/_Form*)

- List of employees grouped by Status, sorted by name, count per group; photo,
  name, position; the **Inactive** flag (red, bold on ID, name and status).
- Search by name, ID, mobile, position, office.
- Scope: `hrms.employee.manage` (admin, HR).

### 4.3 Actions

| Action | Source | Who / when | Effect |
|---|---|---|---|
| Sign up (add employee) | Add, display "New SignUp", only in *Employee Sign Up* | `hrms.employee.manage` | Employee form, ID first. Creates the MahekOne user link (invitation) as MahekOne's access flow does. |
| Edit | Edit (edit in place) | `hrms.employee.manage`; self for own profile (Q13) | Field-level rules above. |
| Activate (Do Activate) | status Inactive or blank | `hrms.employee.admin` | Status → Active; sign-in enabled. Bulk. |
| Deactivate (Do Deactive) | status Active or blank | `hrms.employee.admin` | Status → Inactive; sign-in disabled; sessions ended. Bulk. |
| Manage access (Ux Permission) | admin, CEO | whoever manages access on MahekOne's Access screen | Opens MahekOne Access for this person. |
| Change password | any | self | MahekOne's change-password / reset flow. |
| Upload employee image | any | self or `hrms.employee.manage` | Prompt: image → Photo. |
| Call / message (4 phone fields), Compose email, View map (2 addresses) | auto actions | anyone who can see the field | Device call / SMS / mail / map. |
| Delete | admin, confirmed | `hrms.employee.admin` | Refused if the employee has attendance, leave, salary or advances; otherwise deleted. (Source deletes freely; see A49.) |
| Monthly assign leave | automation action | system | See §7.4. |

### 4.4 My profile (source *Your Profile*, *Your Profile_Detail/_Form*; slice rows where name = me, updates only)

Shows my record as a card: photo, live working age, Aadhaar (masked), timings,
attendance, QR attendance, help requests, and all fields. Actions: upload
photo, change password, edit the self-editable fields (Q13).

### 4.5 ID cards (source *Employee ID* gallery, admin)

Gallery of ID card images, medium size, one per employee; add / edit / delete
(delete admin only).

---

## 5. Offices & Timings (H11)

### 5.1 Office (source table `Official Settings`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Office name | text | Input, unique | |
| Office range (Set Office Range) | decimal, metres | Input | Must be ≤ 20,000 m. Message "Set Range less Than 20 Km" (source says "2Km"; see A42). Geofence radius for check-in / out. |
| Office location (Office Lat Long) | geo | Input | Picked on a map ("Click on Map Icon"). |
| Office address | address | Input | Geocoded; "View map". |
| Opening time, closing time (Office Opening Time, Office Closing Time) | time | Default now | |
| Timing type | enum | Input | Full Day / Half Day / 24*7. |
| Office duration | duration | Derived | Closing − opening. |
| Official paid leave | text | Input | Free text note. |
| Office image | image | Input | |
| Attendance QR code | text | Input | The text encoded in the office's QR code. |
| QR code image | image | Derived | A 150×150 QR image of the code (the source calls Google Chart's QR service; HRMS renders it itself). Printable. |

Detail order (source): image, location, address, ID, name, range, opening,
closing, duration, timing type, QR code, QR image. Actions: add, edit (admin),
delete, view map (location), view map (address). Screen: *Offices* (card list,
source *Set Office Location*).

### 5.2 Staff timing (source table `Staff Timing`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Employee (EMP ID) | ref → Employee | Input | |
| Employee name (Emp Name) | text | Derived | |
| Weekday (Week Name) | enum | Input | Monday … Sunday. One row per employee per weekday (HRMS enforces uniqueness; A50). |
| In time, out time | time | Default now | |
| Duty duration (Duration) | duration | Derived | Out − in (read-only; the source leaves it to the sheet). |

Screen *Staff timings* (source *Set Staff Timing*): grouped by employee with
count, sorted by name, quick edit. Actions: add, edit, delete (admin); **Add
more time** (copy this row to a new one for another weekday); view employee.
Scope: `hrms.timing.manage`.

**Lookup rule used everywhere:** for an employee and a date, *official in
time*, *official out time* and *target duration* are the in time, out time and
duty duration of that employee's timing row whose weekday is the date's
weekday. No row → the fields are blank and every figure that needs them says
"No timing set for {weekday}".

---

## 6. Attendance (H01) — source tables `Attendance`, `Qr Code Attendance`, `Absent Finder`

### 6.1 Attendance record

| Field | Type | Rule | Logic |
|---|---|---|---|
| Employee (EMP ID) | ref → Employee | Default me | Editable only while the record is new. Pick list: see §6.5 (officer) or me. |
| Employee name | text | Derived | From employee. |
| Date | date | Default today | |
| Office (Office Name) | ref → Office | Default my office | **One attendance per employee per date**: "You Today Already Checked In!" |
| Check in | time | Default now | |
| Check out | time | Input / action | Geofence rule as check-in (§6.2) with "…Then Try to Check Out Again!". |
| Duration | duration | Derived | Check out − check in when both present, else 0. |
| Unplanned stoppage (Unplan Stoppage) | duration | Input | Subtracted from the day's working hours. |
| Official in time | time | Derived | §5.2 lookup. |
| Official out time | time | Derived | §5.2 lookup. |
| Target duration (Office Target Duration) | duration | Derived | §5.2 lookup. |
| Late or early (Late or Ago Duration) | duration (signed) | Derived | (Official in time + **30 minutes**) − check in. Negative = late beyond grace. (Grace is `hrms.attendance.graceMinutes`, default 30.) |
| Report to | text | Stamp | The position of the person who created the row (source `usersettings(position)`); used by the source's *Attendance By Officer* filter. HRMS derives *team* from the employee's Report To instead (A51) and keeps this column for history. |
| Remark | long text | Input / action | Late-check-in rule §6.2; "Remark" action prompts "Write Remark". |
| Weekday (Day Name) | text | Derived | Sunday … Saturday. |
| Month, Year | derived | Derived | From date. |
| Distance | decimal, metres | Derived | Straight-line distance from the office's location to the device position at check-in. |
| Timestamp | date-time | Stamp | Last save time. |
| Position (Lat Long, "Your Current Location") | geo | Stamp | Device position at save. |
| Check-in code | text | Input | Used by QR check-in (§6.8). |
| Check-in photo, Check-out photo (Check in image, Check Out image) | image | Input | Optional in the source. |
| Total working hours today (Total Today Working Hour) | duration | Derived | Sum of the employee's durations that date − sum of their unplanned stoppages that date. |
| Working hour % | percent | Derived | Total working hours ÷ target duration, rounded to a whole %. |
| Time remark | text | Derived | If late (negative): "You Are late. {duration} Time Is The Currency Of Productivity. Punctuality Is The Key To Success. Let's Make Every Minute Count. {name}". Otherwise: "You Are Early. {duration} That's Superb 👌 And We Value Your Dedication ! {name}". |
| Current status (Current Employee Status) | text | Derived | Checked in and not out → "On Working"; otherwise "Present". |
| Working hour difference | duration | Derived | Target duration − this record's duration. |
| Work day (Current Work Day) | text | Derived | Blank until checked out; then Working hour % ≥ **60** → "Full Day", else "Half Day" (`hrms.attendance.fullDayPercent`). |
| Employee photo | image | Derived | Employee's photo. |
| Month ID | derived | Derived | Month key. |

### 6.2 Check-in and check-out rules

1. **Geofence (check-in and check-out).** For ordinary staff the distance must
   be ≤ the office's range. With `hrms.attendance.all` (admin, HR) it must be
   ≤ 9,000 m (`hrms.attendance.privilegedRangeM`). Messages: "You are out of
   office location ! Please Back To Office {name} Then Try to Check in Again!"
   / "… Check Out Again!".
2. **Once a day.** A second check-in for the same employee and date is refused:
   "You Today Already Checked In!".
3. **Late beyond grace.** When check-in is later than official in time + grace
   (30 min), the Remark field appears. For ordinary staff the save is refused
   with "Late Punch-in, Today Unpaid Leave. Contact Admin". With
   `hrms.attendance.all` the check-in saves and the remark is recorded. (Source
   formula is partly truncated in the export; see A03 for the reading.)
4. **Position** is captured from the device; if the browser refuses location
   the check-in cannot be geofenced and is refused with a message saying to
   allow location (the source's `HERE()` has the same dependency).
5. **Photos** are optional.

### 6.3 Actions

| Action | Source | Who / when | Effect |
|---|---|---|---|
| Check in | Add, display "Check In" | signed in | Creates today's record for me (§6.2). |
| Check out | Check Out | record checked in, not out | Check out → now (geofence §6.2). Bulk. |
| Remark | Remark | anyone who sees the row | Prompt "Write Remark" → Remark. |
| Check out by officer | Check Out by Officer | `hrms.attendance.officer` | Prompt "Check Out Time" → check out. |
| Set check-in time | Check-In Time | `hrms.attendance.edit` | Prompt "Check-in" → check in. |
| Edit | Edit | `hrms.attendance.edit` | Edit any field. |
| Delete | Delete (confirm) | `hrms.attendance.edit` | Bulk. |
| Import | Import Qr Code Attendance (on Attendance) | `hrms.attendance.edit` | CSV import into attendance (en-IN), with preview and row errors. |
| Export | (Download on QR / reports; attendance register is exportable) | `hrms.attendance.all` | CSV of rows shown. |
| View employee, View map | auto | anyone who sees the row | |
| Chart data | Chart Data for ALL Attendance Chart | from the chart | Opens the rows behind the chart. |

### 6.4 Screens

| Screen | Source | Contents |
|---|---|---|
| **Check in (home)** | Make Attendance (card), slice *Your Today Attendance* | Today's record for me: check in / check out buttons, current status, official in/out, late/early remark, working hours so far, photos, distance; if none today, the check-in form (Employee, name, then the rest; auto-save, reopen). Grouped by date with count; newest first. |
| **My attendance** | Your Attendance History (deck), slice (read-only) | My records: check in (header), check out, duration (summary), grouped by date, newest first. Detail: all fields, employee photo as image. |
| **My pending check-outs** | Your Pending Check Out (deck) | My records with check-in and no check-out, grouped by date, count. Check out action. |
| **Attendance register** | All Attendance, Today's Attendance, slice ALL Today Attendance, Attendace By Officer | Table: employee, date, check in, check out, duration, remark, working hour %, distance, then the rest; grouped by month, year, employee, date (desc); count; sorted by timestamp desc; quick edit of remark; date filter (default today for the "Today" tab). Scope team / all. Row flags §23. |
| **Mark attendance for staff** | Attendance By Officer_Form, ALL Today Attendance_Form | Form: employee, name, date, check in, check out, unplanned stoppage, office, distance, total working hours, employee photo, check-in photo. Employee list §6.5. |
| **Pending check-outs (all)** | ALL Staff Pending Check Out (deck), slice Staff Pending Check Out | All records checked in and not out: name, check in, date; grouped by date; actions check out, check out by officer, edit, delete, view employee, map. |
| **Absentees** | Absent Finder Dashboard (Absent Finder_Detail with quick-edit date, Absent Result table, ALL Staff Pending Check Out) | A date picker (default today) and the list §6.6 (name, ID, sorted by ID, count), plus the pending check-outs panel. |
| **Attendance chart** | ALL Attendance Chart (histogram) | Attendance count per employee, green, linear trend line, value labels, legend; "Data" opens the register filtered. |
| **Employee of the Month** | card inside Attendance Monitor | Link to H08 (§12.5). |

### 6.5 Who can be marked by an officer

When marking attendance for staff (source Valid_If on EMP ID for view
*Attendance By Officer_Form*), the employee list is:

- active employees of **my office** whose position type is Sales or Other
  (with `hrms.attendance.all`: any active employee of my office),
- **minus** every employee whose Position ends in "Head",
- **minus** employees who already have attendance on that date.

Outside that form, the list is all active employees (admin editing). Error
"invalid Name".

### 6.6 Absentees rule (source slice *Absent Employee List*)

For the chosen date (source table `Absent Finder`, column *Select Date*), list employees with Status = Active who are **not**:
tagged on a holiday of that date; named on a leave request whose start ≤ date ≤
end (any status in the source — see A52); present in attendance on that date.

### 6.7 Default windows

Register and history default to the last 400 days (source security filter
`Date ≥ TODAY()−400`), and the source also hides rows of inactive employees;
HRMS keeps inactive employees' rows reachable with a status filter (A53).

### 6.8 QR-code attendance (off by default: `hrms.attendance.qrEnabled`)

Source table `Qr Code Attendance`, all its screens hidden (`userrole()=hide`).
When switched on, it is a second **check-in method** on the same attendance
record (a `method` field: Geo / QR), not a second attendance list:

- Check-in code must equal an office's Attendance QR code; message "Invalid
  QR code for {office}" (source reuses the out-of-location message; A45).
- Grace is **0** minutes (source: official in − check in, no 30 minutes) and
  full day is **> 70%** for QR rows (A04) — configuration
  `hrms.attendance.qr.graceMinutes`, `hrms.attendance.qr.fullDayPercent`.
- Time remark words for QR rows: "Your are late {duration} This is not good
  {name}" / "You are ago {duration} You are Great {name}" (tidied in A04).
- Check out action also records position. "Edit Help" (admin) sets the
  record's *Edit help* flag to Yes (source column "Edit Help Button").
- Screens (when on): the QR check-in on the home card; QR rows appear in My
  attendance and the register with a "QR" mark; export "Download QR Code
  Attendance" (admin).

---

## 7. Leave & Holidays (H02) — source tables `Staff Request`, `Leave Setup`, `Holiday Setup`

### 7.1 Leave request (source `Staff Request`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Request position (Request Lat Long) | geo | Stamp | Device position when raised. Hidden on the apply form. |
| Requested at (Request Statmp) | date-time | Stamp | Hidden on the form. |
| Date | date | Default today | Hidden on the form. |
| Employee (Employee ID) | ref → Employee | Default me | For `hrms.leave.approve` holders the default is blank. List: §7.2. |
| Employee name | text | Derived | |
| Request type | enum | Input | Leave / Half Day. Validation: available unpaid leave ≥ this request's unpaid leave, else "Insufficient Unpaid Leave". |
| Leave start date | date | Default today | A second request by the same employee with the same start date is refused: "This Date Is already added ! Request Type {type} {status}". |
| Leave end date | date | Default = start | Required for type Leave. Must be in the same month as the start, and ≥ start: "Please Select leave End Date of Same Month! For Next Month apply Separate Leave" (or "Please select valid leave end date" when the duration would be ≤ 0). |
| Leave days (Leave Duration, "Leave Days Duration") | decimal | Derived | (End − start) in days + 1. Shown for Leave and Half Day. |
| Available leave | decimal | Input | Legacy column; not used by any rule (kept read-only). |
| Reason (Request Full Remark, "Write Correct Full Reason") | long text | Input | |
| Status (Request Status) | enum | Default "Requesting" | Requesting / Approved / Rejected. Hidden on the form. |
| Approved by (Aprove By) | text | Stamp | Name of the approver. |
| Approved on (Aprove Date) | date | Stamp | |
| Officer remark | long text | Prompt | "Admin Remark" action. |
| Status changed at (Status Stamp) | date-time | Stamp | |
| Paid leave | number | Prompt | Entered on approval. Must be ≤ available paid leave: "Insufficient Paid Leave". Visible to `hrms.leave.approve`. |
| Unpaid leave | number | Derived | Leave days − paid leave. Visible to `hrms.leave.approve`. |
| Wait / enjoy | text | Derived | Approved → "{name} Enjoy Leave"; otherwise "{name} Wait For Admin Approval". Hidden when Rejected. |
| Calendar end (Leave End Date+1) | date | Derived | End + 1 (for the calendar's exclusive end). |
| Employee photo | image | Derived | |
| Available paid leave (Available Piad Leave) | decimal | Derived | This employee's **Leave Setup assigned leave** for the start date's month and year − sum of paid leave on their **approved** requests in that month and year. |
| Total leave taken | decimal | Derived | Sum of leave days of approved *Leave* requests + (sum of leave days of approved *Half Day* requests) ÷ 2, for requests whose start and end fall in the same year. |
| Month, Year | derived | Derived | From the start date. |
| Available unpaid leave | number | Derived | Employee's yearly maximum leave − sum of unpaid leave on their approved requests in the start date's year. |
| Holidays inside (Holiday Count) | number | Derived | Number of holidays dated between start and end on which this employee is tagged. |
| Dates (Date list) | list of dates | Derived | The distinct attendance dates (any employee) between start and end, in the start's month and year (source rule; used by reports §9 "leave dates"). See A54. |

### 7.2 Who a request can be raised for

- Default: **me**.
- With `hrms.leave.applyOthers` on the Apply form (source view *Apply Leave
  Request*): active employees of my office whose position type is Sales or
  Other.
- With `hrms.leave.approve`: any active employee.

(The source's general form lets anyone pick any active employee; HRMS narrows
it to the three cases above. A55.)

### 7.3 Actions and workflow

| Action | Source | Who / when | Effect |
|---|---|---|---|
| Apply leave | Add (your leave request), Apply Leave Request form | signed in | Form order: date, employee, name, request type, start, end, leave days, reason, employee photo. |
| Approve (Do Approve) | status not Approved, admin | `hrms.leave.approve` | Prompt "Paid Leave" → paid leave (validated vs available paid leave; unpaid = days − paid, validated vs available unpaid leave). Status → Approved; approved on → today; status stamp → now; approved by → my name ("Admin" if unknown). Bulk. |
| Reject (Do Reject) | status not Rejected, admin | `hrms.leave.approve` | Status → Rejected; approved on → today; stamp → now. Bulk. |
| Admin remark | admin | `hrms.leave.approve` | Prompt "Admin Remark" → officer remark. |
| Edit | admin | `hrms.leave.approve` | |
| Delete | admin, confirm "Are You Sure ! You Want Delete This Request" | `hrms.leave.approve` | |
| View employee, View map (request position) | auto | | |

The approver is notified of new requests and the employee is notified of the
decision through MahekOne notifications (the source relies on the requester
looking at *Wait/enjoy*; see §9 of the PRD — notification is the MahekOne
equivalent of the status being visible to them).

### 7.4 Monthly leave credit (source `Leave Setup` + automation "Process for Leave Setup")

Leave setup row: date (default today), employee ID, employee name, assigned
leave (number), month (default from date), year (default from date).

- **Job** (1st of each month, 00:30 IST, idempotent; manual "Run now" for
  `hrms.leave.setup`): for every **active** employee without a row for this
  month, add a row: employee, date = today, month, year, assigned leave =
  employee's *monthly paid leave* (source action "Action for Monthly Assign
  Leave"). The row records that the job created it.
- **Manual**: add / edit (admin), delete (admin). Form order: date, employee
  ID, name, assigned leave, month, year.
- Screen *Leave setup*: table, employee first, then the rest.

### 7.5 Screens

| Screen | Source | Contents |
|---|---|---|
| **My leave** | Your Leave Request (card: employee photo, name, start, end, status, action bar; newest first), slice *Staff Request individual.* (own rows; add only) | My requests newest first: start, end, days, status with flags (§23), wait/enjoy line. Detail order: date, request ID, name, type, start, end, days, reason, approved by, approved on, officer remark, stamp, status, wait/enjoy, requested at. "Apply leave". |
| **Approvals** | Pending (table, slice status blank or Requesting; updates and deletes) | Grouped by employee with count, sorted by start date desc, quick edit; columns: employee photo, date, start, end, days, then available paid, available unpaid, type, paid, unpaid, holidays inside, reason… Actions approve, reject, remark. Detail header: name; order: days, available paid, available unpaid, date, employee, type, start, end, reason, status, approver, date, remark, stamp, wait/enjoy. |
| **All requests** | Employee Leave (card: start, end, status; grouped by start date desc, count) | Every request; filters by status, type, employee, month. |
| **Calendar** | Leave Calendar (admin) | Month view: from start to end+1, label employee name, colour by employee. |
| **Leave setup** | Leave Setup | §7.4. |
| **Holidays** | Holiday Setup | §7.6. |

### 7.6 Holidays (source `Holiday Setup`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Date | date | Input | |
| Day | text | Derived | Weekday name. |
| Category | enum | Input | Festival Holiday / Weekly Holiday / National Holiday / Nature Holiday (open). |
| Tagged employees | multi-ref → Employee | Input | Active employees. A holiday counts for an employee only if they are tagged. |
| Holiday name | enum (ref list) | Input | Open list. |
| Remark | long text | Input | |
| Created by | text | Stamp | |
| Timestamp | date-time | Stamp | Change timestamp. |
| Year | number | Derived | |

Actions: add (admin, HR); **Add more holidays** (copy row, admin / HR); edit
(admin / HR, only when the date is within the last 366 days); delete (admin);
**Download holiday** (CSV, admin); **Upload holiday** (CSV import, admin).
Screen: table with quick edit: date, category, name, tagged employees, the
rest, year.

---

## 8. Overtime (H03) — source table `OT` (off by default: `hrms.ot.enabled`)

Both source screens (*OT*, *Your OT*) are hidden from every user
(`show_if = userrole()=hide`). HRMS builds one screen with scope, shown only
when the setting is on.

| Field | Type | Rule | Logic |
|---|---|---|---|
| Date | date | Default today | One OT record per employee per date: "OT Already Added". |
| Employee (Employee Name) | ref → Employee | Default me | Any employee. |
| OT slot (OT Starting Slote) | enum | Input | Before Duty / After Duty. |
| Start time | time | Default | Before Duty → that day's check-in; After Duty → that day's official out time. |
| End time | time | Default | Before Duty → official in time; After Duty → that day's check-out. |
| OT hours | duration | Derived | End − start. Must exceed 10 minutes: "OT not Applicable" (`hrms.ot.minMinutes`). |
| Remark | long text | Input | |
| Month, Year | derived | Derived | |
| Total OT hours in month (Total OT Hour In Month) | duration | Derived | Sum of the employee's OT hours in the month (source: month only; HRMS: month and year, A06). |

Screen: table date, employee, OT hours, start, end, remark, then the rest;
grouped by employee (count), newest first. Actions: add, edit, delete
(confirmed). Scope mine / all (`hrms.ot.manage`). The help request issue "OT
Not Approved" (§16.1) refers to it.

---

## 9. Monthly Attendance Reports (H04) — source table `Reports`

In the source a person adds a report row per employee per month (the employee
list excludes those already reported that month; date defaults to today − 5 so
a report made on the 3rd belongs to the previous month) and every figure is a
formula. HRMS derives the report for **every employee with attendance in the
month** (A07); the only stored input is the remark.

| Figure | Logic |
|---|---|
| Employee | Anyone with attendance (geo or QR) in the month. |
| Month, Year | The report month. |
| Attendance count | Distinct dates with attendance in the month. |
| Late more than 10 minutes (More than 10 mint Late Count) | Check-ins where check in − 10 minutes > official in time. |
| Late count (Total Late Count in Month) | Check-ins after official in time. |
| On-time count (Total Ago Count in Month) | Check-ins at or before official in time. |
| Office open days (Clinic Open Count, "Office Open Count") | Distinct dates on which **anyone** has attendance in the month. |
| Check-in % (Check in Percentage) | On-time count ÷ attendance count. |
| Overall monthly % (Overall Monthly percentage) | Achieved seconds ÷ target seconds. |
| 10-minute late % (Discount 10 Mint %) | Late > 10 min ÷ attendance count. |
| Target seconds (Total Office Target Seconds) | Sum of target duration over the employee's attendance rows in the month. |
| Achieved seconds (Total Archive Seconds) | Sum of total working hours over the employee's attendance rows in the month. |
| Highest achieved seconds (Highest archive seconds) | Highest achieved seconds among all employees that month. |
| Total late duration (Total Late Duration In Month) | Sum of late-or-early durations that are negative, on Full Day rows. |
| Half days (Total Half Days) | Count of Half Day rows. |
| Missing dates | Office open dates in the month − dates this employee attended − holidays tagged to the employee in the month − the employee's leave dates in the month. |
| Leave dates | The dates on the employee's leave requests in the month (§7.1 "Dates"). |
| Holiday dates (Holiday Date List) | Holidays in the month tagged to the employee. |
| Remark | Input (quick edit). |
| Report generated at (Reportstamp) | Time of calculation. |

Screen (source *Your Monthly Reports* for staff, *Monthly Employee Reports* for
admin): employee, missing dates, leave dates, holiday dates, attendance count,
late count, late > 10 min, total late duration, on-time count, then the rest;
grouped by year (desc), month (desc); count. Scope mine / all
(`hrms.reports.all`). Actions: **Download reports** (CSV, en-IN; admin),
**Go to sheet** (source opens the Google Sheet; HRMS replaces it with the same
CSV export — A57), remark edit, delete of a remark (admin).

---

## 10. Payroll (H05) — source tables `Employee Salary`, `Advance Payment`

### 10.1 The salary record

A salary is prepared in the month **after** the month it pays for: the salary
month is the month before the salary date (source `EOMONTH([Salary Date],-2)+1`).

| Field | Type | Rule | Logic |
|---|---|---|---|
| Salary ID | text | Default | "ES-" + sequential number. Hidden on the form. |
| Salary date | date | Default today | |
| Employee | ref → Employee | Input | Active employees **without** a salary for the salary month: "This Month Salary Paid". |
| Employee name | text | Derived | |
| Month, Year | derived | Derived | The salary month (previous month of salary date). Hidden on the form. |
| Days in month | enum 28/29/30/31 | Default | 31 / 30 by month; February **28** (source; A08). Validation: days in month = full days + half days + leave days + official holidays − holidays inside leave − compensation days; otherwise "Kindly Check Count Leave/Attendance {n} Days Missing" where n = days − (full + half + leave + official holidays − holidays inside leave). A hint shows the equation. |
| Full days (Full Day Count) | number | Derived | Distinct attendance dates in the salary month with work day = Full Day. |
| Half days (Halfday Count) | number | Derived | Distinct dates with work day = Half Day. |
| Paid leave count | number | Derived | Sum of paid leave on the employee's approved *Leave* requests in the salary month. |
| Unpaid leave | number | Derived | Sum of unpaid leave on approved *Leave* requests in the month. |
| Leave count | number | Derived | Sum of leave days on approved *Leave* requests in the month. |
| Holidays inside leave (Holiday Count) | number | Derived | Sum of "holidays inside" on the employee's *Leave* requests in the month. |
| Official holidays (Officialy Holiday) | number | Derived | Holidays in the salary month tagged to the employee. |
| Compensation days (Compentation Days) | number | Input | Extra days to pay as special allowance. |
| Attendance count | decimal | Derived | Full days + half days ÷ 2 + official holidays + paid leave count − holidays inside leave − compensation days. Validation: the employee has **no** attendance in the month with a blank work day (i.e. no pending check-out): "Your Pending Checkout Count is {n}". |
| Fixed salary (Fix Salary) | money | Derived | Employee's salary allocated. |
| Basic salary | money | Derived | Salary allocated ÷ days in month × attendance count. |
| Incentive | money | Input | |
| Conveyance allowance (Convence Allowances) | money | Default | Employee's conveyance ÷ days in month × attendance count. |
| House rent allowance (House Rent Allowances) | money | Hidden | Always hidden in the source (`show_if [_this]=hide`); not part of gross (A11). |
| Special allowance (Special Allowances) | money | Default | Salary allocated ÷ days in month × compensation days. |
| Gross earning | money | Derived | Basic + incentive + conveyance + special allowance. |
| PF/ESIC applicable? | enum | Derived | From the employee. |
| UAN no., ESIC no. | text | Derived | From the employee. |
| Employee PF (P.F. 12%) | money | Derived | If PF/ESIC = Yes: min(basic ÷ 2 × 12%, ₹1,800); else 0. |
| Employee ESIC (ESIC 0.75%) | money | Derived | If PF/ESIC = Yes and gross < ₹21,000: gross × 0.75%; else 0. |
| Professional tax (PT) | money | Derived | Female: gross ≤ ₹25,000 → 0, else ₹200 (₹300 in February). Male: gross ≤ ₹7,500 → 0; ₹7,500–₹10,000 → ₹175; above → ₹200 (₹300 in February). "February" is the salary month. |
| Advance deduction | money | Default | The employee's outstanding advance balance (§10.4). Editable (A13). |
| Late deduction (Deduction Amount) | money | Default | (Salary allocated ÷ days in month ÷ 2) × late half-days. |
| Late half-days (Late Count (Half-Day)) | number | Derived | Count of the month's attendance rows whose time remark is "late": ≥ 25 → 5; ≥ 20 → 4; ≥ 15 → 3; ≥ 10 → 2; ≥ 5 → 1; else 0 (bands are configuration `hrms.payroll.lateBands`). |
| Gross deduction | money | Derived | Advance deduction + late deduction + employee PF + PT + employee ESIC. |
| Salary in hand | money | Derived | Gross earning − gross deduction. |
| Other payment | money | Derived | Employee's other salary ÷ days in month × attendance count. Shown beside salary in hand; not added to it (A10). |
| Employer PF (Employer P.F. 13%) | money | Derived | If PF/ESIC = Yes: min(basic ÷ 2 × 12%, ₹1,800) + basic ÷ 2 × 1%; else 0. |
| Employer ESIC (Employer ESIC 3.25%) | money | Derived | If PF/ESIC = Yes and gross < ₹21,000: gross × 3.25%; else 0. |
| CTC gross (CTC Grosss) | money | Derived | Gross earning + employer PF + employer ESIC. |
| Bank details | long text | Derived | Name, bank, account number, IFSC of the employee. |
| Remark | long text | Input | |
| Payslip (Salary Slip) | file (PDF) | Derived | Generated by the payslip job (§18.2). Hidden on the form. |
| Payslip code (Salary Pdf Code) | text | Stamp | Changes when the payslip is regenerated. |
| Timestamp | date-time | Stamp | Hidden on the form. |
| Payment UTR no. | text | Prompt | Set by "Pay". |
| Payment date | date | Prompt | Set by "Pay". |
| Approved by (Approval By) | text | Stamp | Set by "Approve". |
| Prepared by | text | Stamp | Set by "Pay". |

All rates, caps and slabs (12%, ₹1,800, 0.75%, ₹21,000, 13% = 12% + 1%,
3.25%, PT slabs) are configuration (`hrms.payroll.*`). Once a salary is
approved its figures are frozen; a changed attendance afterwards is shown as a
warning on the salary ("attendance changed since approval") and does not move
the approved numbers.

### 10.2 Workflow and actions

| Action | Source | Who / when | Effect |
|---|---|---|---|
| Add salary | Add | `hrms.payroll.run` | Form in source order: salary date, days in month, employee, name, attendance count, full, half, paid leave, unpaid, leave, holidays inside, official holidays, compensation days, basic, incentive, conveyance, HRA (hidden), special allowance, gross, PT, employee PF, employee ESIC, employer PF, employer ESIC, CTC, other payment, advance deduction, late deduction, gross deduction, in hand, remark, hint, late half-days, PF/ESIC. |
| Approve (Salary Approved) | approved by blank | `hrms.payroll.run` | Approved by → my name. Bulk. |
| Pay (Salary Prepared) | UTR blank and approved | `hrms.payroll.run` | Prompts "Payment UTR No." and "Payment Date"; prepared by → my name. Bulk (one prompt per salary). |
| Regenerate PDF | any | `hrms.payroll.run` | New payslip code; the job regenerates the PDF. |
| Open payslip (Open File) | payslip present and UTR present | the employee; `hrms.payroll.run` | Opens the PDF. |
| Edit | any | `hrms.payroll.run` | Before approval; after approval only remark and payment fields. |
| Delete | admin, office | `hrms.payroll.admin` | Confirmed. |
| Download salary | admin | `hrms.payroll.admin` | CSV (en-IN). |
| View employee | auto | | |

### 10.3 Screens

| Screen | Source | Contents |
|---|---|---|
| **Payroll register** | Payroll (table) | Employee, fixed salary, basic, attendance count, in hand, advance deduction, late deduction, PT, incentive, conveyance, special allowance, remark; grouped by year, month; **sum of salary in hand** per group; newest year first. Flags: approved (orange), prepared (green) — §23. |
| **Salary detail** | Employee Salary_Detail | Header: salary in hand, other payment. Order: employee, salary date, days in month, attendance count, full, half, paid, unpaid, leave, holidays inside, official holidays, compensation, fixed, basic, incentive, conveyance, HRA, special, gross, PF/ESIC, PT, PF, ESIC, employer PF, employer ESIC, CTC, advance deduction, late deduction, gross deduction, other payment, in hand, remark, bank details, UTR, payment date, approved by, prepared by, payslip code, salary ID, late half-days, month, year, payslip, timestamp. |
| **My payslips** | Salary Slip (table; slice: my salaries with UTR present) | Salary date, name, in hand, then the rest; grouped by year, month; open payslip. |

### 10.4 Advances (source `Advance Payment`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Employee | ref → Employee | Input | |
| Employee name | text | Derived | |
| Advance amount | money | Input | |
| Remark | long text | Input | |
| Advance date (Advance payment Date) | date | Default today | |
| Month, Year | derived | Derived | |
| Timestamp | date-time | Stamp | |
| Outstanding balance (Total Advance Balance) | money | Derived | Sum of the employee's advances − sum of advance deductions on their salaries. |

Screen *Advances* (source *Advanced Payment*, admin): advance date, employee,
amount, remark, the rest; grouped by year, month; sum of amount. Action **Give
advance** (source *Given Advanced Form*: date, employee, amount, remark). Edit
and delete: admin. Row scope (source security filter): admin, office, and the
employee's own rows.

---

## 11. Expenses (H06) — source table `Sales Expences`

| Field | Type | Rule | Logic |
|---|---|---|---|
| Serial no. (Sr. No.) | number | Default | Next serial. |
| Date | date | Input | |
| Employee (Name Of Employee) | ref → Employee | Input | Active employees with no date of leaving. |
| Payment type | enum | Input | Expenses Claim / Expenses Paid. |
| Location | enum (ref list) | Input | |
| Category (Categories) | enum | Input | Local Travel, Travel, Hotel Stay, Stationary, Food, Extra (open). |
| Particular | enum (ref list) | Input | |
| Claim amount | money | Input | Shown when type = Claim and paid amount blank. |
| Paid amount | money | Input | Shown when type = Paid and claim amount blank. |
| Reason | long text | Input | |
| Verify | enum | Default | Paid → Verified; Claim → Not Verified. Visible and changeable with `hrms.expense.manage` (source: admin); quick edit on the detail. |
| User | text | Stamp | Creator. |
| Timestamp | date-time | Stamp | |
| Monthly balance | money | Derived | Employee's verified claims − verified payments in the entry's month and year. |
| Month, Year | derived | Derived | |
| Total balance | money | Derived | Employee's verified claims − verified payments, all time. |

Screen *Expenses*: serial, date, location, category, particular, claim, paid,
reason, monthly balance, total balance, verify; grouped by employee, year
(desc), month, verify (desc); newest first; quick edit. Actions: add, edit,
delete, **Download expenses** (CSV; admin, HR). Scope: own entries / all
(`hrms.expense.manage`). MBOS expense claims appear here as claims (PRD Q8).

---

## 12. Performance (H08)

### 12.1 KPI KRA — daily sales entry (source `KPI KRA`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Date | date | Default today | |
| Employee | ref → Employee | Input | Active Sales employees with no date of leaving. Default me for sales staff. |
| Area visited | enum (Areas) | Input | |
| Visits (No of Visit) | number | Input | Pre-filled from MBOS visits that day where they exist (PRD §8; editable). |
| Productive counters | number | Input | |
| Litre sales | number | Input | Pre-fill from MahekOne orders where available (editable). |
| Km travelled | decimal | Input | Pre-fill from MBOS travel legs where available (editable). |
| Punch in, punch out (Punch In Time, Punch Out Time) | time | Derived | That day's attendance check in / check out. |
| Unplanned stop | duration | Input | |
| Amount of sales | money | Input | Pre-fill where available (editable). |
| On-field time | duration | Derived | Punch out − punch in − unplanned stop. |
| Outstanding | money | Input | Pre-fill from the ledger where available (editable). |
| Time remark | text | Derived | That day's attendance time remark (flags §23). |

Each pre-filled value shows where it came from and stays editable; the stored
value is what was saved (A59). Screen *KPI KRA*: employee first, the rest,
newest first. Scope mine (sales) / all (`hrms.sales.all`). Add, edit, delete.

### 12.2 Sales performance — daily score (source `Performance`)

One row per salesman per date ("salesman already scored for this date" —
source excludes salesmen already entered for the date). Entered by
`hrms.performance.manage` (admin, HR).

| Figure | Logic |
|---|---|
| Salesman (Salesman Name), date | Input: active Sales employees with no date of leaving. |
| Daily visit target (Visit Target Daily) | round(monthly visit target ÷ 25). |
| Visits | Sum of KPI visits that date. |
| Visit performance (max 10) | min(visits ÷ daily target × 100 × 10%, 10). |
| Time with customer (Time Given to Customer) | Sum of activity "time given" that date ÷ visits. |
| Time performance (Time Given to Customer Performance, max 5) | min(time ÷ 5 × 100 × 5%, 5). |
| Description length (Description In words) | Characters in that day's meeting notes, excluding spaces and commas, ÷ visits (A19). |
| Description performance (Description In words Performance, max 5) | min(length ÷ 25 × 100 × 5%, 5). |
| Daily working hour target (Working Hour Target Daily) | Monthly working hour target ÷ 25. |
| Working hours | Total hours of that day's KPI on-field time. |
| Working hour performance (max 10) | min(hours ÷ target × 100 × 10%, 10). |
| Daily km target (Km Travel Target Daily) | round(monthly km target ÷ 25). |
| Km travelled | Sum of KPI km that date. |
| Km performance (Km Travel Performance, max 5) | min(km ÷ target × 100 × 5%, 5). |
| Daily sales target (Per days Target Amount) | round(monthly amount of sale target ÷ 25). |
| Sales amount | Sum of KPI amount of sales that date. |
| Sales performance (Sales Amount Performance, 20) | sales ÷ target × 100 × 20% (not capped in source; A18). |
| Daily litre target (Per Days Liter Sales) | round(monthly litre target ÷ 25). |
| Litre sales | Sum of KPI litres that date. |
| Litre performance (Liter Sales Performance, 20) | litres ÷ target × 100 × 20% (not capped; A18). |
| Total sale | Sum of the salesman's KPI amount of sales since the financial-year start × 1.18 (source adds 18% GST; FY start is hard-coded 1 Apr 2023 — A17, A24). |
| Average payment days | (That date's KPI outstanding ÷ total sale) × days since FY start. |
| Outstanding performance (Outstanding Perfomance, 20) | < 15 days → 20; < 30 → 10; < 45 → 5; otherwise 0. |
| Tasks | Verified to-dos assigned to the salesman dated that date. |
| Task performance (5) | No to-dos that date → 5; else verified ÷ total × 100 × 5%. |
| **Per-day performance** (Per Days Performance) | Sum of the nine components. |
| Meeting notes | List of that day's meeting notes. |
| Month ID | Month key. |

Weights, caps, bands and divisors are configuration (`hrms.performance.*`).
Screen *Sales performance*: table (all columns, meeting notes and IDs last),
newest first; **chart** (row series of per-day performance, average, linear
trend, value labels) with "Data". Scope mine / all. Add, edit
(`hrms.performance.manage`), delete (admin).

### 12.3 Staff performance — monthly (source `Staff Performance`)

One row per employee per month, for active employees of office "Mahek
Marketing India" (A25). The month is the month of (date − 28 days), so a row
made early in a month scores the previous month.

| Figure | Logic |
|---|---|
| Working hours performance | Employee's attendance hours in the month ÷ (target duration × working days of the month less holidays …). The source formula is truncated in the export (A22); HRMS uses: sum of durations ÷ sum over the month's working dates (days in month − the employee's tagged holidays) of that weekday's target duration. |
| On-time punctuality (On Time Punchaulity) | Attendance rows with an "early" remark ÷ all attendance rows in the month. |
| Not-done daily tasks | Checklist items in the month neither Done nor Not Applicable. |
| Daily done task performance (label "KPI Performance" for sales) | Sales: (average visit + time + description + km performance for the month) ÷ 25. Others: checklist items Done or N/A ÷ all checklist items in the month. |
| Working speed & not-done to-dos (Working Speed & Not Done ToDo Task) | "Working Speed :- {average days to complete} Days Average And {n} Task Not Done". |
| Done to-do performance (Done ToDo Task Performance) | 1 − (average days taken to complete ÷ average days given). |
| Not-done buddy tasks | Buddy tasks assigned to the employee in the month not Done. |
| Done buddy task performance | Done ÷ all buddy tasks assigned in the month (source divides by not-done; A21). |
| Customer requests (mistake count) | Hidden number, input. |
| **Overall performance** (All Over Performance) | (Working hours + done to-do + daily done task + punctuality) ÷ 4. |
| Employee position | Employee's position type. |

Screen *Staff performance*: scope mine (signed in, not admin) / all (admin),
newest first. Add, edit, delete (admin).

### 12.4 Performance points — any period (source `Performance Point`)

| Field | Logic |
|---|---|
| From date, to date (default today) | Input. |
| Employee | Active, no date of leaving. |
| Employee position | Employee's position type (Sales / OfficeStaff / Other). |
| Attendance count | Attendance rows in the period + holidays tagged to the employee in the period (A23). |
| Attendance point | Attendance count ÷ days in the period. |
| Punctuality count | Rows with an "early" remark + tagged holidays in the period. |
| Punctuality point | Punctuality count ÷ days in the period. |
| Average working hours | Total duration hours ÷ number of rows in the period. |
| Working hour point | Average hours ÷ 8 (`hrms.performance.standardHours`). |
| Task count *(not Other)* | Checklist items + to-dos in the period. |
| N/A reasons *(not Other)* | "Task: {tasks} Not Applicable Reason {reasons}". |
| Task point *(not Other)* | (Checklist Done or N/A + to-dos Done) ÷ (checklist + to-dos). |
| Sales amount *(Sales)* | KPI amount of sales in the period. |
| Sales amount points *(Sales)* | Sales ÷ (monthly target ÷ 30 × days in period). |
| Litre sales, litre points (Liter Sales, Liter sales Points) *(Sales)* | Same with litre target. |
| Outstanding count *(Sales)* | (Outstanding on the latest KPI row up to the to-date ÷ KPI sales since the financial date) × days since the financial date. |
| Financial date | Default 1 Apr 2024 (A17). |
| Outstanding point *(Sales)* | < 15 → 1; < 30 → 0.5; < 45 → 0.25; else 0. |
| Time with customer (Time Given To Customer) *(Sales)* | Activity time given in the period ÷ distinct activity dates. |
| Time point (Time Given To Point) *(Sales)* | > 180 → 1; > 90 → 0.5; else 0. |
| Description length *(Sales)* | Characters of meeting notes in the period (without spaces, commas) ÷ KPI visits. |
| Description point (Description In words Points) *(Sales)* | > 25 → 1; > 15 → 0.5; else 0. |
| **Total** | Sales: average of the nine points. Other: average of attendance, punctuality, working hour. Office staff (and Owner): average of task, attendance, punctuality, working hour (A20). |
| Issues faced last time, Opportunities and new ideas for this time, Next meeting plan, Action for Sir? (Issue You Faced Last Time:-, Opportunity And New Ideas for This Time, Next Meeting Plan:-, Action for Sir.?) | Long text; the **review form** (source action "LION Form" prompts all four). |
| Report PDF (Print PDF; code Perfoma Pdf Code) | Generated by the performance PDF job (§18.3); "Regenerate PDF"; "Download report". |

Screen *Performance points*: employee, from, to, total, the four review
answers, PDF; grouped by employee position then employee (count); newest
first. Form order: ID, from, to, employee, position, then each count and point,
financial date, total. Access: Ux "Performance Point". Add, edit, delete.

### 12.5 Employee of the Month (source slice + card)

Staff performance rows with overall ≥ 90% (`hrms.performance.employeeOfMonthPercent`):
name, overall, punctuality, position, month; grouped by month (count). Shown in
H08 and linked from the attendance screens for admin / HR.

---

## 13. Tasks (H07) — source tables `Task List`, `My Task`, `To Do List`, `Buddy Task`

### 13.1 Task templates (source `Task List`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Serial (Sr. No) | number | Default | Next serial. |
| Employee (Name Of Employee) | ref → Employee | Input | |
| Task | long text | Input | |
| Frequency | enum | Input | Daily / Weekly / Monthly (open). |
| Category | enum | Input | Shown when Monthly: Urgent and Important / Important / To-Do Only. |
| Days | multi-enum | Input | Shown when not Monthly: Sunday … Saturday. |
| Day of month (Date) | enum 1–31 | Input | Shown and required when Monthly. |
| Before date (Till Date) | number | Input | Shown when Monthly; must be greater than the day of month: "Before Should be Greater Than Selected Date !". |
| Start time, end time | time | Input | |
| Task EOD | long text | Derived | §13.5. |

Actions: add (anyone; `hrms.task.manage` for others), **Add more task** (copy
row), edit / delete (admin), **Take my task**, **Take monthly task**, **Send
Task EOD**. Screen *Task templates*: grouped by employee (count), quick edit
(admin); for staff, *My tasks* shows my name (bold, highlighted — §23) and my
Task EOD (source *Your Task*, shown to non-sales staff).

**Take my task** (source REF_ACTION → "Copy Task List"): available when I have
no checklist item dated today. For each of my templates whose Days include
today's weekday, add a checklist item: new ID, me, today, task, frequency,
start, end, days = today's weekday.

**Take monthly task** (source REF_ACTION → "Copy Task List to ToDo Task
monthly"): available when I have no to-do with this month's key. For each of
my Monthly templates, add a to-do: date today; for-date = day-of-month of this
month; till-date = before-date of this month (if set); assign from = "Monthly
Task"; assign to = me; task; category; month key.

### 13.2 Daily checklist (source `My Task`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Task ID | text | Stamp | |
| Date | date | Default today | |
| Employee (Name Of Employee) | ref → Employee | Input | Active employees. |
| Task, frequency, days | text | Copied | |
| Status | enum | Action | Done / Not Done / Not Applicable (staff pick from the same three). |
| Start time, end time | time | Copied | |
| Working time | time | Stamp | When marked Done / N/A. |
| Time difference (Time Deffrence) | duration | Derived | Working time − end time. Shown when end time present. |
| Remark / Not Applicable reason | long text | Input | Required when status = Not Applicable. |
| Taskstamp | date-time | Stamp | |
| Week key (WEEKNUMER ID), Month ID | derived | Derived | |

Actions: **Done** (status blank → Done, working time now, stamp now); **Not
Done** (status Done → blank, clears time and stamp); **N/A** (status blank →
Not Applicable, prompt "Remark / Not Applicable Reason", time, stamp); **Write
remark** (prompt); add, edit; delete (admin).

Screens: *Today's checklist* (source *Your Today Task*: task, status, remark,
start, end, working time, difference…; non-sales staff); *Not done this week*
(source *Weekly Task History (Not Done)*: my items this week with status Not
Done or blank); *All checklists* (source *Daily Task*, admin: narrow columns,
grouped by date desc, employee; count). Flags §23.

### 13.3 To-dos (source `To Do List`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Date | date | Default today | Hidden on the staff assign form. |
| For date | date | Default today | |
| Till date | date | Input | Must be after for date: "Before Date should Be Greater Than For Date!". |
| Assign from | enum | Default me | Employees + "Monthly Task". |
| Assign to | ref → Employee | Input | Any employee. |
| Category | enum | Input | Urgent and Important / Important / To-Do Only. Required on the assign form. |
| Task (Assign Task) | text | Input | |
| Status | enum | Action | Done / Not Done. Marking is refused once the till date has passed: "{task} Task of {till date} Date Expired" (A26). |
| Recheck status | enum | Action | Pending / Verified. |
| Remark | long text | Input | |
| Month ID | derived | Stamp | |
| Timestamp | date-time | Stamp | When done. |
| Days taken (Task Done Days) | number | Derived | Done timestamp − for date, in days. |
| Average days | decimal | Derived | Average days taken for this assignee in the same done-month. |
| Done month, for-date month (Task Done Month ID, For Date Month ID) | derived | Derived | |
| Days given (Task Given Days) | number | Derived | Till date − for date; without a till date, end of for-date's month − for date. |

Actions: **Assign to-do** (form: for date, assign from, assign to, category,
task, till date, remark, date; source staff form hides status fields); **Done**
(assigner or assignee, status blank; confirmation "Are You Sure! Your Task Is
Done"; stamps time); **Not Done** (assigner or assignee, status Done → blank);
**Write remark**; **Verified** (status Done, not yet verified; assigner or
admin); **Pending** (verified → Pending; assigner only); edit; delete (admin or
the assigner).

Screens: *Open to-dos* (source *Today ToDo Task*: not verified, till date
blank or ≥ today, where I am assigner or assignee; the source also requires
for date ≥ today, which hides overdue to-dos — HRMS keeps them, marked
overdue, see A35; grouped by assigner, sorted by for date); *To verify*
(source *Task Verification*: Done and recheck blank; for date desc); *History*
(source *ToDo Task History*: where I am assigner or assignee); *All to-dos*
(source *Assign ToDo Task*, admin). Flags §23.

### 13.4 Buddy tasks (source `Buddy Task`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Date | date | Default today | |
| Day | text | Derived | Weekday. |
| Employee (sender) | ref → Employee | Default me | Active employees. |
| Buddy (Buddy Assign) | ref → Employee | Input | Active employees. |
| Buddy status | text | Default "Pending" | → "Task Accepted". |
| Task | long text | Input | Suggested: the sender's templates for today's weekday, minus tasks already shared today. |
| Status | enum | Action | Done. |
| Timestamp, Month ID | | Stamp / derived | |

Actions: **Share task** (add; signed in); **Accept** (buddy, not yet accepted →
Task Accepted); **Task done** (buddy, accepted, not done → Done); edit; delete
(admin or sender). Screens: *Buddy tasks* (date, buddy status, day, sender,
buddy, task…; grouped by date desc) with tabs *Shared with me today* (source
slice: today, accepted, I am sender or buddy) and *All mine*. Row scope
(source security filter): sender, buddy, admin.

### 13.5 Task EOD (source virtual column + "Send Task EOD")

A message built for an employee for today:

```
* 📝 Task EOD - {name}*
📅 *Date:* {today}
--------------------------------
📊 *Summary:*
🔹 *Total Tasks:* {checklist items today}
✅ *Total Completed:* {Done}
⏳ *Total Pending:* {blank status}
🚫 *Total Not Applicable:* {Not Applicable}
--------------------------------
🚫 *Not Applicable Tasks Details:*
*Task:* 1. … (up to 5)
*Reason:* 1. … (up to 5)
--------------------------------
⚠ *Overdue / Pending Todo List:*
1. … (up to 5 to-dos assigned to me, status blank, for date ≤ today, in this month)
```

"Send Task EOD" opens WhatsApp with this text to the configured number
(`hrms.tasks.eodWhatsappNumber`, source 919822824973 — A28).

---

## 14. Sales Desk (H09) — source tables `Customer Details`, `Calling Data`, `Activity`, `Journey Planner`

All four work on MahekOne's shared records (PRD §8). The fields below are what
the HRMS screens show and edit; fields the shared record lacks are added to it.

### 14.1 Customer (source `Customer Details`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Customer name | text | Input | The source's key; in HRMS a field of the MahekOne customer (A33). |
| Address | address | Input | "View map". |
| Mobile number, alternate number | phone | Input | Call, message. |
| Rating | enum | Input | High Value / Medium Value / Low Value. |
| Segmentation | enum (ref list) | Input | |
| Area (Location) | long text | Input | The area the calling list groups by. |
| State | enum (ref list) | Input | |
| Sales person | ref → Employee | Input | Active Sales employees with no date of leaving. |
| Tagged employee (Tag Employee) | ref → Employee | Input | Same list. |
| Special instructions | text | Input | |
| Back-office employee | ref → Employee | Input | Any employee. Owns the customer's calling (§14.2). |
| Status | enum | Default Active | Active / Deactive. Visible to `hrms.customer.decide` only. |
| Deactivation request | text | Action | blank / "Deactivation Request Received" / "Deactivation Accepted" / "Deactivation Rejected". |
| Deactivation remark | text | Prompt | Required for non-admins when requesting. |
| Activities, calls | lists | Derived | The customer's sales activities and calling rows. |

Actions:

| Action | Who / when | Effect |
|---|---|---|
| Add, edit | `hrms.sales.all` | |
| Delete | `hrms.customer.delete` (admin, HR) | Confirmed. |
| **Deactivation request** | not admin; no pending request | Request → "Deactivation Request Received"; prompt "Write Deactivation Reason" → remark. |
| **Deactivation unsend** | not admin; a request exists | Request → blank. |
| **Deactivation accepted** | admin; request received | Request → "Deactivation Accepted"; status → Deactive. |
| **Deactivation reject** | admin; request received | Request → "Deactivation Rejected". |
| **Do active this customer** | admin; status not Active | Status → Active. |
| **Take follow-up** | customer not already in a calling row dated today | §14.2. |
| Call / message (2 numbers), view map | anyone who sees the row | |

Screens: *Customers* (source *Customer Details*: name, address, mobile,
alternate, activities, calls, the rest; quick edit) with status tabs *Active*
(source *Active Customers* / *Active Customers For Calling*), *Pending
deactivation* (source *Pending Deactivation Request*, admin), *Deactive* (source
*Deactive Customers*, admin). Detail order: name, address, mobile, alternate,
activities, calls.

### 14.2 Calling (source `Calling Data`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Customer | ref → Customer | Input | Customers not Deactive (source compares with "Inactive", which never matches; A30). |
| Grade | text | Derived | The customer's latest activity mood (A31). |
| Mobile no. | phone | Copied | Call, message. |
| Area (Location) | text | Copied / derived | The customer's area (A31). |
| Special instruction (Special Instraction) | text | Copied | |
| Sales person | text | Copied | |
| Calling date | date | Default today | |
| Calling status | enum | Input | Call Not Pick Up / Order Received / No Requirement / Reminder Call Back. |
| 2nd calling status | enum | Input | Shown when calling status = Call Not Pick Up. Same values. |
| Discussion note (Discution Note) | long text | Input | |
| Follow-up date | date | Input | |
| Timestamp | date-time | Stamp | |
| User | text | Default me | The caller. |
| Total customer orders | number | Derived | Calling rows of this customer with status Order Received (source typo "recieved" makes it always 0; A29). |
| Suggestion (A.I Suggetion) | text | Derived | If (calling rows of this customer − 7 × total orders) ≤ 7 → "Do FollowUp", else "Do Deactivate This Customer" (A32). |

**Take follow-up** (source REF_ACTION on a customer → "Copy Customer area
Wise"): for every **Active** customer whose area equals this customer's area
and whose back-office employee is **me**, add a calling row: customer, mobile,
area, special instructions, sales person, timestamp, user = me. Each calling
row is also written to the customer's timeline as a planned call; the call
outcome lands on the timeline when the calling form is saved (PRD Q6).

**Calling form** (source action): prompts calling status, 2nd status,
discussion note, follow-up date.

Screens (one *Calling* screen with tabs):

| Tab | Source | Rows |
|---|---|---|
| To call | slice *Calling Followup* / view *Calling Followups* | Mine, calling status blank; grouped by calling date (desc), count. |
| Follow-ups due | *Followup Dates* | Mine, follow-up date ≤ today, 2nd status blank. |
| History | *Calling History* | Mine, calling date in the last 10 days: date, status, customer, grade, area, note, follow-up, instruction, sales person, 2nd status, timestamp, user; sorted by date desc, customer. |
| All | *Calling Data* (CEO) | Everything, sorted by customer (`hrms.sales.all`). |

Inline on a customer (source *Calling Data_Inline*): calling date, instruction,
status, 2nd status, note, follow-up, total orders, customer, suggestion.
Actions: add, edit, calling form, call, message, view customer; delete
(`hrms.customer.decide`). Flags §23.

### 14.3 Sales activity (source `Activity`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Salesperson (Employee Name.) | ref → Employee | Input | Active Sales, no date of leaving. |
| Customer | ref → Customer | Input | |
| Date | date | Default today | |
| Time given (minutes) | number | Input | |
| Meeting note | text | Input | |
| Issue | enum (ref list) | Input | |
| Reminder date (Remainder Date) | date | Input | |
| Mood | enum | Input | Happy / Normal (open). |
| Meeting type, meeting purpose | enum (ref lists) | Input | |
| Area (Location) | text | Derived | The customer's area. |

Screen *Sales activity* (source *Sales Activity*): date, customer, note, time
given, mood, issue, reminder, area, type, purpose; grouped by area then
customer with **sum of time given**; newest first. Inline on a customer
(quick edit, grouped by customer). Default window 500 days (source security
filter). Actions: add, edit, view customer; delete (`hrms.customer.delete`).
The records are the shared field-activity records (MBOS visits and the EMP 2.0
history already on the customer timeline).

### 14.4 Journey planner (source `Journey Planner`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Employee (Name Of Employee) | ref → Employee | Input | Active Sales with no date of leaving; with `hrms.journey.anyone`, any employee. |
| Start date | date | Default today | |
| End date | date | Default = start | |
| Location | enum (ref list) | Input | |
| Plan (Plan Journey) | long text | Input | |
| Customers | multi-ref → Customer | Input | |
| Remark | long text | Input | |
| Attachment (Attech file) | file | Input | "Open file". |
| User | text | Stamp | Creator. |
| Timestamp | date-time | Stamp | |
| Calendar end | date | Derived | End + 1. |

Screen *Journey planner*: month calendar from start to end+1, labelled by
location, coloured by employee; detail and form. Add, edit, delete, open file.
Access `hrms.sales.all`. Stored as the shared journey / tour record (PRD Q5).

---

## 15. Assets (H12) — source tables `Inword Asset`, `Asset Managment`

### 15.1 Asset stock-in (source `Inword Asset`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Asset code (Asset Id) | text | Default | Sequential code; hidden on the form. |
| Purchase date | date | Default today | |
| Asset name | enum (ref list) | Input | "Visiting Card" (open). |
| Category | enum | Default Stationery | Stationery / Tangible Assets / Other. |
| Purchase cost | money | Input | |
| Quantity | number | Input | |
| Description | long text | Input | |
| Location | ref → Office | Input | |
| Warranty information | long text | Input | Tangible Assets only. |
| Invoice image, asset image | image | Input | Tangible Assets only. |
| Timestamp | date-time | Stamp | |
| Assignments | list | Derived | This asset's assignments. |
| Available stock (Available Stocks) | number | Derived | By asset **name**: all stock-in quantity + restored quantity − assigned quantity (A36). |
| Stock of this lot (Asset Stocks) | number | Derived | Same, for this asset code only. |

Screen *Asset stock* (source *My Assets*): grouped by category (count),
purchase date desc. Add, edit, delete.

### 15.2 Assignment (source `Asset Managment`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Asset | ref → Asset stock-in | Input | |
| Assigned date | date | Input | Shown after creation. |
| Asset name | text | Derived | |
| Quantity (Assign Quantity) | number | Input | Not checked against available stock in the source; HRMS keeps it that way and warns (A60). |
| Assigned from | ref → Employee | Default me | Suggested: active employees. |
| Assigned to | ref → Employee | Input | Active employees. |
| Responsibility & suggestion (Resposibility & Suggestion) | long text | Input | |
| Assign-time image 1 | image | Default = the asset's image | |
| Assign-time image 2 | image | Input | Shown when image 1 present. |
| Status | enum | Default Assigned | Assigned / Restored. |
| Restored date, restored by, restored quantity, restored remark, restore-time image (Restored Time Image) | | Prompt | Required together once a restored date is set. |
| Timestamp, entry user | | Stamp | |
| In use (Using Assets) | number | Derived | By asset name: assigned − restored. |

Action **Restored asset** (status Assigned): prompts restored date (default
today), restored by (default me), restored quantity (default the assigned
quantity), remark, image; status → Restored. Screen *Assignments* (source
*Asset Managemnet*): assigned to, asset, quantity, restored quantity, status,
in use, the rest; grouped by assigned to (count); assigned date desc. Add
("Assign Asset"), edit, view asset; delete (admin).

---

## 16. Help & Grievance (H13)

### 16.1 Help requests (source `Help`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Employee (Emp id) | ref → Employee | Default me | Fixed after creation. |
| Employee name | text | Derived | |
| Help type | enum | Input | Other Help (App Issue → MahekOne feedback, see below). |
| Issue type | enum | Input | Other Help: I Forgot Make Attendance / I Late Check In / I Forget Check Out / I Am Late Today / OT Not Approved / I Want to Lean App / Other. |
| Issue text (Write issue, "Write Help or issue") | long text | Input | |
| In time | time | Default now | Shown for I Forgot Make Attendance, I Late Check In, I Am Late Today. |
| Out time | time | Default now | Shown for I Forgot Make Attendance, I Forget Check Out. |
| Admin remark | long text | Input | `hrms.help.resolve`; required when issue = I Am Late Today. |
| Status | text | Default "Request" | → "Approved". Hidden on the form. |
| Date | date | Default today | |
| Timestamp | date-time | Stamp | |
| Admin stamp | date-time | Derived | Set when status leaves "Request". |

**App Issue** (source help type with issues Location Error / Login Issue /
Password Issue / Other Technical Issue and a required screenshot, *Upload Screenshot*): the Help
form offers it, and choosing it hands the person to MahekOne's "Tell us"
feedback with the issue and screenshot carried over, so an app fault has one
channel across all apps (A40).

Actions: **Take help** (add), edit, delete (confirmed), **Approved** (status
Request → Approved; `hrms.help.resolve`), view employee. Screen *Help
requests*: staff see theirs (source *Help Us*: name, admin remark, issue);
`hrms.help.resolve` sees all (source *EMP-Help*: screenshot, name, issue,
timestamp; grouped by status desc). The request links to the attendance day
it is about, so the resolver can correct it there (§6.3).

### 16.2 Grievances (source `Grievance`)

| Field | Type | Rule | Logic |
|---|---|---|---|
| Grievance no. | number | Default | Sequential; hidden on the staff form. |
| Date | date | Default today | |
| From (Issue From) | text | Derived | Me. |
| To (Issue To) | multi-enum | Input | Ceo / HR / Company; employee names suggested. |
| Issue (Write Your Issue) | long text | Input | |
| Status | enum | Default Pending | Pending / Solve. |
| Solution | long text | Prompt | |
| Feedback | enum | Prompt | ✮ to ✮✮✮✮✮. |
| Feedback at | date-time | Stamp | |
| Timestamp | date-time | Stamp | |

Actions: add; edit (admin, or the raiser while Pending); delete (confirmed);
**Give solution** (admin: status → Solve, prompt solution); **Give feedback**
(the raiser, not admin, status Solve: prompt stars, stamp). Screen
*Grievances*: date, from, to, issue, status, solution, feedback, stamps;
grouped by status then to (count); newest first; quick edit for admin. Detail
header: to, issue. Scope mine / all (`hrms.grievance.resolve`).

---

## 17. Documents, Notifications, Help videos, Search

### 17.1 Documents (H14) — source `Mehak Documentation`

| Field | Type | Rule | Logic |
|---|---|---|---|
| Title (Document Tilte) | text | Input | |
| Type | enum | Input | PDF File & Audio / Image / Video / Link. Shows the matching input. |
| PDF or audio file | file | Input | "Open PDF & Audio". |
| Image | image | Input | |
| Video | file | Input | "Open video". |
| Link | url | Input | "Open link". |
| Description | long text | Input | |
| Date | date | Default today | |
| Tagged employees | multi-ref → Employee | Input | |

Screen *Documents*: cards (title, image, video). Managers
(`hrms.documents.manage`) see all, add, edit; delete (admin, HR). Everyone else
sees documents tagged to them (source *Documents (For Staff)*, *Staff
Documents*). Stored in MahekOne's one document library.

### 17.2 Notifications (H15) — source `Notification`

| Field | Type | Rule | Logic |
|---|---|---|---|
| Timestamp | date-time | Stamp | |
| Notification ("Write Notification") | text | Input | |
| For | ref → Employee (open list) | Input | |
| By (Notification By) | ref → Employee | Default me | Active employees. |
| Landing page | text | Input | Which screen the notification opens. |
| Icon | image | Derived | Fixed bell icon. |
| Seen status | text | Stamp | Set when the recipient opens it. |
| Sender email, receiver email | email | Derived | "Compose email" to either. |

Saving a notification delivers it to the recipient's MahekOne bell (§18.4).
Screen *Notifications*: deck newest first (by, text, time); actions delete,
edit, email sender, email receiver. Form order: by, for, text.

### 17.3 Help videos — source `Helpful Video`

Fields: video ID, title, video from, video file, YouTube URL, search tags,
description, thumbnail (Thambnail), timestamp, user ID. Actions: add, edit, delete, open
file, open YouTube. The source has **no list screen** for it (only detail and
form; A41). HRMS uses MahekOne's shared help-video library (one library for
all apps) and links to it from the HRMS menu.

### 17.4 Search — source *Assistant* view

MahekOne's global search, extended to employees, attendance, leave requests,
tasks, grievances and documents within the searcher's scope.

---

## 18. Automations

The source lists 0 workflow rules and 4 automation process tables. Each becomes
an idempotent server job with a manual "Run now".

### 18.1 Monthly leave credit — "Process for Leave Setup" (+ output "Monthly Assign Leave Output")

§7.4. Schedule: 1st of every month, 00:30 IST. Input: active employees.
Output: one Leave Setup row per employee per month, never two.

### 18.2 Payslip PDF — "Process for Salary Slip - 1"

Trigger: a salary is created or its payslip code changes. Output: a PDF
payslip (company name, employee, month, days in month, attendance breakdown,
every earning, every deduction, employer contributions, CTC, in hand, other
payment, bank details, UTR and payment date when paid). Stored as the salary's
payslip; the employee can open it once paid (§10.2).

### 18.3 Performance report PDF — "Process for performance point pdf generator - 1"

Trigger: a performance-point record is created or its PDF code changes.
Output: a PDF of every count, point, total and the four review answers.

### 18.4 Notification delivery — "Process for Common Notification - 1"

Trigger: a notification is created. Output: the recipient's MahekOne bell
notification (title "{by}", body the text, link = landing page); "seen" is
recorded when opened.

### 18.5 Other system events carried over

- Leave request raised → bell to `hrms.leave.approve` holders; decided → bell
  to the employee (§7.3).
- Help request / grievance raised → bell to resolvers; answered → bell to the
  raiser.
- To-do assigned → bell to the assignee (the source's "Send notification"
  actions on the undefined One Time Task / Repeated Task tables do this for
  tasks; applied here to the task table that exists — Q9, A43).

---

## 19. Source anomalies and HRMS decisions (for client sign-off)

Where the source contradicts itself or its evident intent, HRMS implements the
intent. Where it is merely unusual, HRMS keeps it and says so.

| # | Where | What the source does | HRMS |
|---|---|---|---|
| A01 | Format rules "late time remark" (Attendance) and "late time remark kPI" (KPI KRA) | Colour the remark red when it does **not** start "you are Late" — i.e. red when early. | Red when late, green when early (the QR rule has it the right way round). |
| A02 | Attendance late / early | The remark measures against official in time **+ 30 min**, while monthly report late counts measure against official in time with no grace. | Kept as in source: the remark and the report answer different questions. Both are labelled ("late beyond grace", "late"). |
| A03 | Attendance Remark rule | Remark appears when check-in is after official in + 30 min (the Show_If is truncated in the export) and is valid only for admin / HR or at > 2,500 characters, with the message "Late Punch-in, Today Unpaid Leave. Contact Admin" — which blocks ordinary staff. | Read as: late beyond grace is refused for staff and recorded with a remark by admin / HR. Confirm. |
| A04 | QR attendance | No 30-minute grace; full day at > 70% (geo: ≥ 60%); remark words "Your are late … This is not good", "You are ago … You are Great". | Kept as separate QR settings; words tidied to "You are late …" / "You are early …". |
| A05 | Format rule "Some hour" (Staff Request) | Styles request type "Some hours", which is not a request type. | Not carried (dead rule). Listed in §23. |
| A06 | OT monthly total; report target and achieved seconds | Filter by month name only, so January 2025 and January 2026 add together. | Month **and** year. |
| A07 | Reports | A person adds one report row per employee per month; formulas fill it. | Derived for every employee with attendance; only the remark is stored. Same figures, nobody has to add rows. |
| A08 | Salary days in month | February is always 28. | Kept as the default (it is what the source pays on) with the list 28–31 editable per salary as in the source; confirm whether leap years should give 29. |
| A09 | Salary days check | The message's day count leaves out compensation days while the rule includes them. | Message uses the same equation as the rule. |
| A10 | Other payment | Computed pro-rata but not included in gross or in hand; shown beside in hand. | Kept exactly. |
| A11 | House rent allowance | Column exists, always hidden, not in gross. | Kept hidden and excluded; confirm whether it can be dropped. |
| A12 | Salary actions | "Salary Approved" stamps the approver; "Salary Prepared" asks for UTR and payment date and stamps "Prepared By" — preparing is really paying. | Actions labelled **Approve** and **Pay**; the stored stamps keep the source names. |
| A13 | Advance deduction default | Defaults to the whole outstanding advance. | Kept; editable before approval. |
| A14 | Late half-days | Counts attendance rows whose remark text starts "You are Late". | Counts rows flagged late (same rows; no dependence on the wording). |
| A15 | Salary month | Always the month before the salary date. | Kept. |
| A16 | Expense verify | Only admin sees and sets Verify, though HR and office open the screen. | Kept (`hrms.expense.manage` sees; verifying needs admin). |
| A17 | Financial year | Daily performance uses 1 Apr 2023; performance points default 1 Apr 2024. Both hard-coded. | Setting `hrms.performance.financialYearStart`, seeded with the source values; confirm whether it should roll every April. |
| A18 | Daily performance | Sales amount and litre components are not capped at 20, so a day can exceed 100. | Kept uncapped; confirm. |
| A19 | "Description In words" | Counts characters (excluding spaces and commas), not words. | Kept as characters; labelled "note length". |
| A20 | Performance point total | Uses "Office Staff" and "Owner", but position types are Sales / OfficeStaff / Other, so office staff get no total. | OfficeStaff (and Owner if added) use the four-point average. |
| A21 | Done buddy task performance | Done ÷ not-done. | Done ÷ all. |
| A22 | Working hours performance | Formula truncated in the export. | §12.3 reading; confirm. |
| A23 | Attendance point | Counts attendance rows (not dates) plus tagged holidays; can exceed 100%. | Kept; confirm. |
| A24 | Total sale | Adds 18% GST to KPI sales amount. | Kept. |
| A25 | Staff performance | Only employees of office "Mahek Marketing india". | Kept as a setting (`hrms.performance.staffOffices`). |
| A26 | To-do Done | Refused once the till date has passed. | Kept. |
| A27 | Buddy task form | Hides Task in a view name that does not exist, so Task is always shown. | Task shown. |
| A28 | Task EOD | WhatsApp number hard-coded 919822824973. | Setting. |
| A29 | Total customer orders | Compares with "order recieved" (typo), so it is always 0 — and the suggestion then always says follow up or deactivate on call count alone. | Compares with "Order Received". Changes the suggestion for customers with orders; confirm. |
| A30 | Calling customer list | Excludes status "Inactive", which customers never have (Active / Deactive). | Excludes Deactive. |
| A31 | Calling Grade and Location | The lookups are typed into the error-message slot, not a formula, so they never fill. | Derived from the customer (latest mood; area). |
| A32 | "A.I Suggetion" | A fixed rule, not AI. | Kept as a rule, labelled "Suggestion". |
| A33 | Customer key | The customer name is the key. | MahekOne customer id; the name is a field. |
| A34 | Take follow-up | Checks only that **this** customer was not called today, then copies the whole area. | Skips every customer of the area already in a calling row today (no duplicates). |
| A35 | Security filters on checklist and to-dos | `Date ≥ TODAY()−90+90` = today, which hides every past item, including overdue to-dos the EOD message lists. | History kept; open to-dos include overdue ones, marked overdue. |
| A36 | Asset availability | "Available stocks" totals by asset name; "Asset stocks" by code. | Both kept, labelled. |
| A37 | Restore prompt | The remark prompt is labelled "Assign To". | Labelled "Restored remark". |
| A38 | Staff timing duration | Read-only with no formula (the sheet computes it). | Derived: out − in. |
| A39 | Half-day leave in salary | Salary leave counts sum only request type *Leave*, so approved Half Day requests do not reach payroll; *Total leave taken* halves them. | Kept; confirm whether a half-day leave should count 0.5 in payroll. |
| A40 | Help "App Issue" | A second app-issue channel inside the HR app. | Routed to MahekOne "Tell us". |
| A41 | Helpful Video | No list screen, so unreachable. | Shared help-video library, linked from the menu. |
| A42 | Office range | Limit 20,000 m; message says "less Than 2Km". | Message "less than 20 km". |
| A43 | Notification actions | Three actions write notifications from tables "One Time Task" and "Repeated Task" that the document does not define. | Not built; the pattern is applied to to-do assignment. Q9. |
| A44 | Empty dashboards | "Customer Request (admin)" and "Complaint Status (Staff)" have no views; the deactivation and calling screens are otherwise unreachable. | Assumed to have held them (Q10). |
| A45 | QR check-in | A wrong code shows the out-of-location message; distance is measured to the first office in the list. | Own message; distance to my office. |
| A46 | QR check-out | Required at creation for non-admins. | Required only at check-out. |
| A47 | Live working age | Year difference and month difference computed separately (can read "2 Years -3 Months"). | Correct years and months. |
| A48 | New employee status | Starts blank (Activate / Deactivate both apply to blank). | Starts Active on sign-up. |
| A49 | Deleting an employee | Allowed for admin whatever depends on it. | Refused when attendance, leave, salary or advances exist; deactivate instead. |
| A50 | Staff timing | Several rows for one weekday are allowed; lookups take any one. | One per employee per weekday. |
| A51 | Attendance By Officer | Filters by the position of whoever **created** the row. | Team = employees whose Report To is my position; the stored column is kept. |
| A52 | Absentees | Excludes anyone with a leave request covering the date, whatever its status (even rejected). | Kept; confirm whether only approved leave should excuse. |
| A53 | Attendance of inactive employees | Hidden entirely (security filter). | Kept by default; reachable with a status filter (payroll history needs it). |
| A54 | Leave "Date list" | Built from dates on which anyone attended, not calendar dates. | Kept (it feeds missing dates, which uses the same attended-dates base). |
| A55 | Leave for others | The general form lets anyone file for any active employee. | Self; on-behalf needs `hrms.leave.applyOthers` or approver. |
| A56 | Salary pending check-out check | Counts attendance with a blank work day, including an open check-in today. | Kept (salary month is always a past month). |
| A57 | Go To Sheet | Opens the backing Google Sheet. | CSV export of the same data. |
| A58 | Passwords | Stored in plaintext in the sheet and shown to admins. | Never migrated; MahekOne sign-in. |
| A59 | KPI inputs | Typed by hand though MahekOne holds several of them. | Pre-filled, labelled with their source, editable. |
| A60 | Asset assignment quantity | Not checked against available stock. | Allowed, with a warning. |

---

## 20. Source views → HRMS screens (all 200)

"Record / form / inline" means the record page, the create-or-edit form and
the embedded list of that record type inside its parent.

| Source view(s) | Type | HRMS |
|---|---|---|
| Make Attendance | card, bottom bar | H01 Check in (home) |
| Your Attendance History, Your Attendance History_Detail | deck, menu | H01 My attendance |
| Your Pending Check Out, Your Pending Check Out_Detail | deck | H01 My pending check-outs |
| Attendance Monitor | dashboard, menu (admin, HR) | H01 group: register, pending check-outs, chart, Employee of the Month link, check in, my attendance — each item once |
| Today's Attendance | table (admin) | H01 Attendance register, "Today" tab |
| All Attendance | table (admin, HR) | H01 Attendance register |
| Attendace By Officer | table, menu (admin, heads) | H01 Attendance register, scope *team* |
| Attendance By Officer_Detail, Attendance By Officer_Form | detail, form | H01 attendance record; *Mark attendance for staff* form |
| ALL Today Attendance_Detail, ALL Today Attendance_Form | detail, form | H01 attendance record; *Mark attendance for staff* form |
| Today Attendance_Detail, Today Attendance_Form | detail (quick-edit remark), form | H01 attendance record (remark quick edit) |
| Attendance_Detail, Attendance_Form, Attendance_Inline | detail, form, table | H01 attendance record, check-in form, inline list on the employee |
| ALL Staff Pending Check Out | deck (Ux) | H01 Pending check-outs (all) |
| ALL Attendance Chart | chart (admin) | H01 Attendance chart |
| Absent Finder Dashboard, Absent Finder_Detail, Absent Finder_Form, Absent Result | dashboard, detail, form, table | H01 Absentees |
| Make Attendance QR Code | card (hidden) | H01 QR check-in (setting) |
| Your Attendance History Qr Code, Your Attendance History QR Code_Detail | deck, detail (hidden) | H01 My attendance, QR rows |
| All QR Code Attendance | table (hidden) | H01 register, QR rows |
| Your Today Attendance QR code_Detail, Your Today Attendance QR code_Form | detail, form | H01 QR check-in |
| Qr Code Attendance_Detail, Qr Code Attendance_Form, Qr Code Attendance_Inline | detail, form, table | H01 attendance record (QR method), inline on employee |
| Your Leave Request | card, bottom bar | H02 My leave |
| Apply Leave Request | form, menu (Ux) | H02 Apply leave (on behalf) |
| Staff Request individual._Detail, Staff Request individual._Form | detail, form | H02 My leave record; Apply leave |
| Staff Request_Detail, Staff Request_Form, Staff Request_Inline | detail, form, deck | H02 leave record; Apply leave; inline on employee |
| Leave Monitor | dashboard, bottom bar (Ux) | H02 group: Approvals, All requests, Calendar, Leave setup, Holidays — each once |
| Pending, Pending_Detail, Pending_Form | table, detail, form | H02 Approvals |
| Employee Leave | card (Ux) | H02 All requests |
| Leave Calendar | calendar (admin) | H02 Calendar |
| Leave Setup, Leave Setup_Detail, Leave Setup_Form | table, detail, form | H02 Leave setup |
| Holiday Setup, Holiday Setup_Detail, Holiday Setup_Form | table, detail, form | H02 Holidays |
| OT, Your OT, OT_Detail, Your OT_Detail, OT_Form | tables (hidden), details, form | H03 Overtime (setting) |
| Your Monthly Reports, Your Monthly Reports_Detail, Monthly Employee Reports, Reports_Detail, Reports_Form | tables, details, form | H04 Monthly reports |
| Salary | dashboard, menu | H05 group: Payroll register, My payslips, Advances; plus links to H06 Expenses and H04 reports — each once |
| Payroll | table | H05 Payroll register |
| Employee Salary_Detail, Employee Salary_Form, Employee Salary_Inline | detail, form, table | H05 salary record, salary form, inline on employee |
| Salary Slip, Salary Slip_Detail | table, detail | H05 My payslips |
| Advanced Payment | table (admin) | H05 Advances |
| Given Advanced Form | form, menu (named clerk) | H05 Give advance |
| Advance Payment_Detail, Advance Payment_Form, Advance Payment_Inline | detail, form, table | H05 advance record, form, inline on employee |
| Expenses, Sales Expences_Detail, Sales Expences_Form | table, detail (quick-edit Verify), form | H06 Expenses |
| Task Management(Admin) | dashboard (admin) | H07 group: Task templates, All to-dos, All checklists, To verify |
| Task Managment(Staff) | dashboard (staff) | H07 group: My tasks, Today's checklist, Open to-dos, Not done this week |
| Task List, Task List_Detail, Task List_Form | table, detail, form | H07 Task templates |
| Your Task, Your Task_Detail | detail | H07 My tasks (with Task EOD) |
| Daily Task | table | H07 All checklists |
| Your Today Task | table | H07 Today's checklist |
| Weekly Task History ( Not Done ) | table | H07 Not done this week |
| My Task_Detail, My Task_Form | detail, form | H07 checklist item |
| Assign ToDo Task | table (admin) | H07 All to-dos |
| Today ToDo Task, Today ToDo Task_Detail, Today ToDo Task_Form | table, detail, form | H07 Open to-dos |
| ToDo Task History( Staff ), ToDo Task History_Detail | table, detail | H07 To-do history |
| Task Verification | table | H07 To verify |
| Assign Today ToDo Task(staff), To Do List_Detail, To Do List_Form | form, detail, form | H07 Assign to-do (one form); to-do record |
| Buddy Task, Share Buddy Task | tables | H07 Buddy tasks |
| Buddy Task Staff_Detail, Buddy Task Staff_Form, Budy Task_Detail, Budy Task_Form | details, forms (duplicates) | H07 buddy task record; Share task (one form) |
| KPI KRA, KPI KRA Sales | tables | H08 KPI KRA (scope) |
| KPI KRA_Detail, KPI KRA_Form, KPI KRA Sales_Detail | details, form | H08 KPI record, form |
| Performance | table (admin, HR) | H08 Sales performance (all) |
| Sales Performance_Detail, Sales Performance_Form, Performance_Detail, Performance_Form | details, forms | H08 sales performance record, form |
| Performance Chart(Admin) | chart (admin) | H08 Sales performance chart (all) |
| Staff Performance Chart | chart (staff) | H08 Sales performance chart (mine) |
| Staff Performance, Staff Performance. | tables (staff; admin) | H08 Staff performance (scope) |
| Staff Performance_Detail, Staff Performance_Form | detail, form | H08 staff performance record, form |
| Employee of The Month | card | H08 Employee of the Month |
| Performance Point, Performance Point_Detail, Performance Point_Form | table (Ux), detail, form | H08 Performance points |
| Customer Details, Customer Details_Detail, Customer Details_Form | table, detail, form | H09 Customers |
| Active Customers For Calling | table | H09 Customers, *Active* tab |
| Deactive Customers | table (admin) | H09 Customers, *Deactive* tab |
| Pending Deactivation Request | table (admin) | H09 Customers, *Pending deactivation* tab |
| Customer Request (admin) | dashboard, empty | H09 Customers deactivation tabs (A44) |
| Complaint Status (Staff) | dashboard, empty | H09 Calling (A44) |
| Calling Data, Calling Data_Detail, Calling Data_Form, Calling Data_Inline | table (CEO), detail, form, table | H09 Calling *All*; calling record; form; inline on customer |
| Calling Followups | table | H09 Calling *To call* |
| Followup Dates | table | H09 Calling *Follow-ups due* |
| Calling History | table | H09 Calling *History* |
| Sales Activity, Activity_Detail, Activity_Form, Activity_Inline | table, detail, form, table | H09 Sales activity; inline on customer |
| Journey Planner, Journey Planner_Detail, Journey Planner_Form | calendar, detail, form | H09 Journey planner |
| Employee Sign Up | card (admin, HR) | H10 Employee directory + Sign up |
| Security & Permisstion | deck (admin, CEO) | H10 directory status actions; access → MahekOne Access screen |
| Employee Details_Detail, Employee Details_Form | detail, form | H10 employee record, form |
| Your Profile, Your Profile_Detail, Your Profile_Form | card, detail, form | H10 My profile |
| Employee ID, Employee ID_Detail, Employee ID_Form, Employee ID_Inline | gallery, detail, form, deck | H10 ID cards; inline on employee |
| Admin Pannel | dashboard (Ux) | Menu group: H11 Offices, H11 Staff timings, H10 Sign up, H14 Documents, H13 Help (all), H13 Grievances (all), H08 chart (all) — each once |
| HR Pannel | dashboard (admin, HR, sales) | Menu group: H09 Journey planner, H12 Asset stock, H12 Assignments, H02 Holidays, H06 Expenses, H02 My leave — each once |
| Staff Pannel | dashboard | Menu group: H10 My profile, H13 Help, H13 Grievances, H04 My monthly reports, H07 To-do history, H07 Buddy tasks, H08 chart (mine), H14 Documents — each once |
| Set Office Location, Official Settings_Detail, Official Settings_Form | card, detail, form | H11 Offices |
| Set Staff Timing, Staff Timing_Detail, Staff Timing_Form, Staff Timing_Inline | table, detail, form, table | H11 Staff timings; inline on employee |
| My Assets, Inword Asset_Detail, Inword Asset_Form | table, detail, form | H12 Asset stock |
| Asset Managemnet, Asset Managment_Detail, Asset Managment_Form, Asset Managment_Inline | table, detail, form, deck | H12 Assignments; inline on the asset |
| Help Us, EMP- Help | decks (staff; admin) | H13 Help requests (scope) |
| staff help_Detail, staff help_Form, Help_Detail, Help_Form, Help_Inline | details, forms, deck | H13 help record, form, inline on employee |
| Grievance, Grievance (Staff) | tables (admin; staff) | H13 Grievances (scope) |
| Grievance_Detail, Grievance_Form, Grievance Staff_Detail, Grievance Staff_Form | details, forms | H13 grievance record, form |
| Documents, Documents (For Staff), Staff Documents_Detail, Mehak Documentation_Detail, Mehak Documentation_Form | cards, details, form | H14 Documents |
| Notification, Notification_Detail, Notification_Form | deck, bottom bar; detail; form | H15 Notifications |
| Helpful Video_Detail, Helpful Video_Form | detail, form | Shared help-video library (A41) |
| Assistant | search | MahekOne global search |
| Settings | form (login) | MahekOne sign-in |

---

## 21. Source slices → HRMS (all 34)

| Slice | Source filter | HRMS |
|---|---|---|
| Your Today Attendance | mine, today | H01 Check in |
| Your Attendance History | mine | H01 My attendance |
| Staff Request individual. | mine (add only) | H02 My leave |
| ALL Today Attendance | today | H01 register "Today" |
| Your Pending Check Out | mine, in and no out | H01 My pending check-outs |
| Staff Pending Check Out | in and no out | H01 Pending check-outs (all) |
| staff help | mine | H13 Help (mine) |
| Your Today Attendance QR code | mine, today | H01 QR check-in |
| Your Attendance History QR Code | mine | H01 My attendance (QR rows) |
| Your Monthly Reports | mine | H04 (mine) |
| Your Profile | mine (updates only) | H10 My profile |
| Your OT | mine | H03 (mine) |
| Pending | status blank or Requesting | H02 Approvals |
| Attendance By Officer | date ≤ today + 30 and Report To = my position | H01 register (team) — A51 |
| Your Task | my templates | H07 My tasks |
| Weekly Task History Not Done | mine, this week, not done or blank | H07 Not done this week |
| Your Today Task | mine, today | H07 Today's checklist |
| Today ToDo Task | for date ≥ today, till date blank or ≥ today, not verified, I am from/to | H07 Open to-dos (A35) |
| ToDo Task History | I am from/to | H07 To-do history |
| KPI KRA Sales | mine | H08 KPI KRA (mine) |
| Sales Performance | mine | H08 Sales performance (mine) |
| Staff Documents | tagged to me | H14 Documents (mine) |
| Salary Slip | mine and UTR present | H05 My payslips |
| Grievance Staff | mine | H13 Grievances (mine) |
| Buddy Task Staff | I am sender or buddy, today, accepted | H07 Buddy tasks "Shared with me today" |
| Employee of The Month | overall ≥ 90 | H08 Employee of the Month |
| Calling Followup | mine, status blank | H09 Calling "To call" |
| Active Customers | status Active | H09 Customers "Active" |
| Followup Dates | follow-up ≤ today, 2nd status blank, mine | H09 Calling "Follow-ups due" |
| Calling History | mine, last 10 days | H09 Calling "History" |
| Pending Deactivation Request | request received, Active | H09 Customers "Pending deactivation" |
| Deactive Customers | status Deactive | H09 Customers "Deactive" |
| Task Verification | recheck blank, status Done | H07 To verify |
| Absent Employee List | §6.6 | H01 Absentees |

---

## 22. Source actions → HRMS actions (all 212)

### 22.1 Record actions per table

Every table has the source's system actions; HRMS keeps each with the source's
condition.

| Table | Add | Edit | Delete | Other system actions |
|---|---|---|---|---|
| Employee Details | admin / HR, in sign-up ("New SignUp") | anyone with the screen | admin (confirmed, advanced) | View map ×2, Call ×4, SMS ×4, Compose email |
| Attendance | signed in ("Check In") | admin | admin | View employee, View map |
| Staff Request | signed in | admin | admin ("Are You Sure ! You Want Delete This Request") | View employee, View map |
| Official Settings | any | admin | any (confirmed) | View map ×2 |
| Help | any ("Take Help") | any | any (confirmed) | View employee |
| Staff Timing | admin | admin | admin | View employee, Add more time |
| Qr Code Attendance | any | any | any | View employee, View map |
| Reports | any | any | any | — |
| OT | any | any | any | — |
| Employee ID | any | any | admin | View employee |
| Advance Payment | any (the form is gated) | admin | admin | View employee |
| Employee Salary | any (the screen is gated) | any | admin, office | View employee, Open payslip |
| Task List | any | admin | admin | Add more task |
| My Task | any | any | admin | — |
| To Do List | any ("Assign ToDo Task") | any | admin or the assigner | — |
| Customer Details | any | any | admin, HR | View map, Call ×2, SMS ×2 |
| KPI KRA | any | any | any | — |
| Activity | any | any | admin, HR | View customer |
| Performance | admin, HR | admin, HR | admin | — |
| Mehak Documentation | any | any | admin, HR | Open PDF & Audio, Open URL, Open video |
| Holiday Setup | admin, HR | admin, HR (last 366 days) | admin | Add more holidays |
| Leave Setup | any | admin | admin | — |
| Grievance | any | admin, or raiser while Pending | any | — |
| Buddy Task | signed in ("Share Task") | any | admin or sender | — |
| Staff Performance | any | any | any | — |
| Asset Managment | signed in ("Assign Asset") | any | admin | View asset |
| Inword Asset | any | any | any | — |
| Journey Planner | any | any | any | Open file |
| Sales Expences | any | any | any | — |
| Calling Data | any | any | admin | Call, SMS, View customer |
| Performance Point | any | any | any | Open PDF ("Download Report") |
| Helpful Video | any | any | any | Open file, Open YouTube |
| Absent Finder | any | any | any | — |
| Notification | any | any | any | Email sender, email receiver |

In the source, "any" means anyone who can open the screen; HRMS reads it the
same way (the screen's own access, §2.4).

### 22.2 Business actions

| Source action | Table | HRMS (section) |
|---|---|---|
| Do Activate | Employee Details | Activate (§4.3) |
| Do Deactive | Employee Details | Deactivate (§4.3) |
| Change Password | Employee Details | MahekOne password change (§4.3) |
| Upload Employee Image | Employee Details | Upload photo (§4.3) |
| Ux Permission | Employee Details | Manage access → MahekOne Access (§4.3) |
| Action for Monthly Assign Leave | Employee Details | Monthly leave credit job (§7.4, §18.1) |
| Check Out | Attendance | Check out (§6.3) |
| Check Out by Officer | Attendance | Check out by officer (§6.3) |
| Check-In Time | Attendance | Set check-in time (§6.3) |
| Remark | Attendance | Remark (§6.3) |
| Import Qr Code Attendance | Attendance | Import attendance (§6.3) |
| Chart Data for ALL Attendance Chart | Attendance | Chart "Data" (§6.4) |
| Check Out QR Code Attendance | Qr Code Attendance | Check out, QR (§6.8) |
| Remark 2 | Qr Code Attendance | Remark (§6.3) |
| Edit Help QR code | Qr Code Attendance | "Edit help" flag (§6.8) |
| Download QR Code Attendance | Qr Code Attendance | Export QR rows (§6.8) |
| Do Approve | Staff Request | Approve (§7.3) |
| Do Reject | Staff Request | Reject (§7.3) |
| Admin Remark | Staff Request | Admin remark (§7.3) |
| Add More Time | Staff Timing | Add more time (§5.2) |
| Download Reports | Reports | Download reports (§9) |
| Go To Sheet | Reports | CSV export (§9, A57) |
| Approved | Help | Approve (§16.1) |
| Salary Approved | Employee Salary | Approve (§10.2) |
| Salary Prepared | Employee Salary | Pay (§10.2) |
| Regenerate pdf | Employee Salary | Regenerate payslip (§10.2) |
| Download Salary | Employee Salary | Download salary (§10.2) |
| ADD More Task | Task List | Add more task (§13.1) |
| Copy Task List | Task List | Part of Take my task (§13.1) |
| Take My Task | Task List | Take my task (§13.1) |
| Copy Task List to ToDo Task monthly | Task List | Part of Take monthly task (§13.1) |
| Take Monthly Task | Task List | Take monthly task (§13.1) |
| Send Task EOD | Task List | Send Task EOD (§13.5) |
| Done | My Task | Done (§13.2) |
| Not Done | My Task | Not done (§13.2) |
| N/A | My Task | N/A (§13.2) |
| Note | My Task | Write remark (§13.2) |
| Done 2 | To Do List | Done (§13.3) |
| Not Done 2 | To Do List | Not done (§13.3) |
| Note 2 | To Do List | Write remark (§13.3) |
| Verified | To Do List | Verified (§13.3) |
| Pending | To Do List | Pending (§13.3) |
| Task Accepted | Buddy Task | Accept (§13.4) |
| Task Done | Buddy Task | Task done (§13.4) |
| Chart Data for Performance Chart(Admin) | Performance | Chart "Data" (§12.2) |
| Chart Data for Staff Performance Chart | Performance | Chart "Data" (§12.2) |
| LION Form | Performance Point | Review form (§12.4) |
| Regenerate pdf. | Performance Point | Regenerate report PDF (§12.4) |
| Give Solution | Grievance | Give solution (§16.2) |
| Give Feedback | Grievance | Give feedback (§16.2) |
| Download Holiday | Holiday Setup | Download (§7.6) |
| Upload Holiday | Holiday Setup | Upload (§7.6) |
| Add More Holiday's | Holiday Setup | Add more holidays (§7.6) |
| Restored Asset | Asset Managment | Restored asset (§15.2) |
| Copy Cutomer area Wise | Customer Details | Part of Take follow-up (§14.2) |
| Take Followup | Customer Details | Take follow-up (§14.2) |
| Deactivation Request | Customer Details | §14.1 |
| Deactivation Unsend | Customer Details | §14.1 |
| Deactivation Accepted | Customer Details | §14.1 |
| Deactivation Reject | Customer Details | §14.1 |
| Do Active This Customer | Customer Details | §14.1 |
| Calling Form | Calling Data | Calling form (§14.2) |
| Download Expences | Sales Expences | Download expenses (§11) |
| Send Data In Notification Action - 1 | One Time Task *(undefined)* | Q9, A43 |
| Send data in notification tab Action - 1 | One Time Task *(undefined)* | Q9, A43 |
| Send Notifiation Action - 1 | Repeated Task *(undefined)* | Q9, A43 |

---

## 23. Source format rules → HRMS flags (all 43)

Each rule is a named visual state. The design decides how each looks; the
condition and the colour the source used are given so the meaning is kept.

| # | Rule | Record | Condition | Source styling / meaning |
|---|---|---|---|---|
| 1 | Inactive Employee | Employee | status Inactive | red, bold on ID, name, status |
| 2 | late time remark | Attendance | late (A01) | red, heart-broken icon, small |
| 3 | Early time remark | Attendance | early | green, laugh icon, small |
| 4 | check in color | Attendance | always | check-in time green, sign-in icon (also the name) |
| 5 | check out color | Attendance | always | check-out time red, sign-out icon |
| 6 | duration | Attendance | always | duration blue, large |
| 7 | date | Attendance | always | date large, purple highlight, calendar icon |
| 8 | Check out button | Attendance | always | the Check out action prominent, purple |
| 9 | Approved | Leave request | Approved | green tick on name and status |
| 10 | Rejected | Leave request | Rejected | red on date, name, dates, status |
| 11 | solve color | Help | status approved | green double tick on name, status, date |
| 12 | late time remark qr code | QR attendance | late | red |
| 13 | ago time remark qr code | QR attendance | early | green |
| 14 | Check out button qr code | QR attendance | always | Check out action prominent, purple |
| 15 | check in color qr code | QR attendance | always | check-in green |
| 16 | check out color qr | QR attendance | always | check-out red |
| 17 | duration qr code | QR attendance | always | duration blue, large |
| 18 | date qr code | QR attendance | always | date large, purple, calendar icon |
| 19 | Current Employee Status Working | Attendance | On Working | green dot |
| 20 | Current Employee Status Present | Attendance | Present | blue check |
| 21 | late color | Attendance | late-or-early negative | red alarm-clock on name and duration |
| 22 | Wait / enjoy | Leave request | Approved | green grin on the wait/enjoy line |
| 23 | wait........... | Leave request | Requesting | yellow history icon on status and wait line |
| 24 | Leave | Leave request | type Leave | orange sun on name and type |
| 25 | half day | Leave request | type Half Day | blue eclipse on name and type |
| 26 | Some hour | Leave request | type "Some hours" | pink clock — dead rule, not carried (A05) |
| 27 | password | Employee | always | Change password action purple, key icon |
| 28 | Done | Checklist item | Done | green |
| 29 | Done 2 | To-do | Done | green |
| 30 | Bold name in your task | Task template | on My tasks | the name large, pink, user icon |
| 31 | Assign from | To-do | I am not the assigner (someone gave it to me) | red highlight, arrow-right icon |
| 32 | Assign to | To-do | I am not the assignee (I gave it) | purple highlight, arrow-left icon |
| 33 | weekly not done | Checklist item | status blank | red row |
| 34 | Urgent and Important | To-do | not Done and category Urgent and Important | red, info icon |
| 35 | 5 star | Grievance | feedback ✮✮✮✮✮ | green |
| 36 | admin aproval | Salary | approved | orange on the first columns |
| 37 | prepared by | Salary | paid (prepared) | green on the first columns |
| 38 | asset stocks | Asset stock-in | always | stock green dot |
| 39 | late time remark kPI | KPI KRA | late (A01) | red |
| 40 | Early time remark Kpi | KPI KRA | early | green |
| 41 | Assignto | Asset assignment | always | assigned-to purple |
| 42 | Total Orders | Calling | always | total orders green, cart icon |
| 43 | Do 2d call | Calling | 2nd status blank | orange on customer, mobile, area, instruction, 2nd status |

---

## 24. Configuration keys

| Key | Default (source) | Used by |
|---|---|---|
| `hrms.attendance.graceMinutes` | 30 | §6.1 late / early |
| `hrms.attendance.fullDayPercent` | 60 | §6.1 work day |
| `hrms.attendance.privilegedRangeM` | 9000 | §6.2 |
| `hrms.attendance.defaultWindowDays` | 400 | §6.7 |
| `hrms.attendance.qrEnabled` | false | §6.8 |
| `hrms.attendance.qr.graceMinutes` | 0 | §6.8 |
| `hrms.attendance.qr.fullDayPercent` | 70 (strictly greater) | §6.8 |
| `hrms.office.maxRangeM` | 20000 | §5.1 |
| `hrms.ot.enabled` | false | §8 |
| `hrms.ot.minMinutes` | 10 | §8 |
| `hrms.reports.lateOverMinutes` | 10 | §9 |
| `hrms.payroll.pfRate` / `pfCapPaise` / `pfBaseFraction` | 12% / ₹1,800 / ½ of basic | §10.1 |
| `hrms.payroll.employerPfExtraRate` | 1% | §10.1 |
| `hrms.payroll.esicEmployeeRate` / `esicEmployerRate` / `esicCeilingPaise` | 0.75% / 3.25% / ₹21,000 | §10.1 |
| `hrms.payroll.ptSlabs` | Female: ≤ 25,000 → 0 else 200 (Feb 300); Male: ≤ 7,500 → 0, ≤ 10,000 → 175, else 200 (Feb 300) | §10.1 |
| `hrms.payroll.lateBands` | 25→5, 20→4, 15→3, 10→2, 5→1 | §10.1 |
| `hrms.payroll.februaryDays` | 28 | §10.1 (A08) |
| `hrms.leave.creditDay` | 1st of month | §7.4 |
| `hrms.performance.dailyDivisor` | 25 | §12.2 |
| `hrms.performance.periodDivisor` | 30 | §12.4 |
| `hrms.performance.weights` | visits 10, time 5, description 5, hours 10, km 5, sales 20, litres 20, outstanding 20, tasks 5 | §12.2 |
| `hrms.performance.timeGivenBase` / `descriptionBase` | 5 min / 25 characters | §12.2 |
| `hrms.performance.outstandingBands` | < 15 / < 30 / < 45 days | §12.2, §12.4 |
| `hrms.performance.pointBands` | time > 180 / > 90; description > 25 / > 15 | §12.4 |
| `hrms.performance.standardHours` | 8 | §12.4 |
| `hrms.performance.financialYearStart` | 1 Apr 2023 (daily), 1 Apr 2024 (points) | §12 (A17) |
| `hrms.performance.gstRate` | 18% | §12.2 (A24) |
| `hrms.performance.staffOffices` | Mahek Marketing India | §12.3 (A25) |
| `hrms.performance.employeeOfMonthPercent` | 90 | §12.5 |
| `hrms.tasks.eodWhatsappNumber` | 919822824973 | §13.5 |
| `hrms.calling.historyDays` | 10 | §14.2 |
| `hrms.calling.suggestionFactor` / `suggestionThreshold` | 7 / 7 | §14.2 |
| `hrms.sales.activityWindowDays` | 500 | §14.3 |
| `hrms.holidays.editWindowDays` | 366 | §7.6 |

---

## 25. Source tables → HRMS (all 40)

| Source table | HRMS |
|---|---|
| _Per User Settings | MahekOne sign-in (§2.1) |
| Employee Details | Employee (§4) |
| Attendance | Attendance (§6) |
| Staff Request | Leave request (§7.1) |
| Official Settings | Office (§5.1) |
| Help | Help request (§16.1) |
| Staff Timing | Staff timing (§5.2) |
| Qr Code Attendance | Attendance, method QR (§6.8) |
| Reports | Monthly report, derived (§9) |
| OT | Overtime (§8) |
| Employee ID | Employee ID card (§4.5) |
| Advance Payment | Advance (§10.4) |
| Employee Salary | Salary (§10) |
| Task List | Task template (§13.1) |
| My Task | Checklist item (§13.2) |
| To Do List | To-do (§13.3) |
| Customer Details | MahekOne customer (§14.1) |
| KPI KRA | KPI entry (§12.1) |
| Activity | Field activity (§14.3) |
| Performance | Daily sales performance (§12.2) |
| Mehak Documentation | Document (§17.1) |
| Holiday Setup | Holiday (§7.6) |
| Leave Setup | Leave credit (§7.4) |
| Grievance | Grievance (§16.2) |
| Buddy Task | Buddy task (§13.4) |
| Staff Performance | Monthly staff performance (§12.3) |
| Asset Managment | Asset assignment (§15.2) |
| Inword Asset | Asset stock-in (§15.1) |
| Journey Planner | Journey / tour (§14.4) |
| Sales Expences | Expense entry (§11) |
| Calling Data | Calling row (§14.2) |
| Performance Point | Performance point (§12.4) |
| Helpful Video | Shared help-video library (§17.3) |
| Absent Finder | Absentees date picker — no table (§6.6) |
| Notification | Notification (§17.2) |
| Process for Salary Slip - 1 Process Table | Payslip job (§18.2) |
| Process for Leave Setup Process Table | Monthly leave job (§18.1) |
| Monthly Assign Leave Output | Monthly leave job output (§18.1) |
| Process for performance point pdf generator - 1, Process for performance point pdf generator - 1 Process Table | Performance PDF job (§18.3) |
| Process for Common Notification - 1 Process Table | Notification delivery job (§18.4) |
