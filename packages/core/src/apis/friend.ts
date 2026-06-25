export interface NTFriendEntry {
  uid: string;
  uin: string;
  nick: string;
  remark?: string;
  category?: string;
}

export interface ProbeAttempt {
  /** Short label, e.g. "buddyService.reqToAddFriends({friendUid,...})". */
  call: string;
  /** "ok" if the call returned without throwing; "throw" if it threw. */
  outcome: 'ok' | 'throw';
  /** Stringified result or error message. */
  detail: string;
  /** Result of the call when outcome === 'ok' (best-effort JSON-safe). */
  result?: unknown;
}

export interface ProbeReport {
  /** Whether buddyService / addBuddyService are reachable on this session. */
  services: { buddyService: boolean; addBuddyService: boolean };
  /** Methods enumerable on addBuddyService (best-effort introspection). */
  addBuddyMethods: string[];
  /** Attempts tried, in order. The smoke loop picks the first 'ok' or stops. */
  attempts: ProbeAttempt[];
}

export interface NTFriendApi {
  list(): Promise<NTFriendEntry[]>;
  /**
   * v0.4o: accept / reject an incoming friend-add request (`request/friend`).
   * `flag` is the opaque token emitted on the wire — bridge encodes the NT
   * `friendUid + reqTime` pair needed to call `buddyService.approvalFriendRequest`.
   * `remark` is ignored (NT's approvalFriendRequest has no remark slot — use
   *  setFriendRemark separately after acceptance).
   */
  handleRequest(flag: string, accept: boolean, remark?: string): Promise<void>;
  deleteFriend(uid: string): Promise<void>;
  /** v0.4j-β-1 send path: ask NT to send a friend-add request to a peer. */
  sendRequest(peer: { uid?: string; uin?: string }, comment?: string): Promise<void>;
  /**
   * v0.4k: experimental probe. Tries several call shapes against
   * buddyService.reqToAddFriends + addBuddyService.{requestInfoByAccount,addBuddy}
   * and returns a transcript so we can reverse-engineer NT 9.9's true call
   * signature. Safe to call repeatedly — each attempt is wrapped in try/catch.
   */
  sendRequestProbe?(peer: { uid?: string; uin?: string }, comment?: string): Promise<ProbeReport>;
}
