import React from 'react';
import { View } from 'react-native';

import { BottomSheet } from './ui/overlays';
import { Input, T } from './ui/primitives';
import { PillButton } from './ui/v3';
import { hhmm } from '../lib/format';
import type { OrderDuplicate } from '../sync/api';
import { color as C, weight } from '../theme/tokens';

/**
 * "ALREADY PUNCHED TODAY?" - the sheet a new order opens when the office
 * already holds a TO for the same billing and delivery party, the same day
 * and the same items. Asked only with signal, before anything is sent.
 *
 * "Same order - don't create" is the primary answer: nothing is sent, and
 * whoever punched the first one is told. "Different order - create it" needs
 * a reason, which the TO carries for Accounts. Closing the sheet is neither:
 * the order stays on the screen, unsent.
 */
export function DuplicateSheet({
  found,
  busy,
  onSame,
  onDifferent,
  onClose,
}: {
  found: OrderDuplicate | null;
  busy: boolean;
  onSame: () => void;
  onDifferent: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = React.useState('');
  const [tried, setTried] = React.useState(false);
  const m = found?.match;
  const missing = !reason.trim();
  return (
    <BottomSheet open={!!found} onClose={busy ? () => undefined : onClose}>
      {m ? (
        <View style={{ gap: 12 }}>
          <T style={[{ fontSize: 18, lineHeight: 24, color: C.ink }, weight(700)]}>Already punched today?</T>
          <T style={{ fontSize: 14, lineHeight: 21, color: C.body }}>
            <T style={[{ fontSize: 14, lineHeight: 21, color: C.ink }, weight(700)]}>{'TO-' + m.toNo}</T>
            {' by ' + (m.takenBy ?? 'someone') + ' at ' + hhmm(Date.parse(m.takenAt)) + ' has the same billing and delivery party and the same items.'}
          </T>
          <View style={{ borderWidth: 1, borderColor: C.border, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: C.canvas }}>
            {m.lines.map((l) => (
              <T key={l.skuId} style={{ fontSize: 13.5, lineHeight: 22, color: C.ink }}>
                {l.name + ' × ' + l.qtyCans}
              </T>
            ))}
          </View>
          <T style={[{ fontSize: 12.5, lineHeight: 17, color: C.muted }, weight(500)]}>If it is a different order, say why</T>
          <Input
            value={reason}
            onChangeText={(v) => setReason(v.slice(0, 300))}
            placeholder="Reason"
            invalid={tried && missing}
            accessibilityLabel="If it is a different order, say why"
          />
          {tried && missing ? <T style={{ fontSize: 13, lineHeight: 18, color: C.danger }}>Say why it is a different order</T> : null}
          <PillButton label="Same order - don't create" variant="navy" height={52} disabled={busy} onPress={onSame} />
          <PillButton
            label="Different order - create it"
            variant="outline"
            height={52}
            disabled={busy}
            onPress={() => {
              setTried(true);
              if (!missing) onDifferent(reason.trim());
            }}
          />
          <T style={{ fontSize: 12.5, lineHeight: 18, color: C.muted }}>
            No signal? The order is sent anyway and checked when it syncs. If it looks like a duplicate, Accounts see it marked &quot;Possible duplicate&quot;.
          </T>
        </View>
      ) : null}
    </BottomSheet>
  );
}
