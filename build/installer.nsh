; CastGood — Windows Firewall rule, added at install and removed at uninstall.
;
; WHY THIS EXISTS
; --------------
; CastGood needs two kinds of *inbound* traffic that Windows blocks by default:
;   - UDP 5353 (mDNS) — the replies that carry device names arrive unsolicited,
;     because discovery keeps browsing rather than doing one request/response.
;   - TCP on the media server port — the TV opens a connection *back* to the PC
;     to pull the video.
; Without a rule, first launch pops the "Windows Security Alert" dialog. If the
; founder dismisses it, Windows writes *block* rules and CastGood then discovers
; nothing, for a reason nothing on screen can explain (PRD, M1: "story 1 failing
; for a reason the founder cannot see").
;
; WHAT IT ADDS — deliberately as narrow as it can be
; --------------------------------------------------
;   program-scoped   only $INSTDIR\CastGood.exe, never a port opened for anything
;   inbound only     outbound is allowed by Windows already; we add no outbound rule
;   private only     home wifi. Nothing is opened on public or domain networks
;   LocalSubnet only the TV is on the LAN by definition; nothing off-subnet
;   two ports only   UDP 5353, and TCP 8010-8029 (MEDIA_SERVER.defaultPort plus
;                    portScanAttempts in src/engine/config.ts — keep in step)
;
; ADMINISTRATOR RIGHTS — read this before changing anything here
; --------------------------------------------------------------
; Firewall rules are machine-wide: netsh cannot add one without elevation. There
; is no per-user equivalent. So this include:
;   - never makes the *install* need admin. The install itself stays per-user and
;     succeeds whatever happens below.
;   - tries netsh unelevated first (works when the installer was already run as
;     administrator, and on repair/upgrade runs).
;   - if that fails, asks for consent ONCE, with a standard UAC prompt for
;     "Windows Command Processor" (Microsoft-signed). Declining is fine: the
;     install completes, and the founder gets Windows' own prompt at first launch
;     instead — exactly where we are today.
;   - can be skipped entirely: CastGood-Setup.exe /NOFIREWALL
; If you ever need the rule *guaranteed*, that means perMachine or a mandatory
; elevation, which is a founder decision recorded in docs/DECISIONS.md — not an
; implementation detail to change here.
;
; IDEMPOTENCY
; -----------
; Every add is preceded by a delete of the same rule name, so re-running the
; installer cannot pile up duplicates. A registry marker under HKCU records the
; rule spec and the install path, so an upgrade into the same directory does not
; re-prompt.

!include FileFunc.nsh
!include LogicLib.nsh

!define CG_FW_SPEC "v1"
!define CG_FW_REGKEY "Software\CastGood"
!define CG_FW_REGVAL "FirewallRule"
!define CG_FW_MDNS "CastGood (mDNS discovery)"
!define CG_FW_MEDIA "CastGood (media server)"
!define CG_FW_MEDIA_PORTS "8010-8029"
!define CG_FW_SCRIPT "$PLUGINSDIR\castgood-firewall.cmd"
!define CG_FW_MARKER "$PLUGINSDIR\castgood-firewall.ok"

; ---------------------------------------------------------------------------
; Install: delete-then-add both rules.
; ---------------------------------------------------------------------------
!macro customInstall
  Push $0
  Push $1
  Push $2

  ; Escape hatch for anyone who does not want the rule (and for silent installs
  ; driven by a script): CastGood-Setup.exe /NOFIREWALL
  ${GetParameters} $2
  ClearErrors
  ${GetOptions} $2 "/NOFIREWALL" $0
  ${IfNot} ${Errors}
    DetailPrint "/NOFIREWALL given - skipping the Windows Firewall rule."
    ClearErrors
    Goto cg_fw_install_done
  ${EndIf}
  ClearErrors

  ; Already applied, for this exact spec and this exact install path.
  ReadRegStr $0 HKCU "${CG_FW_REGKEY}" "${CG_FW_REGVAL}"
  ${If} $0 == "${CG_FW_SPEC}|$INSTDIR"
    DetailPrint "Windows Firewall rule is already in place for $INSTDIR."
    Goto cg_fw_install_done
  ${EndIf}

  InitPluginsDir
  Delete "${CG_FW_MARKER}"

  ClearErrors
  FileOpen $1 "${CG_FW_SCRIPT}" w
  ${If} ${Errors}
    DetailPrint "Could not write the firewall helper script - skipping the rule."
    ClearErrors
    Goto cg_fw_install_done
  ${EndIf}
  FileWrite $1 '@echo off$\r$\n'
  ; Elevation probe. netsh returns 1 both for "no rules match" and for "access
  ; denied" (verified), so asking fltmc is the only unambiguous way to know
  ; whether this run can change anything at all.
  FileWrite $1 'fltmc >nul 2>&1 || exit /b 1$\r$\n'
  ; Delete first so a re-install replaces rather than duplicates. A missing rule
  ; makes netsh return 1; that is expected here, so its output is discarded.
  FileWrite $1 'netsh advfirewall firewall delete rule name="${CG_FW_MDNS}" >nul 2>&1$\r$\n'
  FileWrite $1 'netsh advfirewall firewall delete rule name="${CG_FW_MEDIA}" >nul 2>&1$\r$\n'
  FileWrite $1 'netsh advfirewall firewall add rule name="${CG_FW_MDNS}" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=private protocol=UDP localport=5353 remoteip=LocalSubnet description="Lets CastGood find Chromecast devices on your home network." || exit /b 1$\r$\n'
  FileWrite $1 'netsh advfirewall firewall add rule name="${CG_FW_MEDIA}" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=private protocol=TCP localport=${CG_FW_MEDIA_PORTS} remoteip=LocalSubnet description="Lets your TV play video files from this PC." || exit /b 1$\r$\n'
  ; The marker is how NSIS learns the netsh calls succeeded: ExecShellWait can
  ; report that the elevated process started, never what it returned.
  FileWrite $1 'echo ok> "%~dp0castgood-firewall.ok"$\r$\n'
  FileWrite $1 'exit /b 0$\r$\n'
  FileClose $1

  DetailPrint "Adding the Windows Firewall rule for CastGood (private networks only)..."
  nsExec::Exec '"$SYSDIR\cmd.exe" /c ""${CG_FW_SCRIPT}""'
  Pop $0

  ${IfNot} ${FileExists} "${CG_FW_MARKER}"
    ; Unelevated netsh refuses. Ask once; declining must not fail the install.
    ${IfNot} ${Silent}
      DetailPrint "Windows needs administrator approval for the firewall rule."
      ExecShellWait "runas" "$SYSDIR\cmd.exe" '/c ""${CG_FW_SCRIPT}""' SW_HIDE
    ${EndIf}
  ${EndIf}

  ${If} ${FileExists} "${CG_FW_MARKER}"
    WriteRegStr HKCU "${CG_FW_REGKEY}" "${CG_FW_REGVAL}" "${CG_FW_SPEC}|$INSTDIR"
    DetailPrint "Firewall rule added: CastGood only, private networks only."
  ${Else}
    DeleteRegValue HKCU "${CG_FW_REGKEY}" "${CG_FW_REGVAL}"
    DetailPrint "No firewall rule was added. Windows will ask the first time CastGood"
    DetailPrint "looks for devices - tick 'Private networks' and choose 'Allow access'."
  ${EndIf}

  cg_fw_install_done:
  Pop $2
  Pop $1
  Pop $0
!macroend

; ---------------------------------------------------------------------------
; Uninstall: remove exactly what we added, and only if we added it.
; ---------------------------------------------------------------------------
!macro customUnInstall
  Push $0
  Push $1

  ; An upgrade runs this uninstaller first. Removing the rule there would cost a
  ; second UAC prompt for no gain - the install that follows re-adds it.
  ${If} ${isUpdated}
    Goto cg_fw_uninstall_done
  ${EndIf}

  ; No marker means no rule of ours to remove: never prompt for nothing.
  ReadRegStr $0 HKCU "${CG_FW_REGKEY}" "${CG_FW_REGVAL}"
  ${If} $0 == ""
    Goto cg_fw_uninstall_done
  ${EndIf}

  InitPluginsDir
  Delete "${CG_FW_MARKER}"

  ClearErrors
  FileOpen $1 "${CG_FW_SCRIPT}" w
  ${If} ${Errors}
    ClearErrors
    Goto cg_fw_uninstall_orphaned
  ${EndIf}
  FileWrite $1 '@echo off$\r$\n'
  ; Same probe as the install side: an unelevated delete and a delete of a rule
  ; that is not there both return 1, so netsh cannot answer "did this work?".
  FileWrite $1 'fltmc >nul 2>&1 || exit /b 1$\r$\n'
  FileWrite $1 'netsh advfirewall firewall delete rule name="${CG_FW_MDNS}" >nul 2>&1$\r$\n'
  FileWrite $1 'netsh advfirewall firewall delete rule name="${CG_FW_MEDIA}" >nul 2>&1$\r$\n'
  FileWrite $1 'echo ok> "%~dp0castgood-firewall.ok"$\r$\n'
  FileWrite $1 'exit /b 0$\r$\n'
  FileClose $1

  DetailPrint "Removing CastGood's Windows Firewall rule..."
  nsExec::Exec '"$SYSDIR\cmd.exe" /c ""${CG_FW_SCRIPT}""'
  Pop $0

  ${IfNot} ${FileExists} "${CG_FW_MARKER}"
    ${IfNot} ${Silent}
      DetailPrint "Windows needs administrator approval to remove the firewall rule."
      ExecShellWait "runas" "$SYSDIR\cmd.exe" '/c ""${CG_FW_SCRIPT}""' SW_HIDE
    ${EndIf}
  ${EndIf}

  cg_fw_uninstall_orphaned:
  ${IfNot} ${FileExists} "${CG_FW_MARKER}"
    ; Leaving a rule behind that points at a deleted .exe is harmless (Windows
    ; matches on the program path), but say so rather than pretending.
    DetailPrint "The firewall rule could not be removed. To remove it later, run as"
    DetailPrint "administrator: netsh advfirewall firewall delete rule name=$\"${CG_FW_MDNS}$\""
    DetailPrint "and: netsh advfirewall firewall delete rule name=$\"${CG_FW_MEDIA}$\""
  ${EndIf}

  DeleteRegValue HKCU "${CG_FW_REGKEY}" "${CG_FW_REGVAL}"
  DeleteRegKey /ifempty HKCU "${CG_FW_REGKEY}"

  cg_fw_uninstall_done:
  Pop $1
  Pop $0
!macroend
