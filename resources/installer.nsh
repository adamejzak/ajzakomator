; Included automatically by electron-builder (buildResources/installer.nsh).
; During an in-app update the new files are in place after installApplicationFiles; the update window
; polls for this marker to move on from "Installing" to "Starting".
!macro customInstall
  ${if} ${isUpdated}
    CreateDirectory "$APPDATA\ajzakomator\update"
    FileOpen $0 "$APPDATA\ajzakomator\update\installer-done" w
    FileWrite $0 "${VERSION}"
    FileClose $0
  ${endIf}
!macroend
