!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$DESKTOP\QuickAsset.lnk" "$INSTDIR\QuickAsset.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$DESKTOP\QuickAsset.lnk"
!macroend
