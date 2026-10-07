/* ---------------------------------------------------------------------------
 * A TASK'S FORM — what the office asks the field to bring back. PURE.
 *
 * A task used to be a sentence and a tick: "collect the owner's birthday" came
 * back as "done", and the birthday came back as whatever the salesman typed
 * into a one-line note, if he typed it at all. A manager who wanted twelve
 * shops photographed and their stock of Nano counted could ask for exactly
 * that in words and receive twelve free-text notes nobody could add up.
 *
 * So a task can carry a FORM: an ordered list of fields, each a type the
 * office picks when assigning — a line of text, a number, yes or no, one of a
 * list, several of a list, photographs, a date, a birthday, a phone number, a
 * rating, where he is standing — and each may be shown only when an earlier
 * answer says so. The handset draws exactly these fields and nothing else, and
 * the answers come back keyed by field, so the Sales Dashboard can lay every
 * salesman's answers side by side and count them.
 *
 * THIS FILE IS COMPILED TWICE. `mbos-app/src/engines/task-form.ts` is a byte
 * for byte copy, pinned by `mbos-wire.test.ts`: the builder on the web, the
 * form on the phone and the check in the sync handler must agree about which
 * fields are showing and which answers are owed, or a salesman fills in a form
 * the office then reads as half empty. Edit THIS copy and copy it across. It
 * imports nothing, so the copy needs no normalising.
 *
 * Validation here is the office's and the phone's alike. The server's handler
 * CLEANS what arrives — drops answers to fields that are hidden or unknown and
 * answers of the wrong shape — but never REFUSES a completion for an answer
 * owed: an APK cannot be recalled, and a refusal would put a day's work in Not
 * accepted. What is missing is shown as missing on the results screen.
 * ------------------------------------------------------------------------- */

export const TASK_FIELD_TYPES = [
  "short_text",
  "long_text",
  "number",
  "yes_no",
  "single_choice",
  "multi_choice",
  "photo",
  "date",
  "birthday",
  "phone",
  "rating",
  "location",
  "info",
] as const;

export type TaskFieldType = (typeof TASK_FIELD_TYPES)[number];

/** What each type is called where somebody picks it, and what it asks for. */
export const TASK_FIELD_TYPE_LABELS: Record<TaskFieldType, { label: string; hint: string }> = {
  short_text: { label: "Short text", hint: "A name, a brand, one line." },
  long_text: { label: "Long text", hint: "A paragraph in his own words." },
  number: { label: "Number", hint: "A count, litres, an amount." },
  yes_no: { label: "Yes / No", hint: "One tap, either way." },
  single_choice: { label: "Pick one", hint: "One answer from your list." },
  multi_choice: { label: "Pick several", hint: "Any answers from your list." },
  photo: { label: "Photos", hint: "Taken with the camera or from the gallery." },
  date: { label: "Date", hint: "A day on the calendar." },
  birthday: { label: "Birthday", hint: "A day and a month. Never a year." },
  phone: { label: "Phone number", hint: "A ten-digit Indian mobile." },
  rating: { label: "Rating", hint: "One to five." },
  location: { label: "Location", hint: "Where he is standing, from the phone." },
  info: { label: "Instruction", hint: "Text he reads. Asks nothing." },
};

/** When a field shows. Evaluated against the answer to an EARLIER field. */
export type TaskFieldCondition = {
  field: string;
  /** `is` / `is_not` compare a single answer; `includes` reads a multi-pick;
      `answered` is any answer at all. Yes / No compares as "yes" or "no". */
  op: "is" | "is_not" | "includes" | "answered";
  value?: string;
};

export type TaskField = {
  /** Stable for the life of the task. Answers are keyed by it. */
  id: string;
  type: TaskFieldType;
  label: string;
  help?: string;
  required?: boolean;
  /** single_choice / multi_choice. */
  options?: string[];
  /** number: the range; photo: how many; text: the length. */
  min?: number;
  max?: number;
  /** number: what the figure is counted in — "litres", "cans", "₹". */
  unit?: string;
  showIf?: TaskFieldCondition;
};

