import React from 'react';
import { View } from 'react-native';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, T } from '../src/components/ui/primitives';
import { color as C, radius, weight, tabular } from '../src/theme/tokens';
import { PERFORMANCE } from '../src/data/fixtures';

/**
 * Performance — four figures, and where each of them sits against the team.
 *
 * The team marker is a line rather than a second bar on purpose: the question
 * is not what the team did, it is which side of them he is on, and a 2px rule
 * across the track answers that without being read as a target.
 */


export default function PerformanceScreen() {
  const back = useCameFrom('more');

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Performance</T>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        {PERFORMANCE.rankLine}
      </T>

      <Card padded={false} style={{ marginTop: 12, flexDirection: 'row', flexWrap: 'wrap', overflow: 'hidden' }}>
        {PERFORMANCE.cards.map((x) => (
          <View
            key={x.l}
            style={{ width: '50%', minWidth: 0, padding: 14, borderTopWidth: 1, borderTopColor: C.wash }}>
            <T s="label">{x.l}</T>
            <T
              style={[
                {
                  fontSize: 22,
                  lineHeight: 28,
                  marginVertical: 2,
                  color: x.tone === 'amber' ? C.warnInk : x.tone === 'good' ? C.success : C.ink,
                },
                weight(600),
                tabular,
              ]}>
              {x.v}
            </T>
            <T s="micro">{x.s}</T>
          </View>
        ))}
      </Card>

      <Card style={{ marginTop: 12 }}>
        <T s="label">You against the team</T>
        {PERFORMANCE.bars.map((b) => (
          <View key={b.l} style={{ marginTop: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
              <T style={{ fontSize: 14, lineHeight: 20, color: C.ink }}>{b.l}</T>
              <T s="caption" style={tabular}>
                {b.me + '% · team ' + b.team + '%'}
              </T>
            </View>
            <View
              style={{
                position: 'relative',
                height: 8,
                borderRadius: 4,
                backgroundColor: C.hairline,
                marginTop: 6,
              }}>
              <View
                style={{
                  width: `${Math.min(100, b.me)}%`,
                  height: '100%',
                  borderRadius: 4,
                  backgroundColor: b.me >= b.team ? C.success : C.warn,
                }}
              />
              <View
                style={{
                  position: 'absolute',
                  left: `${Math.min(100, b.team)}%`,
                  top: -3,
                  width: 2,
                  height: 14,
                  backgroundColor: C.ink,
                }}
              />
            </View>
          </View>
        ))}
      </Card>

      <View
        style={{
          backgroundColor: C.warnBg,
          borderWidth: 1,
          borderColor: C.warnEdge,
          borderRadius: radius.card,
          paddingHorizontal: 16,
          paddingVertical: 14,
          marginTop: 12,
        }}>
        <T style={{ fontSize: 14, lineHeight: 20, color: C.warnInk }}>{PERFORMANCE.weakest}</T>
      </View>
      <T s="caption" style={{ marginTop: 12 }}>These figures are not live yet.</T>
    </AppFrame>
  );
}
