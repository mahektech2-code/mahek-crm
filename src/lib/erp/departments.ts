/* ---------------------------------------------------------------------------
 * THE PRODUCTION DEPARTMENTS, and what each one buys and makes.
 *
 * Purchase runs step by step, department by department:
 *
 *   Mixing & Blending   raise the chemical requirement → test the chemical
 *                       when it arrives → make SFG
 *   Refilling           raise the can (and drum) requirement → fill FG
 *   Packing             raise the empty-box requirement → raise the packing
 *                       stationery requirement → make packing batches
 *   Production Head     every step of all three
 *
 * A department is held through the ERP DESIGNATION (`erp_designations.
 * department`): the designation already says which screens and powers a job
 * opens, and the department is the one more fact about that job — what it may
 * ASK TO BE BOUGHT. Somebody holding no departmental designation (the office,
 * the store, an administrator) raises for any of the four teams — the three
 * and the Production Head — but always under one of them, and the team decides
 * the categories.
 *
 * The requirement's own `department` column carries the LABEL. It was free
 * text from a reference list before departments were a rule; that list is
 * retired (0233) and requirements raised under it keep their words.
 *
 * PURE and client-safe: the requirement form narrows its categories in the
 * browser from the same table the server refuses with.
 * ------------------------------------------------------------------------- */

export type ErpDepartmentKey = "mixing" | "refilling" | "packing";
/** What `erp_designations.department` may hold: one department, or the head of all three. */
export type ErpDepartmentSeat = ErpDepartmentKey | "head";

export const DEPARTMENT_SEATS: readonly ErpDepartmentSeat[] = ["mixing", "refilling", "packing", "head"];

export type DepartmentStep = {
  /** Stable key, used by the Departments page to read the step's figures. */
  key: string;
  label: string;
  sentence: string;
  /** The ERP screen the step is done on. */
  screen: string;
  /** For a requirement step, the categories it asks for — the first is what a new one opens on. */
  materialTypes?: readonly string[];
};

export type ErpDepartment = {
  key: ErpDepartmentKey;
  /** What the requirement's `department` column holds, and the page heading. */
  label: string;
  /** The item-master categories this department may raise a requirement for. */
  materialTypes: readonly string[];
  steps: readonly DepartmentStep[];
};

export const ERP_DEPARTMENTS: readonly ErpDepartment[] = [
  {
    key: "mixing",
    label: "Mixing & Blending",
    materialTypes: ["Chemical"],
    steps: [
      {
        key: "chemicalReq",
        label: "Create chemical requirement",
        sentence: "Ask for the chemicals the next batches need. The chemical's purchase rule decides whether quotations are collected first.",
        screen: "requisitions",
        materialTypes: ["Chemical"],
      },
      {
        key: "chemicalTest",
        label: "Test the inward chemical",
        sentence: "Every chemical lot is tested when it arrives — smell, density and the tests its item requires — before it reaches stock.",
        screen: "testing",
      },
      {
        key: "sfg",
        label: "Make SFG",
        sentence: "Blend tested chemical lots into semi-finished liquid. One line per lot consumed.",
        screen: "sfgBatches",
      },
    ],
  },
  {
    key: "refilling",
    label: "Refilling",
    materialTypes: ["Can", "Drum"],
    steps: [
      {
        key: "canReq",
        label: "Create can requirement",
        sentence: "Ask for the empty cans (and drums) the filling line needs.",
        screen: "requisitions",
        materialTypes: ["Can", "Drum"],
      },
      {
        key: "fill",
        label: "Make FG filling",
        sentence: "Fill SFG into cans or drums. The cans used come out of stock.",
        screen: "fgFill",
      },
    ],
  },
  {
    key: "packing",
    label: "Packing",
    materialTypes: ["Box", "Stationary"],
    steps: [
      {
        key: "boxReq",
        label: "Create empty box requirement",
        sentence: "Ask for the empty boxes the packing line needs.",
        screen: "requisitions",
        materialTypes: ["Box"],
      },
      {
        key: "stationeryReq",
        label: "Create packing stationery requirement",
        sentence: "Ask for the tape, labels and other stationery packing uses.",
        screen: "requisitions",
        materialTypes: ["Stationary"],
      },
      {
        key: "pack",
        label: "Make packing batches",
        sentence: "Pack loose cans into boxes. A batch posts only when the cans used match the boxes.",
        screen: "packBatches",
      },
    ],
  },
];

export const SEAT_LABEL: Record<ErpDepartmentSeat, string> = {
  mixing: "Mixing & Blending",
  refilling: "Refilling",
  packing: "Packing",
  head: "Production Head",
};

export function isDepartmentSeat(v: unknown): v is ErpDepartmentSeat {
  return typeof v === "string" && (DEPARTMENT_SEATS as readonly string[]).includes(v);
}

/** The departments a seat works in: one, or all three for the head. Null seat: none — the person is not departmental. */
export function departmentsOf(seat: ErpDepartmentSeat | null | undefined): ErpDepartment[] {
  if (!seat) return [];
  return seat === "head" ? [...ERP_DEPARTMENTS] : ERP_DEPARTMENTS.filter((d) => d.key === seat);
}

