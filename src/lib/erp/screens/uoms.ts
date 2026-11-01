import "server-only";
import { okVoid } from "@/lib/result";
import type { ScreenModule } from "../server";
import type { ActionSpec, ColSpec, FieldSpec, FormSpec } from "../ui";
import { BASE_SHORT, MEASURES, MEASURE_LABEL, tidy, uomSentence, type Measure, type UomDraft } from "../engines/uom";
import { addUom, editUom, listUoms, setUomActive } from "../uoms";

/* ---------------------------------------------------------------------------
 * Masters → Reference lists → Units: every unit a quantity may be typed in.
 * A tab of Reference lists, so it is opened by holding that screen; any form's
 * quantity box can also add a unit on the spot.
 * ------------------------------------------------------------------------- */

const MEASURE_OPT: Record<Measure, string> = {
  weight: "Weight — kept in kg",
  volume: "Volume — kept in litres",
  count: "Count — kept in pieces (cans, boxes, drums)",
};
const measureByOpt = (o: string): string => (Object.entries(MEASURE_OPT).find(([, l]) => l === o)?.[0] ?? o);

function fields(): FieldSpec[] {
  return [
    { k: "name", l: "Unit name", t: "text", req: true, hint: "As people say it: Drum (200 L), Bag (25 kg), Dozen." },
    { k: "measure", l: "What it measures", t: "select", req: true, opts: MEASURES.map((m) => MEASURE_OPT[m]) },
    { k: "perBase", l: "How many base units one of it is", t: "num", req: true, min: 0.000001, qtyUnit: false, hint: "A Drum (200 L) is 200 litres; a Gram is 0.001 kg; a Dozen is 12 pieces." },
  ];
}

function draftOf(h: Record<string, string>): UomDraft {
  return { name: h.name ?? "", measure: measureByOpt(h.measure ?? ""), perBase: h.perBase ?? "" };
}

export const uomsScreen: ScreenModule = {
  key: "uoms",
  async load() {
    const units = await listUoms();
    const newForm: FormSpec = { screen: "uoms", id: "new", title: "Add a unit", submit: "Add unit", header: fields() };
    const cols: ColSpec[] = [
      { k: "name", l: "Unit", t: "b" },
      { k: "measure", l: "Measures", t: "t" },
      { k: "size", l: "One of it is", t: "t" },
      { k: "status", l: "Status", t: "s" },
    ];
    return {
      spec: { screen: "uoms", cols, hidden: [], groups: ["measure"], newForm, newLabel: "Add unit", noDataLine: "No units yet." },
      rows: units.map((u) => {
        const actions: ActionSpec[] = u.builtIn
          ? []
          : [
              {
                id: "edit",
                l: "Edit",
                primary: true,
                prompt: {
                  title: `Edit ${u.name}`,
                  sub: "Changing a unit changes nothing already saved: every figure was turned into the base unit when it was typed.",
                  submit: "Save",
                  fields: fields(),
                  init: { name: u.name, measure: MEASURE_OPT[u.measure], perBase: String(tidy(u.perBase)) },
                },
              },
              u.active
                ? { id: "retire", l: "Retire", confirm: `Stop offering ${u.name} on every form? Nothing already saved changes.` }
                : { id: "restore", l: "Restore" },
            ];
        return {
          id: u.id,
          v: {
            name: u.name,
            measure: MEASURE_LABEL[u.measure],
            size: u.builtIn ? `Base unit (${BASE_SHORT[u.measure]})` : `${tidy(u.perBase)} ${BASE_SHORT[u.measure]}`,
            status: u.active ? "Active" : "Retired",
          },
          flags: [],
          title: u.name,
          header: uomSentence(u),
          fields: [],
          actions,
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      const res = await addUom(ctx, draftOf(h));
      return res.ok ? okVoid(`${res.data.name} added · it is offered on every quantity of its kind`) : res;
    },
  },
  actions: {
    async edit(ctx, id, values) {
      const res = await editUom(ctx, id, draftOf(values));
      return res.ok ? okVoid(`${res.data.name} saved`) : res;
    },
    async retire(ctx, id) {
      const res = await setUomActive(ctx, id, false);
      return res.ok ? okVoid(`${res.data.name} retired`) : res;
    },
    async restore(ctx, id) {
      const res = await setUomActive(ctx, id, true);
      return res.ok ? okVoid(`${res.data.name} restored`) : res;
    },
  },
};

