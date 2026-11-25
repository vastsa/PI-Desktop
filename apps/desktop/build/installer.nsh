!ifndef BUILD_UNINSTALLER
  !macro customInstallMode
    ; Let the assisted installer apply the selected scope and handle elevation.
    ${If} ${isUpdated}
    ${AndIf} $hasPerMachineInstallation != $hasPerUserInstallation
    ${AndIfNot} ${isForAllUsers}
    ${AndIfNot} ${isForCurrentUser}
      StrCpy $isForceMachineInstall $hasPerMachineInstallation
      StrCpy $isForceCurrentInstall $hasPerUserInstallation
    ${EndIf}
  !macroend
!endif
