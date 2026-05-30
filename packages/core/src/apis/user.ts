export interface NTUserProfile {
  uid: string;
  uin: string;
  nick: string;
  avatar?: string;
  sex?: 'male' | 'female' | 'unknown';
  age?: number;
  remark?: string;
}

export interface NTUserApi {
  getProfile(uid: string): Promise<NTUserProfile>;
  getSelfInfo(): Promise<NTUserProfile>;
  uinToUid(uin: string): Promise<string | null>;
  uidToUin(uid: string): Promise<string | null>;
}