export type BirthdayAnswer = { day: number; month: number };
export type LocationAnswer = { lat: number; lng: number; accuracyM?: number | null; at?: number | null };

export type TaskAnswer = string | number | boolean | string[] | BirthdayAnswer | LocationAnswer;
export type TaskAnswers = Record<string, TaskAnswer>;

export const MAX_TASK_FIELDS = 40;
export const MAX_TASK_OPTIONS = 30;
export const MAX_TASK_PHOTOS = 10;

/* ----------------------------------------------------------------- building */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A blank field of a type, ready for the builder. The caller mints the id. */
export function blankTaskField(type: TaskFieldType, id: string): TaskField {
  const base: TaskField = { id, type, label: "", required: type !== "info" };
  if (type === "single_choice" || type === "multi_choice") return { ...base, options: ["", ""] };
  if (type === "photo") return { ...base, min: 1, max: 3 };
  if (type === "rating") return { ...base, min: 1, max: 5 };
  return base;
}

/** Can a later field's condition read this one? Photos, instructions and
    places say nothing a condition could compare. */
export function canDriveCondition(field: TaskField): boolean {
  return ["yes_no", "single_choice", "multi_choice", "short_text", "number", "rating"].includes(field.type);
}

/** What a condition on this field may compare against, for the builder. */
export function conditionValues(field: TaskField): string[] {
  if (field.type === "yes_no") return ["yes", "no"];
  if (field.type === "single_choice" || field.type === "multi_choice") {
    return (field.options ?? []).map((o) => o.trim()).filter(Boolean);
  }
  if (field.type === "rating") {
    const out: string[] = [];
    for (let i = field.min ?? 1; i <= (field.max ?? 5); i++) out.push(String(i));
    return out;
  }
  return [];
}

/** A condition said back in words, for the builder and the results header. */
export function conditionSentence(cond: TaskFieldCondition, fields: TaskField[]): string {
  const parent = fields.find((f) => f.id === cond.field);
  const name = parent ? `"${parent.label || "an earlier question"}"` : "an earlier question";
  if (cond.op === "answered") return `Only when ${name} is answered`;
  if (cond.op === "includes") return `Only when ${name} includes "${cond.value ?? ""}"`;
  if (cond.op === "is_not") return `Only when ${name} is not "${cond.value ?? ""}"`;
  return `Only when ${name} is "${cond.value ?? ""}"`;
}

/**
 * What is wrong with a form as built — refused before it is assigned, because
 * a choice with no options or a condition pointing at nothing is a question no
 * salesman can answer, discovered by twenty of them at once.
 */
export function taskFormProblems(fields: TaskField[]): string[] {
  const out: string[] = [];
  if (fields.length > MAX_TASK_FIELDS) out.push(`A task can ask at most ${MAX_TASK_FIELDS} things.`);
  const seen = new Set<string>();
  fields.forEach((f, i) => {
    const n = `Question ${i + 1}`;
    if (!f.id || seen.has(f.id)) out.push(`${n} has no id of its own.`);
    seen.add(f.id);
    if (!TASK_FIELD_TYPES.includes(f.type)) out.push(`${n} is a kind of question this app does not know.`);
    if (!f.label.trim()) out.push(`${n} needs a question or an instruction.`);
    if (f.type === "single_choice" || f.type === "multi_choice") {
      const opts = (f.options ?? []).map((o) => o.trim()).filter(Boolean);
      if (opts.length < 2) out.push(`${n} needs at least two options to pick from.`);
      if (opts.length > MAX_TASK_OPTIONS) out.push(`${n} has more than ${MAX_TASK_OPTIONS} options.`);
      if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) {
        out.push(`${n} lists the same option twice.`);
      }
    }
    if (f.min != null && f.max != null && f.min > f.max) out.push(`${n}: the lowest is above the highest.`);
    if (f.type === "photo") {
      if ((f.max ?? 1) < 1 || (f.max ?? 1) > MAX_TASK_PHOTOS) {
        out.push(`${n}: between 1 and ${MAX_TASK_PHOTOS} photos.`);
      }
      if ((f.min ?? 0) < 0) out.push(`${n}: the fewest photos cannot be negative.`);
    }
    if (f.type === "rating" && ((f.min ?? 1) < 0 || (f.max ?? 5) > 10)) {
      out.push(`${n}: a rating runs from 0 to at most 10.`);
    }
    if (f.showIf) {
      const at = fields.findIndex((p) => p.id === f.showIf!.field);
      if (at < 0 || at >= i) out.push(`${n} depends on a question that does not come before it.`);
      else {
        const parent = fields[at];
        if (!canDriveCondition(parent)) out.push(`${n} depends on a question a condition cannot read.`);
        else if (f.showIf.op !== "answered" && !(f.showIf.value ?? "").trim()) {
          out.push(`${n}: say which answer makes it show.`);
        } else if (f.showIf.op === "includes" && parent.type !== "multi_choice") {
          out.push(`${n}: "includes" only reads a pick-several question.`);
        }
      }
    }
  });
  if (fields.length && fields.every((f) => f.type === "info")) {
    out.push("The form only gives instructions — add at least one question, or remove them all.");
  }
  return out;
}

