/**
 * The protocol-neutral message segment union. Both OB11 and OB12 converters
 * map *into* this type; nothing else in the system speaks the raw NT elements.
 */
export type UnifiedSegment =
  | { type: 'text'; data: { text: string } }
  | { type: 'at'; data: { uid: string; uin?: string; name?: string } }
  | { type: 'face'; data: { id: number } }
  | { type: 'image'; data: { file: string; url?: string; sub?: number; summary?: string } }
  | { type: 'voice'; data: { file: string; url?: string; duration?: number } }
  | { type: 'video'; data: { file: string; url?: string } }
  | { type: 'file'; data: { file: string; url?: string; size?: number; name?: string } }
  | { type: 'reply'; data: { id: string } }
  | { type: 'forward'; data: { id: string } }
  | { type: 'json'; data: { data: string } }
  | { type: 'xml'; data: { data: string } }
  | { type: 'markdown'; data: { content: string } };

export type UnifiedSegmentType = UnifiedSegment['type'];

/**
 * One entry in a forward-message chain. Either a *reference* to an
 * already-observed message (the wire client echoes back a message_id we
 * emitted), or a *custom* node carrying its own segments. v0.4m-α only
 * implements the reference form; custom-content forwarding needs Packet-layer
 * reverse engineering (deferred to v0.4m-β).
 */
export type UnifiedForwardNode =
  | { messageId: string }
  | { userId: string; nickname: string; segments: UnifiedSegment[]; time?: number };
