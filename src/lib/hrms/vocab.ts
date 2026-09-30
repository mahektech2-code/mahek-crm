import type { Tone } from "@/lib/erp/ui";

/* ---------------------------------------------------------------------------
 * The HRMS's named row states and status tones — the source's 43 format
 * rules (spec §23), as the design names them. PURE and client-safe: the kit
 * hands them to the generic list, drawer and badges.
 * ------------------------------------------------------------------------- */

export const HRMS_FLAGS: Record<string, [string, Tone]> = {
  inactive: ["Inactive", "muted"],
  late: ["Late check-in", "danger"],
  early: ["Early", "success"],
  working: ["On working", "brand"],
  noOut: ["No check-out", "warn"],
  halfDay: ["Half day", "warn"],
  waitApproval: ["Waiting for approval", "warn"],
  enjoy: ["Leave approved", "success"],
  rejected: ["Rejected", "danger"],
  approved: ["Approved", "success"],
  paid: ["Paid", "success"],
  salApproved: ["Salary approved", "info"],
  blank: ["Still blank this week", "warn"],
  done: ["Done", "success"],
  toMe: ["Given to me", "brand"],
  byMe: ["Given by me", "neutral"],
  urgent: ["Urgent & important", "danger"],
  overdue: ["Overdue", "danger"],
  fiveStar: ["★★★★★ feedback", "success"],
  inStock: ["In stock", "success"],
  lowStock: ["Low stock", "warn"],
  assigned: ["Assigned", "info"],
  secondCall: ["Second call to make", "warn"],
  helpOk: ["Help approved", "success"],
  deactReq: ["Deactivation requested", "warn"],
  preFilled: ["Pre-filled", "brand"],
  naReason: ["Not applicable", "muted"],
  leaveDay: ["On leave", "info"],
  holiday: ["Holiday", "neutral"],
  missing: ["Missing dates", "danger"],
  blocked: ["Blocked", "danger"],
  qr: ["QR check-in", "neutral"],
  marked: ["Marked by head", "neutral"],
  mine: ["Yours", "brand"],
  changed: ["Attendance changed since approval", "warn"],
  noPin: ["No map pin", "warn"],
};

export const HRMS_TONES: Record<string, Tone> = {
  Active: "success", Inactive: "muted", Present: "success", "On Working": "brand", "Full Day": "success", "Half Day": "warn",
  Late: "danger", Early: "success", "On time": "success", Approved: "success", Rejected: "danger", Requesting: "warn",
  Leave: "info", Festival: "brand", Weekly: "neutral", National: "info", Nature: "warn", "Before Duty": "neutral",
  "After Duty": "neutral", Prepared: "neutral", Paid: "success", "Expense Claim": "info", "Expense Paid": "neutral",
  Verified: "success", Pending: "warn", Done: "success", "Not done": "warn", "Not Done": "warn", "N/A": "muted",
  Open: "neutral", "To verify": "info", Overdue: "danger", Daily: "neutral", Monthly: "info", Shared: "warn",
  Accepted: "info", "Task done": "success", High: "success", Medium: "neutral", Low: "warn",
  "High Value": "success", "Medium Value": "neutral", "Low Value": "warn",
  "Pending deactivation": "warn", Deactive: "muted", "Call Not Pick Up": "warn", "Order Received": "success",
  "No Requirement": "neutral", "Reminder Call Back": "info", "To call": "brand", "Follow-ups due": "warn",
  History: "neutral", Solve: "success", Assigned: "info", Restored: "success", Stationery: "neutral",
  "Tangible Assets": "info", Other: "neutral", Yes: "brand", No: "neutral", "24*7": "info", Absent: "danger",
  Good: "success", Happy: "success", Normal: "neutral", Neutral: "neutral", Upset: "warn",
  "Not done this week": "warn", Today: "brand", Earlier: "neutral", "Shared with me today": "brand",
  Field: "brand", Sales: "brand", Office: "neutral", OfficeStaff: "neutral", Management: "info",
  Link: "info", Image: "neutral", Video: "brand", "PDF & audio": "neutral", Seen: "success", Unseen: "warn",
  "Not checked in": "muted", "No check-out": "warn", Geo: "neutral", QR: "info", Officer: "neutral", Import: "neutral",
};
