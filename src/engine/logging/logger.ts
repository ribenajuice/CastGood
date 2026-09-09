import fs from 'node:fs';
import path from 'node:path';
import { LOGGING } from '../config.js';
import { type Clock, systemClock } from './clock.js';

/**
 * Structured JSONL logging — the architecture calls this "the eyes".
 *
 * The app runs on Windows; the session that has to understand what it did usually
 * runs in WSL. One line of JSON per event, appended to
 * `%LOCALAPPDATA%\CastGood\logs\engine-<date>.jsonl`, is how the two are connected:
 * `scripts/win-logs.sh` tails that file from WSL and a test can assert on it.
 *
 * Rules this file exists to guarantee:
 *  - one event per line, always parseable, even when a field is circular or a BigInt
 *  - a monotonic `mono` timestamp plus a process-wide `seq`, so events can be ordered
 *    exactly even when several land in the same millisecond or the wall clock jumps
 *  - logging never throws into the caller; a broken log must not break playback
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * The five keys the logger stamps onto every record itself.
 *
 * They are written **after** the caller's fields (see `emit`) so that a payload can never
 * rename the line it sits on — a key called `event` once made `session.state_changed`
 * disappear from the log entirely, taking the selftest's "where did it stop" diagnostic
 * with it.
 *
 * That protection has a second edge, and it drew blood on 2026-09-08: a payload key with
 * one of these names is **silently replaced**, not rejected. `session.volume_reported`
 * passed `level: next.level` and every record in the file read `"level":"info"` — the
 * severity — so M5a's volume level never reached the log at all, and the milestone's own
 * observability had a hole in exactly the number it is about. The build was green, the
 * field was present, and its value was wrong.
 */
type ReservedLogKey = 't' | 'mono' | 'seq' | 'level' | 'event';

/**
 * Caller-supplied log fields.
 *
 * The reserved names above are banned at the type level rather than merely documented,
 * because the failure they cause is invisible: the log still has the key, still parses, and
 * still reads plausibly. `volumeLevel`, `logLevel`, `eventKind` — any name that is not the
 * record's own identity is fine.
 */
export type LogFields = { [K in ReservedLogKey]?: never } & Record<string, unknown>;

export interface LogRecord extends Record<string, unknown> {
  /** ISO-8601 wall clock, for a human reading the file. */
  t: string;
  /** Monotonic milliseconds since engine start — use this for durations. */
  mono: number;
  /** Process-wide sequence number. Total ordering, even within one millisecond. */
  seq: number;
  level: LogLevel;
  /** Dotted event name, e.g. `session.state_changed`. Grep-friendly, stable over time. */
  event: string;
}

export interface Logger {
  /** Returns a logger that stamps every record with `bindings` (e.g. `{ component: 'cast' }`). */
  child(bindings: LogFields): Logger;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Resolves once everything written so far has reached the sink. */
  flush(): Promise<void>;
  /**
   * Flushes and releases the sink's handle. **The logger stays usable**: a later write
   * reopens it. See `LogSink.close`.
   */
  close(): Promise<void>;
}

export interface LogSink {
  write(line: string): void;
  flush(): Promise<void>;
  /**
   * Releases whatever the sink holds open, and leaves it ready to be used again.
   *
   * This is a `close`, never a `dispose`: an engine can be stopped and started again in
   * one process — the selftest's `reattach` scenario does exactly that — and the first
   * version of this ended the shared write stream permanently, so every line written by
   * the second engine hit `ERR_STREAM_WRITE_AFTER_END` and was swallowed by the
   * logger's own "never throw into the caller" guard. The restarted engine produced no
   * evidence at all, which is the one thing this project cannot afford.
   */
  close(): Promise<void>;
}

export interface LoggerOptions {
  sink: LogSink;
  level?: LogLevel;
  clock?: Clock;
  bindings?: LogFields;
}

let sequence = 0;

/** JSON that cannot throw: cycles, BigInts, Errors and undefined are all handled. */
export function serializeRecord(record: LogRecord): string {
  // Ancestors of the value being visited, not every object already seen: a global
  // seen-set reports the *second* copy of a repeated-but-acyclic reference as
  // "[circular]" and drops its contents. `{ devices: [device, device] }` is an
  // ordinary shape here, and losing the second one would be a confusing hole.
  const ancestors: unknown[] = [];
  try {
    return JSON.stringify(record, function (this: unknown, _key: string, value: unknown) {
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Error) {
        return { name: value.name, message: value.message, ...extractErrorExtras(value) };
      }
      if (typeof value === 'object' && value !== null) {
        // `this` is the object holding `value`; unwind back to it to leave only
        // the current path on the stack.
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
          ancestors.pop();
        }
        if (ancestors.includes(value)) return '[circular]';
        ancestors.push(value);
      }
      if (typeof value === 'function') return '[function]';
      return value;
    });
  } catch {
    return JSON.stringify({
      t: record.t,
      mono: record.mono,
      seq: record.seq,
      level: 'error',
      event: 'log.serialize_failed',
      originalEvent: record.event,
    });
  }
}

