param(
    [string]$ArtifactDirectory = (Join-Path $PSScriptRoot 'artifacts'),
    [switch]$Matrix
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$ArtifactDirectory = [IO.Path]::GetFullPath($ArtifactDirectory)
if (Test-Path $ArtifactDirectory) { throw 'Use a new artifact directory for every run.' }
New-Item -ItemType Directory $ArtifactDirectory | Out-Null
$options = Get-Content (Join-Path $root 'options.json') -Raw | ConvertFrom-Json
$source = Get-Content (Join-Path $root 'source.json') -Raw | ConvertFrom-Json
$summary = [ordered]@{ schemaVersion = 1; source = $source; startedAt = [DateTime]::UtcNow.ToString('o'); ok = $false; cases = @() }
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('native-snap-' + [Guid]::NewGuid().ToString('N'))
function Resolve-Binary($value) {
    if ([IO.Path]::IsPathRooted($value)) { return $value }
    return Join-Path $root $value
}
function Write-Json($path, $value) {
    [IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
}
function Write-RunnerLog($message) {
    [IO.File]::AppendAllText((Join-Path $ArtifactDirectory 'runner.log'), [DateTime]::UtcNow.ToString('o') + ' ' + $message + [Environment]::NewLine)
}
try {
    Write-RunnerLog 'checking source and desktop metadata'
    if (-not $source.clean) { throw 'Native acceptance requires a clean source checkout.' }
    $summary.os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' | Select-Object ProductName, CurrentBuildNumber, UBR, EditionID, InstallationType
    $summary.sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $summary.interactive = [Environment]::UserInteractive
    $options.hostBinary = Resolve-Binary $options.hostBinary
    $options.electronBinary = Resolve-Binary $options.electronBinary
    Write-RunnerLog 'hashing native binaries'
    $summary.hostSha256 = (Get-FileHash $options.hostBinary -Algorithm SHA256).Hash.ToLowerInvariant()
    $summary.electronSha256 = (Get-FileHash $options.electronBinary -Algorithm SHA256).Hash.ToLowerInvariant()
    New-Item -ItemType Directory $scratch | Out-Null
    Write-RunnerLog 'compiling native probe'
    Add-Type -Path (Join-Path $root 'probe.cs') -OutputAssembly (Join-Path $scratch 'probe.exe') -OutputType WindowsApplication -ReferencedAssemblies System.dll,System.Drawing.dll,System.Windows.Forms.dll,System.Web.Extensions.dll
    $cases = @('candidate')
    if ($options.baseline) { $cases = @('baseline') }
    if ($Matrix) { $cases = @('baseline', 'candidate') }
    foreach ($case in $cases) {
        Write-RunnerLog ("starting " + $case)
        $runtime = Join-Path $scratch $case
        $evidence = Join-Path $ArtifactDirectory $case
        New-Item -ItemType Directory $runtime, $evidence | Out-Null
        Copy-Item (Join-Path $root 'main.cjs') $runtime
        Copy-Item (Join-Path $scratch 'probe.exe') $runtime
        $options.baseline = ($case -eq 'baseline')
        Write-Json (Join-Path $runtime 'options.json') $options
        # An external adapter follows this file; no private transport is required by the native path.
        [IO.File]::WriteAllText((Join-Path $ArtifactDirectory 'active-directory.txt'), $runtime)
        $process = Start-Process (Join-Path $runtime 'probe.exe') -PassThru
        $completed = $process.WaitForExit(300000)
        if (-not $completed) {
            & taskkill.exe /PID $process.Id /T /F | Out-Null
        }
        # Never upload profiles, databases, user paths or unrelated desktop captures.
        foreach ($name in @('result.json', 'ready.json', 'probe.log', 'stdout.txt', 'stderr.txt', 'host-stderr.txt', 'native-rpc.jsonl', 'fixture-error.txt')) {
            $file = Join-Path $runtime $name
            if (Test-Path $file) {
                $text = [IO.File]::ReadAllText($file)
                foreach ($privatePath in @($runtime, $root, $env:USERPROFILE)) {
                    if ($privatePath) {
                        $text = $text.Replace($privatePath.Replace('\', '\\'), '<runtime>').Replace($privatePath, '<runtime>')
                    }
                }
                [IO.File]::WriteAllText((Join-Path $evidence $name), $text, [Text.UTF8Encoding]::new($false))
            }
        }
        Get-ChildItem $runtime -Filter '*.png' | Copy-Item -Destination $evidence
        if (-not $completed) { throw "$case native probe timed out; see retained artifacts." }
        $result = Get-Content (Join-Path $evidence 'result.json') -Raw | ConvertFrom-Json
        if ($case -eq 'baseline' -and $Matrix) {
            $passed = $false
            if ($result.before -and $result.left -and $result.before.style -match '^0x[0-9A-Fa-f]{8}$') {
                $unchanged = $true
                foreach ($field in @('x', 'y', 'width', 'height')) {
                    if ($result.before.$field -ne $result.left.$field) { $unchanged = $false }
                }
                $style = [Convert]::ToUInt32($result.before.style.Substring(2), 16)
                $passed = ($result.ok -eq $false -and $result.baseline -eq $true -and
                    $result.failure -ceq 'Win+Left did not snap to the work-area half' -and
                    $unchanged -and ($style -band 0x00C40000) -eq 0)
            }
        } else {
            $passed = ($result.ok -eq $true -and $result.baseline -eq $false)
        }
        $summary.cases += [ordered]@{ name = $case; runId = $result.runId; passed = $passed; checks = $result.checks }
        Write-RunnerLog ($case + ' passed=' + $passed + ' checks=' + $result.checks)
        if (-not $passed) { throw "$case did not satisfy its acceptance contract: $($result.failure); see retained artifacts." }
    }
    $summary.ok = $true
} catch {
    $summary.error = $_.Exception.Message
    Write-RunnerLog ('failed: ' + $_.Exception.Message)
    throw
} finally {
    $summary.finishedAt = [DateTime]::UtcNow.ToString('o')
    Write-Json (Join-Path $ArtifactDirectory 'summary.json') $summary
    foreach ($name in @('main.cjs', 'probe.cs', 'run.ps1', 'source.json')) {
        Copy-Item (Join-Path $root $name) $ArtifactDirectory
    }
    if (Test-Path (Join-Path $scratch 'probe.exe')) { Copy-Item (Join-Path $scratch 'probe.exe') $ArtifactDirectory }
    $hashes = Get-ChildItem $ArtifactDirectory -Recurse -File | Where-Object Name -ne 'active-directory.txt' | ForEach-Object {
        $relative = $_.FullName.Substring($ArtifactDirectory.Length + 1).Replace('\', '/')
        (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $relative
    }
    [IO.File]::WriteAllLines((Join-Path $ArtifactDirectory 'SHA256SUMS'), [string[]]$hashes)
    Remove-Item (Join-Path $ArtifactDirectory 'active-directory.txt') -ErrorAction SilentlyContinue
    if (Test-Path $scratch) { Remove-Item $scratch -Recurse -Force }
}
