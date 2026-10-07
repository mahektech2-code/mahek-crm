import type { BoardRow } from "@/lib/hire/services/pipeline";

/* Client-safe shapes the board, the table and the add dialog share. */

export type BoardStage = { key: string; name: string; type: string; slaHours: number };

export type BoardBlueprint = {
  id: string;
  key: string;
  title: string;
  version: number;
  status: string;
  locations: string[];
  stages: BoardStage[];
};

export type StaffOption = { id: string; name: string; role: string | null };

export type PipelineData = {
  rows: BoardRow[];
  blueprints: BoardBlueprint[];
  staff: StaffOption[];
  nowMs: number;
  me: { id: string; role: string; roleLabel: string };
  can: { override: boolean; addCandidate: boolean; seesScores: boolean };
  overrideWho: string;
};

/** Stage types in pipeline order — the columns of the all-roles board. */
export const TYPE_ORDER: { type: string; name: string }[] = [
  { type: "application", name: "Application" },
  { type: "ai_screen", name: "Screen" },
  { type: "scored_interview", name: "Interviews" },
  { type: "async_assessment", name: "Async assessment" },
  { type: "work_sample", name: "Work sample" },
  { type: "briefing", name: "Briefing" },
  { type: "reference_check", name: "Reference check" },
  { type: "decision_gate", name: "Decision gate" },
  { type: "document_collection", name: "Documents & offer" },
  { type: "checklist", name: "Assets & induction" },
  { type: "system_setup", name: "System setup" },
  { type: "terminal", name: "Hired" },
];
