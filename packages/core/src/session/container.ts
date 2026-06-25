import { Container } from 'inversify';

/**
 * Per-instance IoC container. Each {@link InstanceContext} owns one — we keep
 * a factory so the bootstrap routine can register bindings before resolving.
 */
export function createCoreContainer(): Container {
  return new Container({ defaultScope: 'Singleton' });
}

/** Symbols for the public bindings core exposes. */
export const CoreTokens = {
  Session: Symbol.for('qanyicat.core.Session'),
  Logger: Symbol.for('qanyicat.core.Logger'),
  EventBus: Symbol.for('qanyicat.core.EventBus'),
  Apis: Symbol.for('qanyicat.core.Apis'),
  Config: Symbol.for('qanyicat.core.Config'),
} as const;
