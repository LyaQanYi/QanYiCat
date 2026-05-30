import type { NTEventBus } from '../event/nt-event-bus';

export interface LoginListenerHandle {
  detach(): void;
}

export function registerLoginListener(bus: NTEventBus): LoginListenerHandle {
  void bus;
  // TODO(v0.1)
  return { detach() {} };
}
