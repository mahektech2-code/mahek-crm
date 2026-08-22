import React from 'react';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, T } from '../src/components/ui/primitives';
import { color as C, weight } from '../src/theme/tokens';

/**
 * Salary — and there is no salary on this handset.
 *
 * This screen used to render a payslip: four months of net pay, basic, travel,
 * incentive at a percentage of target, advance recovered, PF, and a slab table
 * saying what the next fortnight was worth. Every figure was invented, and the
 * only thing saying so was a grey caption at the very bottom, below the fold.
 * A payslip is the one screen in this app where a wrong number is least
 * forgivable — somebody plans around it — so a plausible invented one is worse
 * than nothing at all.
 *
 * Two of the buttons were the same lie in a different form: "Download payslip"
 * and "Send to payroll" both only raised a toast. Nothing was written, nothing
 * was queued, and payroll never heard a word of it.
 *
 * HR maintains the salary columns in the employee workbook and HRMS mirrors
 * them, so the figures exist — but no pull channel carries them to the handset
 * and none is specified. When one is, this screen reads it like every other
 * screen reads its own data, and this comment goes with the placeholder.
 */

export default function SalaryScreen() {
  const back = useCameFrom('more');

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Salary</T>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        Your payslip comes from the office.
      </T>

      <Card style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 32 }} padded={false}>
        <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>Not available on the phone yet</T>
        <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
          Payroll does not send payslips to MBOS. Ask the office for yours, and
          raise anything that looks wrong with them directly.
        </T>
      </Card>
    </AppFrame>
  );
}
