import type { NTEventBus } from '../event/nt-event-bus';

export interface GroupListenerHandle {
  detach(): void;
}

export function registerGroupListener(bus: NTEventBus): GroupListenerHandle {
  void bus;
  // TODO(v0.1)
  return { detach() {} };
}
