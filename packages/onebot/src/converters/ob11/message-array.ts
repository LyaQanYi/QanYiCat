import type { UnifiedSegment } from '@qanyicat/protocol';
import { segmentsToArray, type WireMessageSegment } from '../shared';

/** OB11 array mode is identical to the unified shape — keep the indirection
 * so we can branch on quirks (e.g. OB11-specific image cache flags) later. */
export function segmentsToOb11Array(segments: UnifiedSegment[]): WireMessageSegment[] {
  return segmentsToArray(segments);
}

export function ob11ArrayToSegments(_arr: WireMessageSegment[]): UnifiedSegment[] {
  // TODO(v0.1)
  return [];
}
