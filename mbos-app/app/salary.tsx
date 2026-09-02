import React from 'react';
import { View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, T } from '../src/components/ui/primitives';
import { color as C, weight, tabular } from '../src/theme/tokens';
import { inr, plural } from '../src/lib/format';
import { listSalary, type SalaryMonth } from '../src/data/salary';

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
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Salary</T>
      <T s="small" style={{ color: C.muted, marginTop: 2, marginBottom: 16 }}>
        Read from the office. Raise anything that looks wrong directly with them.
      </T>

      {!months ? null : !hasFigures ? (
        <Card style={{ paddingHorizontal: 16, paddingVertical: 32 }} padded={false}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
            Not matched to an employee record yet
          </T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
            The office holds your pay against your email or work number — ask them to check either
            is set correctly on your account.
          </T>
        </Card>
      ) : (
        months.map((m) => <SalaryCard key={m.period} m={m} />)
      )}
    </AppFrame>
  );
}

function SalaryCard({ m }: { m: SalaryMonth }) {
  return (
    <Card style={{ marginBottom: 10 }}>
      <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>{monthName(m.period)}</T>
      {m.employeeCode ? (
        <T s="caption" style={{ marginTop: 2 }}>
          {m.employeeCode}
          {m.employeeStatus ? ' · ' + m.employeeStatus : ''}
        </T>
      ) : null}

      <View style={{ marginTop: 14, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <T s="small" style={{ color: C.muted }}>Net salary</T>
        <T style={[{ fontSize: 22 }, weight(600), tabular]}>
          {m.netSalaryPaise != null ? inr(m.netSalaryPaise / 100) : '—'}
        </T>
      </View>

      <View style={{ marginTop: 10, gap: 6 }}>
        {m.conveyancePaise != null ? <Row label="Conveyance" value={inr(m.conveyancePaise / 100)} /> : null}
        {m.otherSalaryPaise != null ? <Row label="Other" value={inr(m.otherSalaryPaise / 100)} /> : null}
      </View>

      <View
        style={{
          marginTop: 12,
          paddingTop: 12,
          borderTopWidth: 1,
          borderTopColor: C.hairline,
          gap: 6,
        }}>
        <Row
          label="Days worked"
          value={m.daysWorked != null ? plural(m.daysWorked, 'day') : '—'}
        />
        {m.daysOnLeave ? <Row label="Days on leave" value={plural(m.daysOnLeave, 'day')} /> : null}
        {/* Beside the pay, never added to it — money owed back is not earnings. */}
        {m.reimbursedPaise ? (
          <Row label="Reimbursed separately" value={inr(m.reimbursedPaise / 100)} tone={C.success} />
        ) : null}
      </View>
    </Card>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <T s="small" style={{ color: C.muted }}>{label}</T>
      <T s="small" style={[{ color: tone ?? C.ink }, weight(500), tabular]}>{value}</T>
    </View>
  );
}
