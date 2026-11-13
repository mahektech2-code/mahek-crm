"use client";

import { useRouter } from "next/navigation";
import { saveLadder } from "@/lib/actions/locker-admin";
import { CRIT } from "@/lib/locker/engine";
import { Pill, btnStyle, useModal, useToast } from "../../_ui/kit";
import { Block, Grid, LList } from "../../_ui/vault-parts";

export function LaddersScreen({ ladders }: { ladders: Record<number, number[]> }) {
  const router = useRouter();
  const modal = useModal();
  const toast = useToast();
  return (
    <div style={{ padding: "0 24px 48px 24px" }}>
      <Grid cols={2}>
        {[4, 3, 2, 1].map((k) => {
          const L = ladders[k] ?? [];
          return (
            <Block
              key={k}
              title={CRIT[k].label}
              sub={`${L.length} steps · owner → backup → department head → management`}
              acts={
                <button
                  type="button"
                  onClick={() =>
                    modal({
                      title: `Edit the ${CRIT[k].label.toLowerCase()} schedule`,
                      sub: "Days relative to the day somebody must act: −30 is thirty days before, 0 the day itself, +1 the day after (and daily after the last one until it is resolved).",
                      fields: [{ k: "o", l: "Reminder days", req: true, init: L.join(", "), hint: "Comma separated, e.g. −90, −30, −7, 0, 1" }],
                      okL: "Save schedule",
                      done: async (v) => {
                        const offsets = v.o.replace(/−/g, "-").split(/[,\s]+/).filter(Boolean).map(Number);
                        if (offsets.some((n) => !Number.isInteger(n))) return "Whole numbers only.";
                        const r = await saveLadder(k, offsets);
                        if (!r.ok) return r.error;
                        toast("Schedule saved");
                        router.refresh();
                      },
                    })
                  }
                  style={btnStyle("s", true)}
                >
                  Edit schedule
                </button>
              }
            >
              <LList
                items={L.map((x) => ({
                  key: String(x),
                  t: x > 0 ? `+${x} daily` : x === 0 ? "End date day" : `${x} days`,
                  sub:
                    (x <= -30 ? "In-app · owner" : x <= -7 ? "In-app · owner and backup" : `In-app · owner, backup, department head${k === 4 ? ", management" : ""}`) + (x >= 0 ? " · moves up if nobody acts" : ""),
                  badge: x >= 0 ? <Pill label="Moves up" bg="#FCECEC" fg="#B3261E" /> : <Pill label="Reminder" bg="#F7F8FA" fg="#3D4453" />,
                }))}
              />
            </Block>
          );
        })}
      </Grid>
    </div>
  );
}
