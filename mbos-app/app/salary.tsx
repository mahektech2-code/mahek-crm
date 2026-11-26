import React from 'react';
import { Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, T } from '../src/components/ui/primitives';
import { CountUp, Stagger } from '../src/components/ui/motion';
import { color as C, weight, tabular, type as typeScale } from '../src/theme/tokens';
import { inrFromPaise, plural } from '../src/lib/format';
import { listSalary, type SalaryMonth } from '../src/data/salary';
import { GLYPH, Glyph, type GlyphShape } from '../src/components/me/kit';

/**
 * Salary — and now there IS one on this handset.
 *
 * This screen used to render a fully invented payslip, then a stub admitting
 * plainly that no channel carried real figures to it. `salaryFor` on the
 * server is that channel, arriving now. Two things this deliberately still
 * does NOT show, on purpose:
 *
 * **No incentive column.** MahekOne sets no monthly target for a field
 * salesman, so a figure computed from one would be an invention on the one
 * screen where a wrong number is least forgivable.
 *
 * **Reimbursements sit BESIDE the pay, never added to it.** A reimbursement
 * is money owed back for something already spent, not earnings — folding the
 * two into one total would answer a question nobody asked with a number that
 * looks like an answer to a different one.
 *
 * **The pay is the HR record's, said ONCE.** The office sends the employee
 * master's current figure against both months, and this drew it under each as
 * that month's "Net salary" — including the month still being worked, which
 * nobody has been paid for. It is one figure, the salary as HR holds it today,
 * and the months below it carry only what is genuinely per month.
 */
const monthName = (period: string) =>
  new Date(period + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

export default function SalaryScreen() {
  const back = useCameFrom('more');
  const [months, setMonths] = React.useState<SalaryMonth[] | null>(null);

  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      void listSalary().then((rows) => {
        if (live) setMonths(rows);
      });
      return () => {
        live = false;
      };
    }, []),
  );

  const current = months?.[0] ?? null;
  const hasFigures = current && (current.netSalaryPaise != null || current.employeeCode != null);

  return (
    <AppFrame
      title="Salary"
      activeTab={null}
      onBack={back.go}
      hero={
        <View
          accessible
          accessibilityLabel="These figures come from the office. If something looks wrong, tell the office."
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 }}>
          <Glyph shapes={OFFICE} size={14} color={C.lavenderMuted} />
          <T style={{ fontSize: 12, lineHeight: 17, color: C.lavenderMuted, flex: 1 }}>
            From the office. Looks wrong? Tell the office.
          </T>
        </View>
      }
      contentStyle={{ padding: 14, paddingBottom: 24, gap: 12 }}>
      <BackLink label={back.label} onPress={back.go} />

      {/* THREE ANSWERS, NOT TWO. The read being in flight, the table being
          empty and the account being unmatched used to share one card — the
          most accusing of the three — so a phone that simply had not pulled
          since HR published told him to ring the office about an account fault
          that did not exist, on the screen where a wrong statement is least
          forgivable. And before the read landed there was nothing on screen at
          all. */}
      {!months ? (
        <Card style={{ paddingHorizontal: 16, paddingVertical: 32 }} padded={false}>
          <T s="small" style={{ color: C.muted, textAlign: 'center' }}>Loading…</T>
        </Card>
      ) : months.length === 0 ? (
        <Card style={{ paddingHorizontal: 16, paddingVertical: 32 }} padded={false}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
            No salary on this phone yet
          </T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
            It comes with the next update from the office.
          </T>
        </Card>
      ) : !hasFigures ? (
        <Card style={{ paddingHorizontal: 16, paddingVertical: 32 }} padded={false}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
            Your employee record is not linked yet
          </T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
            The office links your pay to your email or work number. Ask them to check both are
            correct on your account.
          </T>
        </Card>
      ) : (
        <>
          <PayCard m={current!} />
          {months.map((m, i) => (
            <Stagger key={m.period} index={i}>
              <MonthCard m={m} />
            </Stagger>
          ))}
        </>
      )}
    </AppFrame>
  );
}

const OFFICE: GlyphShape[] = [{ p: 'M4 21V9l8-5 8 5v12M9 21v-6h6v6' }];
const TICK: GlyphShape[] = [{ p: 'M5 12l5 5 9-10' }];