/** The form as it should be stored: trimmed, blank options dropped. */
export function tidyTaskForm(fields: TaskField[]): TaskField[] {
  return fields.map((f) => {
    const out: TaskField = { id: f.id, type: f.type, label: f.label.trim() };
    if (f.help?.trim()) out.help = f.help.trim();
    if (f.type !== "info") out.required = Boolean(f.required);
    if (f.type === "single_choice" || f.type === "multi_choice") {
      out.options = (f.options ?? []).map((o) => o.trim()).filter(Boolean);
    }
    if (f.min != null && Number.isFinite(f.min)) out.min = f.min;
    if (f.max != null && Number.isFinite(f.max)) out.max = f.max;
    if (f.type === "number" && f.unit?.trim()) out.unit = f.unit.trim();
    if (f.showIf) {
      out.showIf = { field: f.showIf.field, op: f.showIf.op };
      if (f.showIf.op !== "answered") out.showIf.value = (f.showIf.value ?? "").trim();
    }
    return out;
  });
}

/** Read a stored form back, keeping only what is shaped like a field. */
export function parseTaskForm(raw: unknown): TaskField[] {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter(
    (f): f is TaskField =>
      Boolean(f) &&
      typeof f === "object" &&
      typeof (f as TaskField).id === "string" &&
      typeof (f as TaskField).label === "string" &&
      TASK_FIELD_TYPES.includes((f as TaskField).type),
  );
}

/* ----------------------------------------------------------------- answering */

function conditionHolds(cond: TaskFieldCondition, value: TaskAnswer | undefined): boolean {
  if (cond.op === "answered") return value !== undefined && answerPresent(value);
  if (value === undefined) return cond.op === "is_not";
  const want = (cond.value ?? "").trim().toLowerCase();
  const asText = (v: TaskAnswer): string =>
    typeof v === "boolean" ? (v ? "yes" : "no") : String(v).trim().toLowerCase();
  if (Array.isArray(value)) {
    const has = value.some((v) => v.trim().toLowerCase() === want);
    return cond.op === "is_not" ? !has : has;
  }
  const same = asText(value) === want;
  return cond.op === "is_not" ? !same : same;
}

function answerPresent(value: TaskAnswer): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && typeof value === "object";
}

/**
 * The fields showing for these answers, in order. A field whose parent is
 * hidden is hidden too, whatever was once typed into the parent — otherwise
 * clearing a "yes" would leave its follow-up asking a question about nothing.
 */
export function visibleTaskFields(fields: TaskField[], answers: TaskAnswers): TaskField[] {
  const shown = new Set<string>();
  const out: TaskField[] = [];
  for (const f of fields) {
    if (f.showIf) {
      if (!shown.has(f.showIf.field)) continue;
      if (!conditionHolds(f.showIf, answers[f.showIf.field])) continue;
    }
    shown.add(f.id);
    out.push(f);
  }
  return out;
}

