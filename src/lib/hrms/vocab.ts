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
  working: ["Working", "brand"],
  noOut: ["No check-out", "warn"],
  halfDay: ["Half day", "warn"],
  waitApproval: ["Awaiting approval", "warn"],
  enjoy: ["Leave approved", "success"],
  rejected: ["Rejected", "danger"],
  approved: ["Approved", "success"],
  paid: ["Paid", "success"],
  salApproved: ["Salary approved", "info"],
  blank: ["Not filled in this week", "warn"],
  done: ["Done", "success"],
  toMe: ["Given to me", "brand"],
  byMe: ["Given by me", "neutral"],
  urgent: ["Urgent and important", "danger"],
  overdue: ["Overdue", "danger"],
  fiveStar: ["Five-star feedback", "success"],
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
  marked: ["Marked by the department head", "neutral"],
  mine: ["Yours", "brand"],
  changed: ["Attendance changed since approval", "warn"],
  noPin: ["No map pin", "warn"],
};

export const HRMS_TONES: Record<string, Tone> = {
  Active: "success", Deactivated: "muted", "Did not pick up": "warn", "Order received": "success", "No requirement": "neutral", "Asked to call back": "info", Inactive: "muted", Present: "success", Working: "brand", "Full Day": "success", "Half Day": "warn",
  Late: "danger", Early: "success", "On time": "success", Approved: "success", Rejected: "danger", Waiting: "warn",
  Leave: "info", Festival: "brand", Weekly: "neutral", National: "info", Nature: "warn", "Before Duty": "neutral",
  "After Duty": "neutral", Prepared: "neutral", Paid: "success", Claim: "info", Payment: "neutral",
  Verified: "success", Pending: "warn", Done: "success", "Not done": "warn", "Not Done": "warn",
  Open: "neutral", "To verify": "info", Overdue: "danger", Daily: "neutral", Monthly: "info", Shared: "warn",
  Accepted: "info", "Not applicable": "muted", High: "success", Medium: "neutral", Low: "warn",
  "High Value": "success", "Medium Value": "neutral", "Low Value": "warn",
  "Pending deactivation": "warn", Deactive: "muted", "Call Not Pick Up": "warn", "Order Received": "success",
  "No Requirement": "neutral", "Reminder Call Back": "info", "To call": "brand", "Follow-ups due": "warn",
  History: "neutral", Solve: "success", Assigned: "info", Restored: "success", Stationery: "neutral",
  Equipment: "info", Other: "neutral", Yes: "brand", No: "neutral", "24 hours": "info", Absent: "danger",
  Good: "success", Happy: "success", Normal: "neutral", Neutral: "neutral", Upset: "warn",
  "Not done this week": "warn", Today: "brand", Earlier: "neutral", "Shared with me today": "brand",
  Field: "brand", Sales: "brand", Office: "neutral", OfficeStaff: "neutral", Management: "info",
  Link: "info", Image: "neutral", Video: "brand", "PDF & audio": "neutral", Seen: "success", Unseen: "warn",
  "Not checked in": "muted", "No check-out": "warn", Geo: "neutral", QR: "info", Officer: "neutral", Import: "neutral",
};
