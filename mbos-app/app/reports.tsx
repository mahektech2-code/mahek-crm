import React from 'react';
import { AppFrame, BackLink, StubCard, useCameFrom } from '../src/components/shell/AppFrame';

/**
 * Not built yet, and it says so in the design's own words rather than showing
 * an empty chart — a screen that pretends to have numbers is worse than one
 * that admits it has none.
 */

export default function ReportsScreen() {
  const back = useCameFrom('more');

  return (
    <AppFrame title="Reports" activeTab={null} onBack={back.go} contentStyle={{ paddingHorizontal: 16, paddingVertical: 32 }}>
      <BackLink label={back.label} onPress={back.go} />
      <StubCard
        title="Reports"
        body="Your own numbers — visits, orders, collections and how the month is tracking."
      />
    </AppFrame>
  );
}
