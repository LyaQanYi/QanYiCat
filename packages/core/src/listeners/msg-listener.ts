import type { NTEventBus } from '../event/nt-event-bus';

/**
 * Wraps NodeIKernelMsgListener. The wrapper.node listener interface expects
 * an object with sync callbacks; we forward each callback onto the typed bus.
 */
export interface MsgListenerHandle {
  detach(): void;
}

export function registerMsgListener(bus: NTEventBus): MsgListenerHandle {
  void bus;
  // TODO(v0.1): build the NodeIKernelMsgListener proxy and register on
  // session.getMsgService().addKernelMsgListener(...).
  return { detach() {} };
}
