export interface NTGroupInfo {
  groupCode: string;
  groupName: string;
  memberCount: number;
  maxMember: number;
  owner: string;
}

export interface NTGroupMember {
  uid: string;
  uin: string;
  nick: string;
  card?: string;
  role: 'owner' | 'admin' | 'member';
}

export interface NTGroupApi {
  list(): Promise<NTGroupInfo[]>;
  info(groupCode: string): Promise<NTGroupInfo>;
  members(groupCode: string): Promise<NTGroupMember[]>;
  kick(groupCode: string, uid: string, rejectAddRequest: boolean): Promise<void>;
  mute(groupCode: string, uid: string, durationSec: number): Promise<void>;
  muteAll(groupCode: string, enable: boolean): Promise<void>;
  setCard(groupCode: string, uid: string, card: string): Promise<void>;
  setAdmin(groupCode: string, uid: string, isAdmin: boolean): Promise<void>;
  /**
   * v0.4o: accept / reject an incoming group join request (`request/group`).
   * `flag` is the opaque token emitted on the wire — bridge encodes the NT
   * `seq + type + groupCode + doubt` tuple needed to call `operateSysNotify`.
   */
  handleJoinRequest?(flag: string, accept: boolean, reason?: string): Promise<void>;
}
