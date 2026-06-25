export class QanYiCatError extends Error {
  constructor(message: string, public readonly code?: number) {
    super(message);
    this.name = 'QanYiCatError';
  }
}

export class ActionFailedError extends QanYiCatError {
  constructor(public readonly action: string, code: number, message: string) {
    super(`[${action}] retcode=${code}: ${message}`, code);
    this.name = 'ActionFailedError';
  }
}

export class TransportClosedError extends QanYiCatError {
  constructor(message = 'transport closed') {
    super(message);
    this.name = 'TransportClosedError';
  }
}
