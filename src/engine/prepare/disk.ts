import fsp from 'node:fs/promises';
import path from 'node:path';
import { PREPARATION } from '../config.js';
import { describeApproxBytes } from './classify.js';

/**
 * "Will this job fit?" — asked **before any work begins** (P1), and again as the reason a
 * job that ran out of room stops cleanly (P2).
 *
 * The PRD calls the pre-flight check *"arithmetic over (estimated size, free bytes)"* and a
 * *pure function*, so it is one — `roomFor` takes two numbers and returns a sentence. The
 * only I/O in this file is `freeBytesOn`, which asks the operating system how much room a
 * volume has, and it is deliberately separate so every rule about margins, rounding and
 * wording can be tested in WSL against numbers rather than against a disk.
 *
 * **The margin is 15%** (`PREPARATION.diskHeadroomFactor`), from M3's own table of numbers:
 * *"an estimate that is exactly right is a coin flip; 15% is the margin between refusing
 * honestly up front and failing at 80%."*
 *
 * **CastGood never frees space on the founder's behalf** (P2). There is no eviction, no
 * "delete the oldest prepared film", no cleanup policy — the 2026-08-19 ruling put the
 * founder's films under the founder's control and this is where that would otherwise be
 * quietly undone. The only thing this file may ever delete is something the pipeline itself
 * wrote, and that is `naming.isOurName`'s job, not this one's.
 */

export interface RoomVerdict {
  /** Is there room for the job plus its margin? */
  readonly ok: boolean;
  /** What the job is estimated to write, before the margin. */
  readonly estimatedBytes: number;
  /** Estimate × the headroom factor: what we actually insist on. */
  readonly requiredBytes: number;
  readonly freeBytes: number;
  /** `0` when it fits. Otherwise how much more room is needed, including the margin. */
  readonly shortfallBytes: number;
  /**
   * P1's sentence, or `null` when it fits. Plain amount, no path, no percentages — *"needs
   * about 3 GB more"* is the PRD's own phrasing and this is it.
   */
  readonly message: string | null;
}

export function roomFor(estimatedBytes: number, freeBytes: number): RoomVerdict {
  // Both inputs come from outside this function — one from a classifier estimate over a
  // probe, one from `statfs` — so neither is assumed to be a number. A `NaN` reaching the
  // shortfall would print "needs about NaN more" at the founder.
  const estimated = Number.isFinite(estimatedBytes) ? Math.max(0, estimatedBytes) : 0;
  const free = Number.isFinite(freeBytes) ? Math.max(0, freeBytes) : 0;
  const required = Math.ceil(estimated * PREPARATION.diskHeadroomFactor);
  const shortfall = Math.max(0, required - free);
  return {
    ok: shortfall === 0,
    estimatedBytes: estimated,
    requiredBytes: required,
    freeBytes: free,
    shortfallBytes: shortfall,
    message:
      shortfall === 0
        ? null
        : `There isn’t enough room on that drive — CastGood needs ${describeApproxBytes(shortfall)} more.`,
  };
}

/**
 * How much room is left on the volume holding `target`.
 *
 * `target` may not exist yet — it is usually the file we are about to write — so the
 * question is asked of its **directory**, which does. `statfs` reports blocks available
 * *to this user*, which is the number that decides whether a write succeeds, rather than
 * the larger figure including the reserve only root may touch.
 *
 * Returns `null` rather than throwing when the volume cannot be interrogated at all (an
 * unusual filesystem, a share that has gone away). A caller that cannot find out how much
 * room there is must not refuse the job on that basis — it proceeds, and P2's during-the-job
 * handling is what catches a disk that really was full. Refusing to start because we could
 * not measure would turn an unusual filesystem into a film that will not play.
 */
export async function freeBytesOn(target: string): Promise<number | null> {
  const directory = path.dirname(path.resolve(target));
  try {
    const stats = await fsp.statfs(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/**
 * Can this directory be written to at all?
 *
 * 9e: the prepared file goes beside the source *"on whatever drive the film came from; when
 * that folder cannot be written to, it goes to CastGood's own working folder and the app
 * says where it went"*. A read-only folder, a network share mounted without write
 * permission and a full volume are all the same answer to the founder, and all three are
 * found here rather than half way through a conversion.
 *
 * Asked by writing, because `W_OK` on Windows does not mean what it means elsewhere: NTFS
 * ACLs and read-only shares both report a writable directory that then refuses the write.
 * The probe file is created and removed under a name only we would use.
 */
export async function isWritableDirectory(directory: string): Promise<boolean> {
  const probe = path.join(directory, `.castgood-write-test-${String(process.pid)}`);
  try {
    await fsp.writeFile(probe, '');
    return true;
  } catch {
    return false;
  } finally {
    await fsp.rm(probe, { force: true }).catch(() => undefined);
  }
}
