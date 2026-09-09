/**
 * Turning one run of the engine log into something a person can hand over — story 25.
 *
 * ⚠️ **A log is personal, and that fact designs this file.** One real 4 MB log measured on
 * 2026-09-09 held the Windows username **249 times**, 79 absolute file paths, 9 film names,
 * 3 television names and 11 addresses across 15,546 lines. *"Send me your log"* therefore
 * means *"send me your username, your home network, your television names and what you have
 * been watching."*
 *
 * **The founder's ruling (question 45, 2026-09-09) is to redact all of it**, overruling the
 * recommendation, which was to redact only the username on the grounds that a film name is
 * sometimes the bug. **The cost of that ruling is real and is bought back here rather than
 * absorbed** — see `stable placeholders` below.
 *
 * ## The one thing that would make this useless while looking correct
 *
 * **Placeholders are per-VALUE, not per-occurrence.** The same film is `<film-1>` every time
 * it appears; a different film is `<film-2>`. A log where every film is `<film>` cannot say
 * *"the same film failed twice"* or *"device-2 is the one that dropped"* — and those
 * sentences are frequently the whole diagnosis.
 *
 * An implementation that numbered each occurrence would produce a file that looks redacted,
 * passes a careless test, and explains nothing. Criterion 25e exists to fail it.
 *
 * **Extensions survive** — `<film-1>.mkv` — because a container is often the fault and
 * `.mkv` identifies nobody.
 */

/** The kinds of thing a log gives away, each with its own counter. */
type Kind = 'user' | 'film' | 'device' | 'id' | 'ip';

export interface RedactionReport {
  readonly text: string;
  /** How many distinct values of each kind were replaced. */
  readonly counts: Readonly<Record<Kind, number>>;
}

/** Everything this needs to know about the machine it is redacting for. */
export interface RedactionSubjects {
  /** The Windows account name. It appears inside paths far more often than in fields. */
  readonly username: string | null;
  /** Friendly names of every television seen — from discovery, not guessed. */
  readonly deviceNames: readonly string[];
  /** File names of every film seen. Extensions are kept; the stem is replaced. */
  readonly fileNames: readonly string[];
}

/** `.` plus the extension, or empty. Kept so a container can still be seen. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot > name.lastIndexOf('/') && dot > name.lastIndexOf('\\')
    ? name.slice(dot)
    : '';
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * An IPv4 address, but **not** a version number and **not** a loopback.
 *
 * `127.0.0.1` is not a household detail and removing it removes the ability to tell a local
 * media server from a television. Four-part dotted numbers that are really versions are rare
 * in this log, but the boundary anchors keep `1.2.3.4` inside a longer token intact.
 */
const IPV4 = /\b(?!127\.0\.0\.1\b)((?:\d{1,3}\.){3}\d{1,3})\b/g;

/**
 * Dotted quads that are **not addresses** and must survive.
 *
 * ⚠️ Found by reading a real export rather than by a test: every `netmask` was being turned
 * into `<ip-4>`. A netmask identifies nobody, and replacing it **loses** the size of the
 * subnet — which is exactly the sort of thing a network bug turns on — while spending
 * placeholder numbers on values that carry no meaning. Redacting something harmless is not
 * free: it makes the report worse without making it safer.
 */
const NOT_AN_ADDRESS = new Set([
  '255.255.255.255',
  '255.255.255.0',
  '255.255.0.0',
  '255.0.0.0',
  '0.0.0.0',
]);

/** A television's stable id. Not personal, but a persistent fingerprint of somebody's hardware. */
const DEVICE_ID = /\b[0-9a-f]{32}\b/g;

/**
 * Replace every identifying value with a stable numbered placeholder.
 *
 * Order matters: **the username goes last**. It is a substring of nearly every file path, so
 * replacing it first would corrupt the film names this still has to find.
 */
export function redact(text: string, subjects: RedactionSubjects): RedactionReport {
  const seen: Record<Kind, Map<string, string>> = {
    user: new Map(),
    film: new Map(),
    device: new Map(),
    id: new Map(),
    ip: new Map(),
  };

  /** The placeholder for a value, minted once and reused for every later occurrence. */
  const placeholder = (kind: Kind, value: string, suffix = ''): string => {
    const existing = seen[kind].get(value);
    if (existing !== undefined) return existing;
    const minted = `<${kind}-${String(seen[kind].size + 1)}>${suffix}`;
    seen[kind].set(value, minted);
    return minted;
  };

  let out = text;

  // Longest first: a film called "Cars 2.mp4" must not be half-replaced by "Cars.mp4".
  for (const name of [...subjects.fileNames].sort((a, b) => b.length - a.length)) {
    if (name === '') continue;
    const ext = extensionOf(name);
    const stem = ext === '' ? name : name.slice(0, -ext.length);
    if (stem === '') continue;
    out = out.replaceAll(new RegExp(escapeForRegExp(stem), 'g'), () =>
      placeholder('film', stem).replace(/>$/, '>'),
    );
  }

  for (const name of [...subjects.deviceNames].sort((a, b) => b.length - a.length)) {
    if (name === '') continue;
    out = out.replaceAll(new RegExp(escapeForRegExp(name), 'g'), () => placeholder('device', name));
  }

  out = out.replace(IPV4, (match) =>
    NOT_AN_ADDRESS.has(match) ? match : placeholder('ip', match),
  );

  // The friendly name is already `<device-N>`, which is what correlation needs. The raw id
  // adds nothing a reader can use and is a stable identifier for a specific box.
  out = out.replace(DEVICE_ID, (match) => placeholder('id', match));

  // ⚠️ **Last, and inside paths as well as fields.** 249 of the 249 occurrences measured were
  // in `C:\\Users\\<name>\\…`, so a replacement that only matched a `"user"` field would have
  // left every one of them in place while reporting success.
  if (subjects.username !== null && subjects.username !== '') {
    out = out.replaceAll(new RegExp(escapeForRegExp(subjects.username), 'gi'), () =>
      placeholder('user', subjects.username ?? ''),
    );
  }

  return {
    text: out,
    counts: {
      user: seen.user.size,
      film: seen.film.size,
      device: seen.device.size,
      id: seen.id.size,
      ip: seen.ip.size,
    },
  };
}

/**
 * The lines of the current run, newest-run-only, capped — criterion 25c.
 *
 * ⚠️ **A silent truncation is the failure mode here.** A person who cannot see that lines are
 * missing will not mention it, and the missing ones will be the ones that were asked for. So
 * a capped export says so on its first line, with the number.
 */
export function currentRun(lines: readonly string[], cap: number): string[] {
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]?.includes('"engine.start"') === true) {
      start = i;
      break;
    }
  }
  const run = lines.slice(start).filter((line) => line.trim() !== '');
  if (run.length <= cap) return run;
  const dropped = run.length - cap;
  return [
    `{"note":"${String(dropped)} earlier lines of this run were dropped to keep this file small; the most recent ${String(cap)} are below"}`,
    ...run.slice(dropped),
  ];
}
