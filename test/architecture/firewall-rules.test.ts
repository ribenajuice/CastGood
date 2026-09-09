import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIREWALL_RULES } from '../../src/main/ipc.js';
import { MEDIA_SERVER } from '../../src/engine/config.js';

/**
 * The installer and *Allow through the firewall* must agree, exactly.
 *
 * Two places create CastGood's Windows Firewall rules — `build/installer.nsh` at install
 * time, and `src/main/main.ts` when the founder presses the button that 17a's diagnosis
 * offers. They are written in different languages, live in different files, and nothing at
 * runtime compares them. When they first diverged, the button invented a rule called
 * `CastGood` with no port and no subnet scope: `scripts/win-firewall.sh` went on reporting
 * the real rules absent, the uninstaller could not remove what the app had added, and the
 * hole opened was the whole executable rather than two scoped ports.
 *
 * This is a source-text check rather than a behavioural one, because the behaviour only
 * exists on Windows with an administrator — which is human checklist item 6, and runs
 * roughly once per release. This runs on every commit.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const installer = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main/main.ts'), 'utf8');

/**
 * The same file with its comments removed.
 *
 * Used only where a check is looking for the *absence* of something: the comments here
 * quote the very mistakes being guarded against, and a test that reads a warning about a
 * bug as the bug itself would fail the build for explaining itself.
 */
const mainCode = main
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');

describe('the firewall rules the app adds are the ones the installer added', () => {
  it('uses the installer’s own rule names, character for character', () => {
    expect(installer).toContain(`!define CG_FW_MDNS "${FIREWALL_RULES.mdns}"`);
    expect(installer).toContain(`!define CG_FW_MEDIA "${FIREWALL_RULES.media}"`);
  });

  it('covers exactly the ports the media server can actually bind', () => {
    // The server scans upward from its default port, so a rule for a narrower range is a
    // rule that stops working on the first evening something else holds port 8010.
    const first = MEDIA_SERVER.defaultPort;
    const last = first + MEDIA_SERVER.portScanAttempts - 1;
    expect(installer).toContain(`!define CG_FW_MEDIA_PORTS "${String(first)}-${String(last)}"`);
    expect(main).toContain('firstPort + MEDIA_SERVER.portScanAttempts - 1');
  });

  it('keeps the installer’s scope: private profile, local subnet, inbound only', () => {
    for (const source of [installer, main]) {
      expect(source).toContain('profile=private');
      expect(source).toContain('remoteip=LocalSubnet');
      expect(source).toContain('dir=in action=allow');
    }
    // mDNS is UDP/5353; the media server is TCP on the scanned range. Neither is `any`.
    expect(main).toContain('protocol=UDP localport=5353');
    expect(mainCode).not.toMatch(/protocol=any/i);
  });

  it('deletes before adding, so pressing the button twice does not pile up duplicates', () => {
    const deletes = mainCode.match(/netsh advfirewall firewall delete rule/g) ?? [];
    expect(deletes).toHaveLength(2);
  });

  /**
   * Checklist item 6, 2026-08-19, on real hardware.
   *
   * Dismissing Windows' "allow this app?" alert — by Cancel **or** by the X — writes a
   * Block rule named after the executable, and Windows resolves Block before Allow. So the
   * rules this button adds were added correctly, reported honestly, and did nothing: three
   * full add-and-retry cycles were logged, all blocked, until the founder deleted Windows'
   * entry by hand. The founder who needs this button is by definition the founder who
   * dismissed that dialog, so clearing what the dialog created is not optional.
   *
   * It must delete by `program=`, never by name: Windows chooses that name from the
   * executable and it varies by locale and Windows version.
   */
  it('clears Windows’ own block rule for this executable, which outranks anything we add', () => {
    expect(mainCode).toContain('Remove-NetFirewallRule');
    expect(mainCode).toContain("$_.Action -eq 'Block'");
    expect(mainCode).toContain("$_.Direction -eq 'Inbound'");
  });

  /**
   * The delete must not be able to revoke a permission the founder already has.
   *
   * `netsh delete rule ... program=` cannot filter on the action, so it removes allow rules
   * as readily as block ones — and only a private-profile pair is added back. A founder whose
   * home network is classified Public, or who ticked Public in Windows' own dialog, would have
   * their working rule deleted by a button labelled "Allow through the firewall".
   */
  it('never deletes by program alone, which would take working allow rules with it', () => {
    expect(mainCode).not.toMatch(/delete rule name=all[^\n]*program=/);
  });

  /**
   * The executable path must not be interpolated into a quoted shell string. A Windows
   * account named "O'Brien" is the case that already broke this command once.
   */
  it('passes the executable path by environment variable, not inside the quoting', () => {
    expect(mainCode).toContain('set "CASTGOOD_EXE=${exe}"');
    expect(mainCode).toContain('$env:CASTGOOD_EXE');
  });

  it('never quotes a Windows path with an apostrophe', () => {
    // `cmd.exe` does not treat `'` as a quote. `program='C:\\Program Files\\...'` splits at
    // the space and netsh rejects the lot — silently, because nothing read the exit code.
    expect(mainCode).not.toMatch(/program='/);
    expect(mainCode).toContain('program="${exe}"');
  });

  it('reads the elevated process’s exit code rather than assuming it worked', () => {
    // `Start-Process -Wait` reports that the process finished, never what it returned. This
    // is the difference between telling the founder the rule was added and knowing it was.
    expect(main).toContain('-PassThru');
    expect(main).toContain('exit $p.ExitCode');
  });
});
