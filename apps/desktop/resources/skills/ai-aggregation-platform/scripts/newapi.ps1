# Works with Windows PowerShell 5.1 and PowerShell 7. Python standard library only.
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'newapi.py'
if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 $scriptPath @args
} elseif (Get-Command python3 -ErrorAction SilentlyContinue) {
    & python3 $scriptPath @args
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    & python $scriptPath @args
} else {
    Write-Error 'Python 3.9+ required. Install Python from python.org; no pip packages needed.'
    exit 1
}
exit $LASTEXITCODE
