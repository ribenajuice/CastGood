import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { currentRun, redact, type RedactionSubjects } from './redact.js';

/**
 * Writing the file a person actually hands over — story 25, criteria 25b, 25c, 25f and 25g.
 *
 * **CastGood sends nothing.** This produces a file and stops. The person is the transport,
 * and `test/architecture/no-telemetry.test.ts` is what keeps that true when somebody
 * reasonably suggests uploading it.
 */

/** 25c. Enough for any single failure; small enough to attach to a message. */
export const EXPORT_LINE_CAP = 2_000;

export interface ExportRequest {
  /** Where the engine writes its own JSONL. Read-only to this function — see 25g. */
  readonly logDir: string;
  /** Where the export goes. **Never inside `logDir`** (25g). */
  readonly destinationDir: string;
  readonly subjects: RedactionSubjects;
  /** Injected so a test can fix the name. */
  readonly now?: Date;
}

export type ExportOutcome =
  | {
      readonly kind: 'written';
      readonly filePath: string;
      readonly lines: number;
      readonly bytes: number;
    }
  /**
   * 25f. **Not an empty file.** A person handed an empty file will send it, and it will be
   * read as "nothing happened" rather than "there was nothing to send".
   */
  | { readonly kind: 'nothing-to-send'; readonly why: string };

/** Newest `engine-*.jsonl`, or null. */
async function newestLog(logDir: string): Promise<string | null> {
  const names = (await readdir(logDir).catch(() => []))
    .filter((n) => n.startsWith('engine-') && n.endsWith('.jsonl'))
    .sort();
  const newest = names.at(-1);
  return newest === undefined ? null : path.join(logDir, newest);
}

/**
 * Read this run out of the log, redact it, and write it somewhere the person can find.
 *
 * ⚠️ **The engine's own log is opened read-only and never rotated, trimmed or deleted**
 * (25g). Exporting evidence must not disturb the evidence — and the export is written
 * *outside* `logDir` so it can never be picked up as a log on the next run.
 */
export async function exportDiagnostics(request: ExportRequest): Promise<ExportOutcome> {
  const source = await newestLog(request.logDir);
  if (source === null) {
    return {
      kind: 'nothing-to-send',
      why: 'CastGood has not written a log yet, so there is nothing to send.',
    };
  }

  const raw = await readFile(source, 'utf8').catch(() => '');
  const lines = currentRun(raw.split('\n'), EXPORT_LINE_CAP);
  if (lines.length === 0) {
    return {
      kind: 'nothing-to-send',
      why: 'This run has not written anything to the log yet, so there is nothing to send.',
    };
  }

  const { text, counts } = redact(lines.join('\n'), request.subjects);

  // A header the receiver reads first, and the sender can read before sending. It says what
  // was taken out, which is 25i's sentence surviving into the file itself rather than living
  // only on a screen nobody will screenshot.
  const stamp = (request.now ?? new Date()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const header = [
    'CastGood diagnostic export',
    `written ${(request.now ?? new Date()).toISOString()}`,
    '',
    'Names have been removed and replaced with placeholders that stay the same throughout,',
    'so <film-1> is the same film everywhere it appears. Removed from this file:',
    `  ${String(counts.user)} Windows username, ${String(counts.film)} film name(s),`,
    `  ${String(counts.device)} television name(s), ${String(counts.id)} device identifier(s),`,
    `  ${String(counts.ip)} network address(es).`,
    '',
    'CastGood did not send this anywhere. It has no way to.',
    '',
  ].join('\n');

  await mkdir(request.destinationDir, { recursive: true });
  const filePath = path.join(request.destinationDir, `castgood-report-${stamp}.txt`);
  const body = `${header}${text}\n`;
  await writeFile(filePath, body, 'utf8');

  return {
    kind: 'written',
    filePath,
    lines: lines.length,
    bytes: Buffer.byteLength(body),
  };
}
