; Compile with makensis and run the resulting executable. A nonzero exit code
; identifies the failing case. No registry writes or elevation are needed.
Unicode true
Name "NSIS update scope test"
OutFile "nsis-update-scope.exe"
RequestExecutionLevel user
SilentInstall silent
!include LogicLib.nsh
!include "..\build\installer.nsh"

Var updated
Var requestedScope
Var hasPerMachineInstallation
Var hasPerUserInstallation
Var isForceMachineInstall
Var isForceCurrentInstall

!define isUpdated '$updated == "1"'
!define isForAllUsers '$requestedScope == "all"'
!define isForCurrentUser '$requestedScope == "current"'

!macro checkScope machine user forceMachine forceCurrent
  StrCpy $hasPerMachineInstallation ${machine}
  StrCpy $hasPerUserInstallation ${user}
  StrCpy $isForceMachineInstall 0
  StrCpy $isForceCurrentInstall 0
  !insertmacro customInstallMode
  ${If} $isForceMachineInstall != ${forceMachine}
  ${OrIf} $isForceCurrentInstall != ${forceCurrent}
    SetErrorLevel ${__LINE__}
    Quit
  ${EndIf}
!macroend

Section
  StrCpy $updated 1
  !insertmacro checkScope 1 0 1 0
  !insertmacro checkScope 0 1 0 1
  !insertmacro checkScope 1 1 0 0
  !insertmacro checkScope 0 0 0 0

  StrCpy $requestedScope current
  !insertmacro checkScope 1 0 0 0
  StrCpy $requestedScope all
  !insertmacro checkScope 0 1 0 0

  StrCpy $requestedScope ""
  StrCpy $updated 0
  !insertmacro checkScope 1 0 0 0
  !insertmacro checkScope 0 1 0 0
SectionEnd
