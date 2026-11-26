import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { trainingAttempts, trainingEnrollments, trainingModules } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { nowMs } from "@/lib/format";
import { attemptQuestion, submitAttempt } from "@/lib/training/service";
import { Player } from "./player";
import { ResultView } from "./result";

export const dynamic = "force-dynamic";
export const metadata = { title: "Test" };

/**
 * One attempt. Open: the first question, served by the server without its
 * answer. Submitted, or past its deadline: the result — reading a submitted
 * attempt's result writes nothing.
 */
export default async function TestPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = await params;
  const user = await requireUser();
  const [own] = await db
    .select({ enrollmentId: trainingAttempts.enrollmentId, moduleKey: trainingAttempts.moduleKey, title: trainingModules.title })
    .from(trainingAttempts)
    .innerJoin(trainingEnrollments, eq(trainingEnrollments.id, trainingAttempts.enrollmentId))
    .leftJoin(trainingModules, eq(trainingModules.key, trainingAttempts.moduleKey))
    .where(and(eq(trainingAttempts.id, attemptId), eq(trainingEnrollments.userId, user.id)))
    .limit(1);
  if (!own) notFound();
  const now = nowMs();
  const title = own.title ?? own.moduleKey;
  const q = await attemptQuestion(user.id, attemptId, 0, now);
  if (q.ok && !q.data.submitted) return <Player key={attemptId} first={q.data} title={title} enrollmentId={own.enrollmentId} />;
  const r = await submitAttempt(user.id, attemptId, now);
  if (!r.ok) notFound();
  return <ResultView r={r.data} title={title} enrollmentId={own.enrollmentId} notice={q.ok ? null : q.error} />;
}
