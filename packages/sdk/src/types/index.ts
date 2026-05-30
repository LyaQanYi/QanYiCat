/**
 * Public SDK types — mirror @qanyicat/protocol but standalone so the SDK can
 * be published without pulling internal packages along.
 */
export interface SdkPeer {
  type: 'user' | 'group';
  id: string;
}

export interface SdkSender {
  uid: string;
  uin: string;
  nickname?: string;
  card?: string;
  role?: 'owner' | 'admin' | 'member';
}

export type SdkSegment =
  | { type: 'text'; data: { text: string } }
  | { type: 'at'; data: { uid: string; uin?: string } }
  | { type: 'face'; data: { id: number } }
  | { type: 'image'; data: { file: string; url?: string } }
  | { type: 'reply'; data: { id: string } }
  | { type: string; data: Record<string, unknown> };

export interface SdkMessage {
  id: string;
  scene: 'private' | 'group';
  selfId: string;
  sender: SdkSender;
  peer: SdkPeer;
  segments: SdkSegment[];
  timestamp: number;
}

export type SdkEvent =
  | { kind: 'message'; message: SdkMessage }
  | { kind: 'notice'; sub: string; [k: string]: unknown }
  | { kind: 'request'; sub: string; [k: string]: unknown }
  | { kind: 'meta'; sub: string; [k: string]: unknown };

export interface SdkEventMap {
  message: { message: SdkMessage };
  notice: { sub: string; [k: string]: unknown };
  request: { sub: string; [k: string]: unknown };
  meta: { sub: string; [k: string]: unknown };
}

export interface Disposable {
  dispose(): void;
}
