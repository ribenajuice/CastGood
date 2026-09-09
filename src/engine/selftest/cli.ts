import { installSignalHandlers, runSelftestCli } from './args.js';

/**
 * The selftest's process entry point — `scripts/selftest.mjs` bundles *this* file.
 *
 * It is deliberately the only file under `src/engine/` that does anything on import, and
 * everything it does lives in `args.ts` where it can be tested. There is no Electron here
 * and never will be: no window, no human, plain Node, which is the whole point of story 13.
 *
 * **stdout carries the verdict JSON and nothing else.** The engine's own log goes to the
 * daily JSONL file, and the human-readable summary goes to stderr. Anything printed to
 * stdout by anything else would break the contract with the wrapper script.
 */

installSignalHandlers();

runSelftestCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    forceExitIfHung(code);
  },
  (error: unknown) => {
    // Reaching here means the harness itself broke. That is "could not run", not a pass.
    process.stderr.write(
      `castgood selftest: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
    forceExitIfHung(2);
  },
);

/**
 * A safety net, not the normal path: the process should end by itself once the engine has
 * closed its sockets. If some handle we do not own keeps the loop alive, exit anyway —
 * a selftest that never returns is as useless as one that lies. Unreferenced, so it
 * cannot itself be the reason the process stays up.
 */
function forceExitIfHung(code: number): void {
  const timer = setTimeout(() => process.exit(code), 5_000);
  timer.unref?.();
}
