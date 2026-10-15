; Included automatically by electron-builder (buildResources/installer.nsh).
; During an in-app update the new files are in place after installApplicationFiles; the update window
; polls for this marker to move on from "Installing" to "Starting".
; The data directory moved from $APPDATA\ajzakomator to $APPDATA\unimux (src/main/dataDirMigration.ts), and the app leaves
; a junction at the old path. While $APPDATA\ajzakomator exists (the real directory of a build that has not migrated yet,
; whose update window polls there, or the junction) the marker goes there; otherwise into $APPDATA\unimux\update.
; $APPDATA\unimux is never created while the old directory is still real, so the app's migration finds it free.
!macro customInstall
  ${if} ${isUpdated}
    ${if} ${FileExists} "$APPDATA\ajzakomator\*.*"
      CreateDirectory "$APPDATA\ajzakomator\update"
      FileOpen $0 "$APPDATA\ajzakomator\update\installer-done" w
    ${else}
      CreateDirectory "$APPDATA\unimux\update"
      FileOpen $0 "$APPDATA\unimux\update\installer-done" w
    ${endIf}
    FileWrite $0 "${VERSION}"
    FileClose $0
  ${endIf}
  ; An update, and a manual reinstall over an existing installation (the taskbar pin always), keep the existing shortcuts,
  ; which still carry the AppUserModelID of builds up to 0.8.4 (com.ajzakomator.app). Stamp the current one so the
  ; taskbar groups the window with its pin and notifications keep working.
  ${if} ${FileExists} "$newStartMenuLink"
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${endIf}
  ${if} ${FileExists} "$newDesktopLink"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endIf}
  ${if} ${FileExists} "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk"
    WinShell::SetLnkAUMI "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk" "${APP_ID}"
  ${endIf}
  ClearErrors
!macroend
