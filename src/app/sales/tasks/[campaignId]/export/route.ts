import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { toCsv } from "@/lib/csv";
import { today } from "@/lib/recompute";
import { taskCampaign } from "@/lib/services/task-campaign-service";
import { taskAnswerText, visibleTaskFields } from "@/lib/task-form";

/**
 * Every answer to one assignment, as a file — one row per salesman per shop,
 * one column per question, the same rows the Answers tab draws and narrowed by
 * the same `managerScope`. A photo is its link, because a spreadsheet cannot
 * hold the picture and a count of photos is not the evidence.
 */
export async function GET(request: Request, { params }: { params: Promise<{ campaignId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in", { status: 401 });
  if (!(await canOpenModule(user.id, "sales.tasks"))) {
    return new NextResponse("Not your screen", { status: 403 });
  }

  const { campaignId } = await params;
  const c = await taskCampaign(campaignId, await today());
  if (!c) return new NextResponse("Not found", { status: 404 });

  const origin = new URL(request.url).origin;
  const questions = c.form.filter((f) => f.type !== "info");
  const csv = toCsv(
    ["Salesman", "Shop", "Place", "State", "Due", "Answered at", ...questions.map((f) => f.label), "Note"],
    c.tasks.map((t) => {
      const answers = t.responses ?? {};
      const showing = new Set(visibleTaskFields(c.form, answers).map((f) => f.id));
      return [
        t.salesmanName,
        t.customerName ?? "",
        t.place ?? "",
        t.status === "done" ? "Answered" : t.status === "cancelled" ? "Withdrawn" : t.overdueDays > 0 ? "Overdue" : "Waiting",
        t.dueDate ?? "",
        t.completedAt ? new Date(t.completedAt).toISOString() : "",
        ...questions.map((f) => {
          if (t.status !== "done") return "";
          if (!showing.has(f.id)) return "(not asked)";
          const v = answers[f.id];
          if (f.type === "photo" && Array.isArray(v)) return v.map((id) => `${origin}/api/attachments/${id}`).join(" ");
          return taskAnswerText(f, v);
        }),
        t.completionNote ?? "",
      ];
    }),
  );

  const slug = c.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "task";
  return new NextResponse("﻿" + csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${slug}-answers.csv"`,
    },
  });
}
