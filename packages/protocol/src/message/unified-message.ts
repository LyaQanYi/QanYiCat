import type { UnifiedSegment } from './segments';

export type GroupRole = 'owner' | 'admin' | 'member';

export interface UnifiedSender {
  uid: string;
  uin: string;
  nickname?: string;
  card?: string;
  role?: GroupRole;
}

export type UnifiedPeer =
  | { type: 'user'; id: string }
  | { type: 'group'; id: string };

export interface UnifiedMessage {
  /** Stable internal ID (hash of msgSeq + msgRandom + sessionId). */
  id: string;
  scene: 'private' | 'group';
  selfId: string;
  sender: UnifiedSender;
  peer: UnifiedPeer;
  segments: UnifiedSegment[];
  timestamp: number;
  /** Original RawMessage retained for adapter-specific fields. */
  raw?: unknown;
}