/** The department a requirement's `department` label names, if it is one of the three. */
export function departmentByLabel(label: string | null | undefined): ErpDepartment | undefined {
  const l = (label ?? "").trim().toLowerCase();
  return ERP_DEPARTMENTS.find((d) => d.label.toLowerCase() === l);
}

/** What a requirement filed by the Production Head says in its `department` column. */
export const HEAD_LABEL = SEAT_LABEL.head;

/**
 * THE FOUR A REQUIREMENT IS RAISED FOR, and nothing else. The form offered a
 * reference list beside the three departments — Production, Godown / Store,
 * Quality, Dispatch, Office, Maintenance — and every one of those was a way to
 * ask for anything at all, which is the opposite of what the departments are
 * for. A requirement is now raised by one of the four teams, and the team
 * decides the categories it may ask for. Rows raised under the old labels keep
 * them: an edit that leaves the department alone is not refused.
 */
export const REQUIREMENT_DEPARTMENTS: readonly string[] = [...ERP_DEPARTMENTS.map((d) => d.label), HEAD_LABEL];

/** Kept for readers that list the three production departments. */
export const DEPARTMENT_LABELS: readonly string[] = ERP_DEPARTMENTS.map((d) => d.label);

/** The departments somebody may raise a requirement for: their own, or all four where they hold the head's seat or no seat. */
export function requirementDepartmentsFor(seat: ErpDepartmentSeat | null | undefined): string[] {
  if (!seat || seat === "head") return [...REQUIREMENT_DEPARTMENTS];
  return departmentsOf(seat).map((d) => d.label);
}

/** The categories a requirement department may ask for. The head asks for every category of the three. */
export function categoriesForDepartment(departmentLabel: string): string[] {
  if ((departmentLabel ?? "").trim().toLowerCase() === HEAD_LABEL.toLowerCase()) return [...new Set(ERP_DEPARTMENTS.flatMap((d) => d.materialTypes))];
  return [...(departmentByLabel(departmentLabel)?.materialTypes ?? [])];
}

/** The department that asks for a category — the one a store re-order is raised under. */
export function departmentForCategory(materialType: string): string {
  return ERP_DEPARTMENTS.find((d) => d.materialTypes.includes(materialType))?.label ?? HEAD_LABEL;
}

/**
 * Whether a requirement for `materialType`, raised for `departmentLabel`, by
 * somebody in `seat`, is allowed — and if not, the sentence that says why.
 *
 *  - the department must be one of the four, and one this person raises for
 *    (a department person raises for their own; the head and anybody outside
 *    production may pick any of the four);
 *  - the category must be one that department asks for.
 */
export function requirementRefusal(seat: ErpDepartmentSeat | null | undefined, departmentLabel: string, materialType: string): { field: "department" | "type"; message: string } | null {
  const allowed = requirementDepartmentsFor(seat);
  const label = allowed.find((a) => a.toLowerCase() === (departmentLabel ?? "").trim().toLowerCase());
  if (!label) {
    const mine = departmentsOf(seat);
    return {
      field: "department",
      message: seat && seat !== "head" ? `You raise requirements for ${mine.map((d) => d.label).join(", ")} only` : `Pick ${listWords(allowed, "or", false)}`,
    };
  }
  const cats = categoriesForDepartment(label);
  if (materialType && !cats.includes(materialType)) {
    return { field: "type", message: `${label} asks for ${listWords(cats)} only` };
  }
  return null;
}

/** The categories somebody may pick for a department, out of the item master's list. A label that is not one of the four offers none. */
export function categoriesFor(departmentLabel: string, allTypes: readonly string[]): string[] {
  const cats = categoriesForDepartment(departmentLabel);
  return allTypes.filter((t) => cats.includes(t));
}

/** Whether a requirement belongs on a departmental person's list: one of their departments, or one they raised themselves. The head sees all of production. */
export function requirementVisibleTo(seat: ErpDepartmentSeat | null | undefined, departmentLabel: string | null, raisedByMe: boolean): boolean {
  const mine = departmentsOf(seat);
  if (!mine.length || raisedByMe) return true;
  if (seat === "head" && (departmentLabel ?? "").trim().toLowerCase() === HEAD_LABEL.toLowerCase()) return true;
  const dept = departmentByLabel(departmentLabel);
  return !!dept && mine.some((d) => d.key === dept.key);
}

function listWords(xs: readonly string[], joiner = "and", lower = true): string {
  const w = lower ? xs.map((x) => x.toLowerCase()) : [...xs];
  return w.length <= 1 ? (w[0] ?? "") : `${w.slice(0, -1).join(", ")} ${joiner} ${w[w.length - 1]}`;
}

/**
 * The department step a requirement is counted under on the Departments page:
 * the department it names and the step asking for its category; or, where it
 * names a department outside production (raised by the store before
 * departments were a rule), the step that asks for its category — a chemical
 * the store asked for still feeds Mixing & Blending's batches.
 */
export function requirementStep(departmentLabel: string | null | undefined, materialType: string): { department: ErpDepartment; step: DepartmentStep } | null {
  const named = departmentByLabel(departmentLabel);
  for (const d of named ? [named] : ERP_DEPARTMENTS)
    for (const step of d.steps) if (step.materialTypes?.includes(materialType)) return { department: d, step };
  return null;
}