function PayCard({ m }: { m: SalaryMonth }) {
  return (
    <View style={{ backgroundColor: C.navy, borderRadius: 24, padding: 18 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T style={[{ flex: 1, fontSize: 13, color: C.onNavyMuted }, weight(700)]}>Your salary, as HR holds it</T>
        {m.employeeCode ? (
          <View style={{ flexShrink: 1, minHeight: 26, paddingVertical: 3, paddingHorizontal: 10, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.10)', justifyContent: 'center' }}>
            <T style={[{ fontSize: 12, color: C.onNavy }, weight(700)]}>
              {m.employeeCode}
              {m.employeeStatus ? ' · ' + m.employeeStatus : ''}
            </T>
          </View>
        ) : null}
      </View>

      {/* Not from zero: a salary is a statement, not a reveal. It counts only
          if a later sync corrects the figure, which is the one time movement
          is the news. */}
      <View accessible accessibilityLabel={`Net salary a month ${m.netSalaryPaise != null ? inrFromPaise(m.netSalaryPaise) : 'not known'}`} style={{ marginTop: 10 }}>
        {m.netSalaryPaise != null ? (
          <CountUp
            value={m.netSalaryPaise}
            format={(n) => inrFromPaise(Math.round(n))}
            style={[typeScale.body, { fontSize: 36, lineHeight: 42, letterSpacing: -1, color: C.onNavy }, weight(800), tabular]}
          />
        ) : (
          <T style={[{ fontSize: 36, lineHeight: 42, color: C.onNavy }, weight(800), tabular]}>—</T>
        )}
        <T style={{ fontSize: 12, color: C.onNavyMuted }}>net a month</T>
      </View>

      {m.conveyancePaise != null || m.otherSalaryPaise != null ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
          {m.conveyancePaise != null ? <NavyFigure label="Conveyance" value={inrFromPaise(m.conveyancePaise)} /> : null}
          {m.otherSalaryPaise != null ? <NavyFigure label="Other" value={inrFromPaise(m.otherSalaryPaise)} /> : null}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 }}>
        <Glyph shapes={GLYPH.info} size={13} color={C.onNavyMuted} />
        <Text
          accessibilityLabel="This is the figure on your HR record, not a payslip for a month."
          style={[{ flex: 1, fontSize: 12, lineHeight: 17, color: C.onNavyMuted }, weight(400)]}>
          The HR record figure, not a month’s payslip
        </Text>
      </View>
    </View>
  );
}

function NavyFigure({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 16, paddingVertical: 10, paddingHorizontal: 12 }}>
      <T style={{ fontSize: 11, lineHeight: 15, color: C.onNavyMuted }}>{label}</T>
      <T style={[{ marginTop: 4, fontSize: 17, lineHeight: 22, color: C.onNavy }, weight(800), tabular]}>{value}</T>
    </View>
  );
}

function MonthCard({ m }: { m: SalaryMonth }) {
  return (
    <Card style={{ borderRadius: 22 }}>
      <T style={[{ fontSize: 17, lineHeight: 22, color: C.ink }, weight(800)]}>{monthName(m.period)}</T>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
        <Figure
          icon={TICK}
          iconColor={C.success}
          value={m.daysWorked != null ? plural(m.daysWorked, 'day') : '—'}
          valueColor={m.daysWorked != null ? C.ink : C.faint}
          label="worked"
          a11y="Days worked"
        />
        {m.daysOnLeave ? (
          <Figure icon={GLYPH.cal} iconColor={C.primaryDeep} value={plural(m.daysOnLeave, 'day')} label="on leave" a11y="Days on leave" />
        ) : null}
        {/* Beside the pay, never added to it — money owed back is not earnings.
            And APPROVED is all the office can say: approved to pay back is not
            the same as already in his account. */}
        {m.reimbursedPaise ? (
          <Figure
            icon={GLYPH.receipt}
            iconColor={C.success}
            value={inrFromPaise(m.reimbursedPaise)}
            valueColor={C.success}
            label="expenses approved to pay back"
            a11y="Expenses approved to pay back"
          />
        ) : null}
        {/* Three columns always, so a month with one figure lines up with one
            carrying three. */}
        {!m.daysOnLeave ? <View style={{ flex: 1 }} /> : null}
        {!m.reimbursedPaise ? <View style={{ flex: 1 }} /> : null}
      </View>
      {/* WHAT WAS ACTUALLY PAID BACK, off the payouts ledger — the half
          "approved to pay back" could never say. A transfer covers a week, so
          it is the month's money handed over, not one expense's. */}
      {m.paidBackPaise != null && (m.paidBackPaise > 0 || (m.reimbursedPaise ?? 0) > 0) ? (
        <T
          style={{ fontSize: 12.5, lineHeight: 17, color: m.paidBackPaise > 0 ? C.success : C.muted, marginTop: 10 }}>
          {m.paidBackPaise > 0
            ? 'Paid back to you this month: ' + inrFromPaise(m.paidBackPaise)
            : 'Nothing paid back to you yet this month'}
        </T>
      ) : null}
    </Card>
  );
}

function Figure({
  icon,
  iconColor,
  value,
  valueColor = C.ink,
  label,
  a11y,
}: {
  icon: GlyphShape[];
  iconColor: string;
  value: string;
  valueColor?: string;
  label: string;
  a11y: string;
}) {
  return (
    <View style={{ flex: 1 }} accessible accessibilityLabel={`${a11y}: ${value}`}>
      <Glyph shapes={icon} size={16} color={iconColor} />
      <T style={[{ fontSize: 19, lineHeight: 25, color: valueColor }, weight(800), tabular]}>{value}</T>
      <T style={{ marginTop: 4, fontSize: 11, lineHeight: 15, color: C.muted }}>{label}</T>
    </View>
  );
}