/** Whether this field has an answer worth counting. */
export function isTaskFieldAnswered(field: TaskField, value: TaskAnswer | undefined): boolean {
  if (field.type === "info") return true;
  return value !== undefined && answerPresent(value);
}

function validDayMonth(day: number, month: number): boolean {
  if (!Number.isInteger(day) || !Number.isInteger(month)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const longest = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= longest;
}

/** Only digits; a leading +91 or 0 is the country, not the number. */
export function tidyPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

/** What is wrong with ONE answer, or null. Owed-but-blank is not this. */
function answerProblem(field: TaskField, value: TaskAnswer): string | null {
  switch (field.type) {
    case "short_text":
    case "long_text": {
      if (typeof value !== "string") return "Write it in words.";
      const n = value.trim().length;
      if (field.min != null && n > 0 && n < field.min) return `At least ${field.min} characters.`;
      if (field.max != null && n > field.max) return `At most ${field.max} characters.`;
      return null;
    }
    case "number":
    case "rating": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "A number.";
      if (field.min != null && value < field.min) return `Not below ${field.min}.`;
      if (field.max != null && value > field.max) return `Not above ${field.max}.`;
      return null;
    }
    case "yes_no":
      return typeof value === "boolean" ? null : "Yes or no.";
    case "single_choice":
      return typeof value === "string" && (field.options ?? []).includes(value) ? null : "Pick one of the options.";
    case "multi_choice":
      return Array.isArray(value) && value.every((v) => (field.options ?? []).includes(v))
        ? null
        : "Pick from the options.";
    case "photo": {
      if (!Array.isArray(value)) return "Add a photo.";
      const max = field.max ?? 1;
      if (value.length > max) return `At most ${max} photo${max === 1 ? "" : "s"}.`;
      const min = field.min ?? 0;
      if (value.length > 0 && value.length < min) return `At least ${min} photos.`;
      return null;
    }
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? null : "Pick a date.";
    case "birthday": {
      const b = value as BirthdayAnswer;
      return b && typeof b === "object" && validDayMonth(Number(b.day), Number(b.month))
        ? null
        : "Pick a day and a month that exist.";
    }
    case "phone":
      return typeof value === "string" && /^[6-9]\d{9}$/.test(tidyPhone(value))
        ? null
        : "A ten-digit mobile number.";
    case "location": {
      const l = value as LocationAnswer;
      return l &&
        typeof l === "object" &&
        typeof l.lat === "number" &&
        typeof l.lng === "number" &&
        Math.abs(l.lat) <= 90 &&
        Math.abs(l.lng) <= 180
        ? null
        : "Take the location again.";
    }
    case "info":
      return null;
  }
}

/** Every problem with these answers, field by field, for the form to show. */
export function taskAnswerProblems(
  fields: TaskField[],
  answers: TaskAnswers,
): { fieldId: string; message: string }[] {
  const out: { fieldId: string; message: string }[] = [];
  for (const f of visibleTaskFields(fields, answers)) {
    if (f.type === "info") continue;
    const value = answers[f.id];
    if (!isTaskFieldAnswered(f, value)) {
      if (f.required) {
        out.push({ fieldId: f.id, message: f.type === "photo" ? "A photo is needed." : "This is needed." });
      }
      continue;
    }
    if (f.type === "photo" && f.required && Array.isArray(value) && value.length < Math.max(1, f.min ?? 1)) {
      out.push({ fieldId: f.id, message: `At least ${Math.max(1, f.min ?? 1)} photos.` });
      continue;
    }
    const problem = answerProblem(f, value as TaskAnswer);
    if (problem) out.push({ fieldId: f.id, message: problem });
  }
  return out;
}

/**
 * The answers worth keeping: those to a field that is SHOWING, of the right
 * shape. An answer to a hidden field is a question the form took back, and an
 * answer of the wrong shape is a payload no screen can draw.
 */
