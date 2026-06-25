/**
 * OB11 wire action names → unified action names.
 *
 * OB12 uses unified names directly so no mapping is needed there. Keeping the
 * tables explicit (rather than computed) makes diffs against the OB11 spec
 * trivial to review.
 */
export const OB11_TO_UNIFIED: Readonly<Record<string, string>> = Object.freeze({
  send_msg: 'send_message',
  send_private_msg: 'send_message',
  send_group_msg: 'send_message',
  delete_msg: 'recall_message',
  get_msg: 'get_message',
  get_group_msg_history: 'get_history_messages',
  get_friend_msg_history: 'get_history_messages',
  add_friend: 'send_friend_request',
  send_friend_request: 'send_friend_request',

  get_group_info: 'get_group_info',
  get_group_member_list: 'get_group_members',
  set_group_ban: 'set_group_mute',
  set_group_kick: 'set_group_kick',

  get_stranger_info: 'get_user_info',
  get_friend_list: 'get_friend_list',

  send_forward_msg: 'send_forward_message',
  send_group_forward_msg: 'send_forward_message',
  send_private_forward_msg: 'send_forward_message',

  // v0.4n-α: media URL lookup. OB11 spec has type-specific names; all route
  // to the same unified action since NT's lookup is keyed on the file id.
  get_image: 'get_media_url',
  get_record: 'get_media_url',
  get_video: 'get_media_url',
  get_file: 'get_media_url',
});

export function ob11ToUnified(name: string): string {
  return OB11_TO_UNIFIED[name] ?? name;
}
