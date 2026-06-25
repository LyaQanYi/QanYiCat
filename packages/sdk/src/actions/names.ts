export const Actions = {
  SendMessage: 'send_message',
  RecallMessage: 'recall_message',
  GetMessage: 'get_message',
  GetGroupInfo: 'get_group_info',
  GetGroupList: 'get_group_list',
  GetGroupMembers: 'get_group_members',
  SetGroupMute: 'set_group_mute',
  SetGroupKick: 'set_group_kick',
  GetUserInfo: 'get_user_info',
  GetFriendList: 'get_friend_list',
  GetLoginInfo: 'get_login_info',
  GetStatus: 'get_status',
  GetVersionInfo: 'get_version_info',
  UploadFile: 'upload_file',
  DownloadFile: 'download_file',
} as const;

export type ActionName = (typeof Actions)[keyof typeof Actions];
