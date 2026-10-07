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
 * the store, an administrator) is not narrowed by any of this, so nothing that
 * worked before this landed stopped working.
 *
 * The requirement's own `department` column carries the LABEL, because it was
 * free text from a reference list before departments were a rule, and every
 * requirement already raised names its department in words.
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

export const DEPARTMENT_LABELS: readonly string[] = ERP_DEPARTMENTS.map((d) => d.label);

/**
 * Whether a requirement for `materialType`, raised for `departmentLabel`, by
 * somebody in `seat`, is allowed — and if not, the sentence that says why.
 *
 * Two rules, and both apply to everybody:
 *  - a requirement filed under one of the three departments is for that
 *    department's categories (a Mixing requirement is a chemical one);
 *  - a departmental person raises only for their own department(s).
 * Somebody with no seat may raise for any department, and a requirement
 * filed under a non-production department (Office, Maintenance) is not
 * narrowed by category.
 */
export function requirementRefusal(seat: ErpDepartmentSeat | null | undefined, departmentLabel: string, materialType: string): { field: "department" | "type"; message: string } | null {
  const mine = departmentsOf(seat);
  const dept = departmentByLabel(departmentLabel);
  if (mine.length && (!dept || !mine.some((d) => d.key === dept.key))) {
    return { field: "department", message: `You raise requirements for ${mine.map((d) => d.label).join(", ")} only` };
  }
  if (dept && materialType && !dept.materialTypes.includes(materialType)) {
    return { field: "type", message: `${dept.label} asks for ${listWords(dept.materialTypes)} only` };
  }
  return null;
}

/** The categories somebody may pick for a department: its own, or every category where it is not one of the three. */
export function categoriesFor(departmentLabel: string, allTypes: readonly string[]): string[] {
  const dept = departmentByLabel(departmentLabel);
  return dept ? allTypes.filter((t) => dept.materialTypes.includes(t)) : [...allTypes];
}

/** Whether a requirement belongs on a departmental person's list: one of their departments, or one they raised themselves. */
export function requirementVisibleTo(seat: ErpDepartmentSeat | null | undefined, departmentLabel: string | null, raisedByMe: boolean): boolean {
  const mine = departmentsOf(seat);
  if (!mine.length || raisedByMe) return true;
  const dept = departmentByLabel(departmentLabel);
  return !!dept && mine.some((d) => d.key === dept.key);
}

function listWords(xs: readonly string[]): string {
  const lower = xs.map((x) => x.toLowerCase());
  return lower.length <= 1 ? (lower[0] ?? "") : `${lower.slice(0, -1).join(", ")} and ${lower[lower.length - 1]}`;
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
