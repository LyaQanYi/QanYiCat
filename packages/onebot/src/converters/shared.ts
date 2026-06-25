import type { UnifiedSegment } from '@qanyicat/protocol';

export interface WireMessageSegment {
  type: string;
  data: Record<string, unknown>;
}

/** Plain pass-through serializer; OB11 and OB12 reuse this for array mode. */
export function segmentsToArray(segments: UnifiedSegment[]): WireMessageSegment[] {
  return segments.map((s) => ({ type: s.type, data: { ...s.data } as Record<string, unknown> }));
}