export function cleanTaskAnswers(fields: TaskField[], raw: unknown): TaskAnswers {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const answers = raw as TaskAnswers;
  const out: TaskAnswers = {};
  for (const f of visibleTaskFields(fields, answers)) {
    if (f.type === "info") continue;
    const value = answers[f.id];
    if (value === undefined || !answerPresent(value)) continue;
    if (answerProblem(f, value) && !(f.type === "photo" && Array.isArray(value))) continue;
    if (f.type === "short_text" || f.type === "long_text") out[f.id] = (value as string).trim();
    else if (f.type === "phone") out[f.id] = tidyPhone(value as string);
    else if (f.type === "birthday") {
      const b = value as BirthdayAnswer;
      out[f.id] = { day: Number(b.day), month: Number(b.month) };
    } else if (f.type === "photo") {
      out[f.id] = (value as string[]).filter((v) => typeof v === "string" && v.length > 0).slice(0, f.max ?? MAX_TASK_PHOTOS);
    } else out[f.id] = value;
  }
  return out;
}

/** The photographs among the answers — what the server binds to the task. */
export function taskAnswerPhotoIds(fields: TaskField[], answers: TaskAnswers): string[] {
  const out: string[] = [];
  for (const f of fields) {
    if (f.type !== "photo") continue;
    const v = answers[f.id];
    if (Array.isArray(v)) for (const id of v) if (typeof id === "string" && id) out.push(id);
  }
  return out;
}

/** One answer in words — the results table, the export, the note. */
export function taskAnswerText(field: TaskField, value: TaskAnswer | undefined): string {
  if (value === undefined || !answerPresent(value)) return "";
  switch (field.type) {
    case "yes_no":
      return value ? "Yes" : "No";
    case "multi_choice":
      return (value as string[]).join(", ");
    case "photo": {
      const n = (value as string[]).length;
      return `${n} photo${n === 1 ? "" : "s"}`;
    }
    case "birthday": {
      const b = value as BirthdayAnswer;
      return `${b.day} ${MONTHS[b.month - 1] ?? ""}`.trim();
    }
    case "location": {
      const l = value as LocationAnswer;
      return `${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}`;
    }
    case "number":
      return field.unit ? `${value} ${field.unit}` : String(value);
    case "rating":
      return `${value} / ${field.max ?? 5}`;
    default:
      return String(value);
  }
}

/**
 * The answers as a note, one line a question. It is written as the task's
 * completion note, so every screen that already reads a completed task's note
 * — the task list, the timeline — reads the answers without being taught
 * about forms.
 */
