/**
 * NT Kernel message element shapes — mirror the wrapper.node payloads.
 *
 * The numeric `elementType` values match NTQQ's internal enum (observed from
 * live wrapper.node payloads as of v0.0.1). Keep this file as the single source
 * of truth; consumers in @qanyicat/protocol switch on `elementType` to normalize.
 */

export enum NTElementType {
  UNKNOWN = 0,
  TEXT = 1,
  PIC = 2,
  FILE = 3,
  PTT = 4,
  VIDEO = 5,
  FACE = 6,
  REPLY = 7,
  GREY_TIP = 8,
  WALLET = 9,
  ARK = 10,
  MFACE = 11,
  MARKDOWN = 14,
  GIPHY = 15,
  MULTI_FORWARD = 16,
  INLINE_KEYBOARD = 17,
}

export interface NTTextElementData {
  content: string;
  /** 0 = plain text, 1 = @user, 2 = @all */
  atType?: 0 | 1 | 2;
  atUid?: string;
  atNtUid?: string;
}

export interface NTPicElementData {
  md5HexStr?: string;
  filePath?: string;
  fileSize?: number | string;
  picWidth?: number;
  picHeight?: number;
  fileName?: string;
  sourcePath?: string;
  picType?: number;
  picSubType?: number;
  summary?: string;
  /** Remote download URL when known; absent for outbound pre-upload. */
  originImageUrl?: string;
  fileUuid?: string;
  fileSubId?: string;
}

export interface NTFaceElementData {
  faceIndex: number;
  faceType: number;
  pokeType?: number;
  stickerId?: string;
}

export interface NTReplyElementData {
  replayMsgSeq: string;
  replayMsgId: string;
  senderUin?: string;
  senderUidStr?: string;
  replyMsgTime?: string;
}

export interface NTFileElementData {
  fileMd5?: string;
  fileName: string;
  filePath?: string;
  fileSize?: number | string;
  fileUuid?: string;
  fileSubId?: string;
}

export interface NTPttElementData {
  fileName: string;
  filePath?: string;
  md5HexStr?: string;
  fileSize?: number | string;
  duration?: number;
  /** 1 = SILK (the only format NT documents). */
  formatType?: number;
  /** 1 = normal voice (vs e.g. voice-changer overlays). */
  voiceType?: number;
  /** 0 = no voice-changer effect. */
  voiceChangeType?: number;
  /** True enables NT's auto speech-to-text on the recipient side. */
  canConvert2Text?: boolean;
  /** Waveform thumbnail. NT lets clients render a static one; we send a 15-bin constant. */
  waveAmplitudes?: number[];
  fileSubId?: string;
  playState?: number;
  autoConvertText?: number;
  storeID?: number;
  otherBusinessInfo?: { aiVoiceType?: number } & Record<string, unknown>;
  fileUuid?: string;
}

export interface NTVideoElementData {
  fileName: string;
  filePath?: string;
  videoMd5?: string;
  thumbMd5?: string;
  fileSize?: number | string;
  thumbWidth?: number;
  thumbHeight?: number;
  /** Thumbnail file size in bytes. */
  thumbSize?: number;
  /** Map keyed by angle (NT uses 0 for the default thumb). */
  thumbPath?: Map<number, string>;
  /** Video duration in seconds. */
  fileTime?: number;
  fileUuid?: string;
}

export interface NTMarkdownElementData {
  content: string;
}

export interface NTMultiForwardElementData {
  resId: string;
  fileName?: string;
}

/**
 * Generic JSON-payload element. Used by QQ for the multi-msg forward card
 * (`app: 'com.tencent.multimsg'`), share cards, mini-program cards, etc.
 * `bytesData` is a JSON string; multi-forward carries `meta.detail.resid`
 * — the resource id needed to fetch the chain via `getMultiMsg`.
 */
export interface NTArkElementData {
  bytesData: string;
  linkInfo?: unknown;
  xmlBytes?: unknown;
}

export type NTElement =
  | { elementType: NTElementType.TEXT; elementId?: string; textElement: NTTextElementData }
  | { elementType: NTElementType.PIC; elementId?: string; picElement: NTPicElementData }
  | { elementType: NTElementType.FACE; elementId?: string; faceElement: NTFaceElementData }
  | { elementType: NTElementType.REPLY; elementId?: string; replyElement: NTReplyElementData }
  | { elementType: NTElementType.FILE; elementId?: string; fileElement: NTFileElementData }
  | { elementType: NTElementType.PTT; elementId?: string; pttElement: NTPttElementData }
  | { elementType: NTElementType.VIDEO; elementId?: string; videoElement: NTVideoElementData }
  | { elementType: NTElementType.MARKDOWN; elementId?: string; markdownElement: NTMarkdownElementData }
  | { elementType: NTElementType.MULTI_FORWARD; elementId?: string; multiForwardMsgElement: NTMultiForwardElementData }
  | { elementType: NTElementType.ARK; elementId?: string; arkElement: NTArkElementData }
  | { elementType: Exclude<NTElementType, KnownElementType>; elementId?: string };

type KnownElementType =
  | NTElementType.TEXT
  | NTElementType.PIC
  | NTElementType.FACE
  | NTElementType.REPLY
  | NTElementType.FILE
  | NTElementType.PTT
  | NTElementType.VIDEO
  | NTElementType.MARKDOWN
  | NTElementType.MULTI_FORWARD
  | NTElementType.ARK;
