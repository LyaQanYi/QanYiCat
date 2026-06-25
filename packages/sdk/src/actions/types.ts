import type { SdkPeer, SdkSegment } from '../types/index.js';
import type { Actions } from './names.js';

export interface ActionParamMap {
  [Actions.SendMessage]: { peer: SdkPeer; segments: SdkSegment[] };
  [Actions.RecallMessage]: { messageId: string };
  [Actions.GetMessage]: { messageId: string };
  [Actions.GetGroupInfo]: { groupId: string };
  [Actions.GetGroupList]: Record<string, never>;
  [Actions.GetGroupMembers]: { groupId: string };
  [Actions.SetGroupMute]: { groupId: string; userId: string; durationSec: number };
  [Actions.SetGroupKick]: { groupId: string; userId: string; rejectAddRequest: boolean };
  [Actions.GetUserInfo]: { userId: string };
  [Actions.GetFriendList]: Record<string, never>;
  [Actions.GetLoginInfo]: Record<string, never>;
  [Actions.GetStatus]: Record<string, never>;
  [Actions.GetVersionInfo]: Record<string, never>;
  [Actions.UploadFile]: { peer: SdkPeer; filePath: string };
  [Actions.DownloadFile]: { peer: SdkPeer; messageId: string; fileId: string };
}

export interface ActionResultMap {
  [Actions.SendMessage]: { messageId: string };
  [Actions.RecallMessage]: void;
  [Actions.GetMessage]: unknown;
  [Actions.GetGroupInfo]: unknown;
  [Actions.GetGroupList]: unknown[];
  [Actions.GetGroupMembers]: unknown[];
  [Actions.SetGroupMute]: void;
  [Actions.SetGroupKick]: void;
  [Actions.GetUserInfo]: unknown;
  [Actions.GetFriendList]: unknown[];
  [Actions.GetLoginInfo]: { user_id: number; nickname: string };
  [Actions.GetStatus]: { online: boolean; good: boolean };
  [Actions.GetVersionInfo]: { app_name: string; app_version: string; protocol_version: string; qq_version: string };
  [Actions.UploadFile]: { fileId: string };
  [Actions.DownloadFile]: { localPath: string };
}

export type ParamOf<K extends keyof ActionParamMap> = ActionParamMap[K];
export type ResultOf<K extends keyof ActionResultMap> = ActionResultMap[K];