function extractErrorExtras(error: Error): LogFields {
  const extras: LogFields = {};
  const code = (error as { code?: unknown }).code;
  if (code !== undefined) extras['code'] = code;
  const context = (error as { context?: unknown }).context;
  if (context !== undefined) extras['context'] = context;
  return extras;
}

export function createLogger(options: LoggerOptions): Logger {
  const clock = options.clock ?? systemClock;
  const minRank = LEVEL_RANK[options.level ?? (LOGGING.defaultLevel as LogLevel)];
  const sink = options.sink;

  function build(bindings: LogFields): Logger {
    const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
      if (LEVEL_RANK[level] < minRank) return;
      const record: LogRecord = {
        ...bindings,
        ...fields,
        // The record's own identity is written last, so no caller can rename an event by
        // happening to use one of these words as a field. A payload key called `event`
        // silently renaming the line it is on made `session.state_changed` disappear from
        // the log entirely — and with it the selftest's "where did it stop" diagnostic.
        t: new Date(clock.wallMs()).toISOString(),
        mono: Math.round(clock.monoMs() * 1000) / 1000,
        seq: sequence++,
        level,
        event,
      };
      try {
        sink.write(serializeRecord(record));
      } catch {
        // A failed log must never take playback down with it.
      }
    };

    return {
      child: (extra) => build({ ...bindings, ...extra }),
      debug: (event, fields) => emit('debug', event, fields),
      info: (event, fields) => emit('info', event, fields),
      warn: (event, fields) => emit('warn', event, fields),
      error: (event, fields) => emit('error', event, fields),
      flush: () => sink.flush(),
      close: () => sink.close(),
    };
  }

  return build(options.bindings ?? {});
}

/**
 * Appends to `<dir>/engine-YYYY-MM-DD.jsonl`, creating the directory if needed.
 *
 * The stream is opened on the first write and reopened after `close()`, so a process that
 * runs two engines in succession writes both of their logs to the file rather than only
 * the first. Appending is the only mode used, so reopening can never truncate.
 */
export function createFileSink(dir: string, clock: Clock = systemClock): LogSink {
  fs.mkdirSync(dir, { recursive: true });
  let stream: fs.WriteStream | null = null;

  function open(): fs.WriteStream {
    const current = stream;
    if (current !== null) return current;
    // Resolved per open, not once per process: after a close the next line belongs in
    // whichever day's file is current now.
    const file = path.join(dir, `${LOGGING.filePrefix}-${dateStamp(clock.wallMs())}.jsonl`);
    const opened = fs.createWriteStream(file, { flags: 'a' });
    // Losing the log must not crash the app; the console is the fallback of last resort.
    opened.on('error', (error) => {
      process.stderr.write(`castgood: log sink error: ${String(error)}\n`);
    });
    stream = opened;
    return opened;
  }

  return {
    write(line: string) {
      open().write(line + '\n');
    },
    flush() {
      const current = stream;
      if (current === null) return Promise.resolve();
      // A zero-length write queues behind everything already buffered, so its
      // callback firing means the earlier lines have reached the file descriptor.
      return new Promise<void>((resolve) => current.write('', () => resolve()));
    },
    close() {
      const current = stream;
      // Dropped before the end() completes, so a write arriving during the drain opens a
      // fresh stream instead of landing on one that is already ending.
      stream = null;
      if (current === null) return Promise.resolve();
      return new Promise<void>((resolve) => current.end(() => resolve()));
    },
  };
}

/** Writes each line to a callback. Used by tests and by the dev-mode console mirror. */
export function createMemorySink(): LogSink & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(line: string) {
      lines.push(line);
    },
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

/** Fans one record out to several sinks (file + console in dev). */
export function combineSinks(...sinks: LogSink[]): LogSink {
  return {
    write(line) {
      for (const sink of sinks) sink.write(line);
    },
    async flush() {
      await Promise.all(sinks.map((s) => s.flush()));
    },
    async close() {
      await Promise.all(sinks.map((s) => s.close()));
    },
  };
}

export function createStreamSink(stream: NodeJS.WritableStream): LogSink {
  return {
    write: (line) => void stream.write(line + '\n'),
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

function dateStamp(wallMs: number): string {
  const d = new Date(wallMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
