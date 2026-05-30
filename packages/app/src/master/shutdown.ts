export interface ShutdownHook {
  (): Promise<void> | void;
}

const hooks: ShutdownHook[] = [];

export function registerShutdownHook(fn: ShutdownHook): void {
  hooks.push(fn);
}

let installed = false;
export function installSignalHandlers(logger: { warn: (msg: string) => void } = { warn: console.warn }): void {
  if (installed) return;
  installed = true;
  let draining = false;
  const drain = async (signal: NodeJS.Signals): Promise<void> => {
    if (draining) return;
    draining = true;
    logger.warn(`[shutdown] received ${signal}, draining`);
    for (const fn of hooks.reverse()) {
      try {
        await fn();
      } catch (e) {
        logger.warn(`[shutdown] hook threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    process.exit(0);
  };
  process.on('SIGINT', drain);
  process.on('SIGTERM', drain);
}
