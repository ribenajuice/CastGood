/**
 * Engine errors are structured, not stringly-typed.
 *
 * Two audiences, two fields:
 *  - `code` + `context` are for the log and for code that has to branch on failure.
 *  - `userMessage` is the only thing the UI is ever allowed to show. The PRD requires
 *    plain language and forbids raw paths, stack traces and protocol detail on screen.
 */

export type EngineErrorCode =
  | 'NOT_IMPLEMENTED'
  | 'INVALID_INTENT'
  | 'DEVICE_UNREACHABLE'
  | 'DEVICE_YIELDED'
  | 'LOAD_REJECTED'
  | 'SOURCE_MISSING'
  | 'PROBE_FAILED'
  | 'PREPARE_FAILED'
  | 'DISK_SPACE'
  | 'UNSUPPORTED_FILE'
  | 'MEDIA_SERVER_FAILED'
  | 'STORE_CORRUPT'
  | 'INTERNAL';

export interface EngineErrorOptions {
  /** Plain-language, founder-facing. Defaults to a generic line if omitted. */
  userMessage?: string;
  /** Structured detail for the log. Never rendered. */
  context?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}

const DEFAULT_USER_MESSAGE = 'Something went wrong. Try again.';

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly userMessage: string;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(code: EngineErrorCode, message: string, options: EngineErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'EngineError';
    this.code = code;
    this.userMessage = options.userMessage ?? DEFAULT_USER_MESSAGE;
    this.context = options.context ?? {};
  }
}

export function isEngineError(value: unknown): value is EngineError {
  return value instanceof EngineError;
}

/**
 * Marks a scaffolded seam that a later milestone fills in. Throwing (rather than
 * returning a fake) keeps "not built yet" from ever masquerading as "working".
 */
export function notImplemented(what: string, milestone: 'M1' | 'M2' | 'M3' = 'M1'): never {
  throw new EngineError('NOT_IMPLEMENTED', `${what} is not implemented yet (${milestone})`, {
    userMessage: 'That part of CastGood is not built yet.',
    context: { what, milestone },
  });
}
