import { shortDate } from "@/lib/format";
import { today } from "@/lib/recompute";
import { listGrades, listPolicies, readPolicy, unmappedPositions } from "@/lib/services/expense-policy-service";
import { describeQualifier, ruleSpec } from "@/lib/expense-rule-forms";
import {
  Banner,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "../parts";

export const metadata = { title: "Expense policy — Sales Dashboard — MahekOne" };

/**
 * What the field is allowed, and from when. READ-ONLY.
 *
 * Authoring lives in the Admin Console, deliberately. A manager writing the
 * rules for what their own team's travelling may cost is the same conflict
 * `order.approve` exists to avoid one level up — the person chasing the target
 * must not also write the rules for what chasing it is allowed to cost. What a
 * manager needs is to be able to READ them, because they are the person a
 * salesman argues with about a claim.
 *
 * Every rule is shown as a SENTENCE. A table of stored values is not something
 * anybody can hold against the document HR issued, which is what requirement 4
 * asks somebody to do.
 */
export default async function Page() {
  const now = await today();
  const versions = await listPolicies(now);
  const inForce = versions.find((v) => v.inForce);
  const [detail, grades, unmapped] = await Promise.all([
    inForce ? readPolicy(inForce.id, now) : Promise.resolve(null),
    listGrades(),
    unmappedPositions(),
  ]);

  const gradeLabel = (key: string) => grades.find((g) => g.key === key)?.label ?? key;
  const residual = grades.find((g) => g.isResidual);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Expense policy"
        subtitle="What the field is allowed, and from when. Read-only here — a policy is authored in the Admin Console, because whoever chases a target should not also write the rules for what the chase may cost."
      />

      {!inForce ? (
        <Banner
          tone="danger"
          title="No expense policy is in force"
          body="Claims are still recorded — the money is spent either way — but nothing has an eligible amount until a version covering today is published. Every day submitted meanwhile goes to a person rather than being approved against rules that do not exist."
        />
      ) : null}

      {unmapped.length ? (
        <Banner
          tone="warn"
          title={`${unmapped.length} job title in HRMS that no grade names`}
          body={`${unmapped.map((u) => `${u.position} (${u.peopleCount})`).join(", ")} — these people are paid on the ${residual?.label ?? "residual"} rules. That is a real answer and an ordinary one, but somebody being paid on a rule nobody chose for them should not be invisible.`}
        />
      ) : null}

      <MetricRow
        metrics={[
          {
            label: "In force",
            value: inForce ? `Version ${inForce.versionNo}` : "None",
            sub: inForce ? `from ${shortDate(inForce.effectiveFrom)}` : undefined,
            tone: inForce ? undefined : "warn",
          },
          { label: "Rules", value: String(detail?.rules.length ?? 0) },
          { label: "Versions", value: String(versions.length) },
          { label: "Grades", value: String(grades.filter((g) => g.active).length) },
        ]}
      />

      {detail && detail.rules.length ? (
        <Table
          minWidth={950}
          head={
            <>
              <HeadCell width={210}>Rule</HeadCell>
              <HeadCell>What it says</HeadCell>
              <HeadCell width={220}>Applies to</HeadCell>
            </>
          }
        >
          {detail.rules.map((r, i) => {
            const spec = ruleSpec(r.kind);
            return (
              <Row key={r.id} striped={i % 2 === 1}>
                <Cell truncate={210}>
                  <span className="font-medium text-ink">{spec?.label ?? r.kind}</span>
                  {spec ? (
                    <span
                      className="block text-[12px] text-muted"
                      title={`The client's numbered requirements this answers: ${spec.requirements.join(", ")}`}
                    >
                      §{spec.requirements.join(", §")}
                    </span>
                  ) : null}
                </Cell>
                <Cell>
                  {r.sentence ?? (
                    <span className="text-muted">
                      This release cannot read a rule of kind “{r.kind}”. It is still in force —
                      it simply cannot be shown here.
                    </span>
                  )}
                </Cell>
                <Cell>
                  {describeQualifier(r, gradeLabel) || (
                    <span className="text-muted">Everybody, everywhere</span>
                  )}
                </Cell>
              </Row>
            );
          })}
        </Table>
      ) : (
        <Empty
          title={inForce ? "This version has no rules" : "Nothing published yet"}
          body="A policy is uploaded and its rates typed in the Admin Console, then verified and published by an administrator. Until then nothing here has an eligible amount."
        />
      )}

      <div className="mt-8">
        <h2 className="mb-2 text-[15px] font-medium text-ink">Every version</h2>
        <Table
          minWidth={800}
          head={
            <>
              <HeadCell width={90}>Version</HeadCell>
              <HeadCell>Title</HeadCell>
              <HeadCell width={130}>State</HeadCell>
              <HeadCell width={230}>In force</HeadCell>
              <HeadCell width={180}>Published by</HeadCell>
            </>
          }
        >
          {versions.map((v, i) => (
            <Row key={v.id} striped={i % 2 === 1}>
              <Cell>{v.versionNo}</Cell>
              <Cell truncate={360}>{v.title}</Cell>
              <Cell>
                <Pill
                  tone={
                    v.inForce ? "success" : v.status === "draft" ? "warn" : "neutral"
                  }
                >
                  {v.inForce ? "In force" : v.status}
                </Pill>
              </Cell>
              <Cell>
                {shortDate(v.effectiveFrom)}
                {v.effectiveTo ? ` — ${shortDate(v.effectiveTo)}` : " onwards"}
              </Cell>
              <Cell truncate={180}>
                {v.publishedByName ?? <span className="text-muted">Not published</span>}
              </Cell>
            </Row>
          ))}
        </Table>
      </div>
    </div>
  );
}