export function taskAnswersNote(fields: TaskField[], answers: TaskAnswers): string {
  return visibleTaskFields(fields, answers)
    .filter((f) => f.type !== "info")
    .map((f) => {
      const text = taskAnswerText(f, answers[f.id]);
      return text ? `${f.label}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, 2000);
}

/* ----------------------------------------------------------------- reading back */

export type TaskFieldSummary =
  | { kind: "counts"; answered: number; counts: { label: string; count: number }[] }
  | { kind: "numbers"; answered: number; total: number; average: number; min: number; max: number }
  | { kind: "count"; answered: number; photos?: number };

/**
 * One question across every salesman's answers — how many said yes, what the
 * average was, which option won. Only answers given are counted; the caller
 * knows how many were asked and says the rest are outstanding.
 */
export function summariseTaskField(field: TaskField, values: (TaskAnswer | undefined)[]): TaskFieldSummary {
  const given = values.filter((v): v is TaskAnswer => v !== undefined && answerPresent(v));
  if (field.type === "yes_no") {
    const yes = given.filter((v) => v === true).length;
    return {
      kind: "counts",
      answered: given.length,
      counts: [
        { label: "Yes", count: yes },
        { label: "No", count: given.length - yes },
      ],
    };
  }
  if (field.type === "single_choice" || field.type === "multi_choice") {
    const counts = new Map<string, number>((field.options ?? []).map((o) => [o, 0]));
    for (const v of given) {
      for (const pick of Array.isArray(v) ? v : [String(v)]) counts.set(pick, (counts.get(pick) ?? 0) + 1);
    }
    return {
      kind: "counts",
      answered: given.length,
      counts: [...counts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count),
    };
  }
  if (field.type === "number" || field.type === "rating") {
    const nums = given.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (!nums.length) return { kind: "count", answered: 0 };
    const total = nums.reduce((a, b) => a + b, 0);
    return {
      kind: "numbers",
      answered: nums.length,
      total,
      average: total / nums.length,
      min: Math.min(...nums),
      max: Math.max(...nums),
    };
  }
  if (field.type === "photo") {
    return {
      kind: "count",
      answered: given.length,
      photos: given.reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 0), 0),
    };
  }
  return { kind: "count", answered: given.length };
}

/* ----------------------------------------------------------------- starting points */

/**
 * Forms somebody can start from rather than build. Ids are fixed strings so a
 * template is the same form every time it is picked; the builder renames them
 * if two templates are combined.
 */
export const TASK_FORM_TEMPLATES: { key: string; title: string; description: string; fields: TaskField[] }[] = [
  {
    key: "birthday",
    title: "Collect the owner's birthday",
    description: "Ask the owner for their birthday so we can wish them.",
    fields: [
      { id: "owner", type: "short_text", label: "Owner's name", required: true },
      { id: "birthday", type: "birthday", label: "Owner's birthday", required: true },
      { id: "mobile", type: "phone", label: "Owner's mobile", required: false },
    ],
  },
  {
    key: "shop_photo",
    title: "Photograph the shop",
    description: "A clear photo of the shop front and the board.",
    fields: [
      { id: "front", type: "photo", label: "Shop front with the board", required: true, min: 1, max: 3 },
      { id: "location", type: "location", label: "Where the shop is", required: true },
    ],
  },
  {
    key: "stock_check",
    title: "Stock check",
    description: "Count what our products they have on the shelf.",
    fields: [
      { id: "stocks", type: "yes_no", label: "Do they stock our products?", required: true },
      {
        id: "products",
        type: "multi_choice",
        label: "Which ones are on the shelf?",
        required: true,
        options: ["Nano Thinner", "PU Thinner", "Universal Thinner", "Other"],
        showIf: { field: "stocks", op: "is", value: "yes" },
      },
      {
        id: "cans",
        type: "number",
        label: "Roughly how many cans in all?",
        unit: "cans",
        min: 0,
        required: false,
        showIf: { field: "stocks", op: "is", value: "yes" },
      },
      {
        id: "why_not",
        type: "long_text",
        label: "Why not?",
        required: true,
        showIf: { field: "stocks", op: "is", value: "no" },
      },
      { id: "shelf", type: "photo", label: "Photo of the shelf", required: false, min: 0, max: 3 },
    ],
  },
  {
    key: "competitor",
    title: "Competitor check",
    description: "Who else sells to them, and at what price.",
    fields: [
      { id: "brand", type: "short_text", label: "Which brand do they buy most?", required: true },
      { id: "price", type: "number", label: "Their price per litre", unit: "₹", min: 0, required: false },
      {
        id: "happy",
        type: "single_choice",
        label: "How happy are they with it?",
        required: true,
        options: ["Very happy", "It is fine", "Looking to change"],
      },
      {
        id: "why",
        type: "long_text",
        label: "What would make them change?",
        required: false,
        showIf: { field: "happy", op: "is", value: "Looking to change" },
      },
    ],
  },
  {
    key: "feedback",
    title: "Customer feedback",
    description: "How the customer rates us, in their own words.",
    fields: [
      { id: "rating", type: "rating", label: "How do they rate our product?", min: 1, max: 5, required: true },
      { id: "complaint", type: "yes_no", label: "Any complaint?", required: true },
      {
        id: "detail",
        type: "long_text",
        label: "What is the complaint?",
        required: true,
        showIf: { field: "complaint", op: "is", value: "yes" },
      },
    ],
  },
];
