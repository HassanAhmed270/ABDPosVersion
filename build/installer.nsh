; Runs during BPIOLS's own NSIS installation, after files are copied —
; mongod.exe requires the Visual C++ Redistributable runtime, which a
; fresh Windows machine typically does not have installed. Without
; this, mongod.exe fails immediately with STATUS_DLL_NOT_FOUND
; (0xC0000135 / 3221225785) the first time the app tries to start it.
!macro customInstall
  DetailPrint "Installing Visual C++ Redistributable (required by the local database)..."
  ExecWait '"$INSTDIR\resources\mongodb-bin\vc_redist.x64.exe" /install /quiet /norestart'
!macroend
