<#
.SYNOPSIS
    把一个目录下所有 PNG 批量转换成 WebP，保留相对目录结构，跳过已存在的输出。

.DESCRIPTION
    引擎：Python + Pillow（Pillow 自带 libwebp 支持，无需 ImageMagick / cwebp）。
    所有输出路径都是 <OutDir> 下的镜像结构，绝不改名、绝不删除源 PNG，
    因此回滚 = 删掉生成过的 .webp（或用 -Manifest 精确删除）。

.PARAMETER Path
    源目录（递归扫描）。

.PARAMETER OutDir
    输出根目录。默认 <Path>\_webp，用子目录收纳可避免输出文件混在源目录里。

.PARAMETER Quality
    WebP 有损质量 1-100，默认 82。

.PARAMETER Lossless
    使用无损模式（此时忽略 Quality）。

.PARAMETER Jobs
    并行进程数，默认 4。

.PARAMETER Manifest
    把成功转换的文件清单（源/输出）写入该 JSON 文件，供回滚使用。
    默认写到 <OutDir>\_convert-manifest.json。

.PARAMETER WhatIf
    只列出将要转换的文件，不做任何写操作。

.PARAMETER Rollback
    执行回滚：依据 manifest 删除生成的 .webp（只删 manifest 里记录过、
    且仍然存在的文件）。不会碰源 PNG。

.EXAMPLE
    .\Convert-PngToWebp.ps1 -Path .\assets -WhatIf

.EXAMPLE
    .\Convert-PngToWebp.ps1 -Path .\assets -OutDir .\assets\_webp -Quality 85

.EXAMPLE
    .\Convert-PngToWebp.ps1 -Path .\assets -Rollback
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [string]$OutDir,

    [ValidateRange(1, 100)]
    [int]$Quality = 82,

    [switch]$Lossless,

    [ValidateRange(1, 64)]
    [int]$Jobs = 4,

    [string]$Manifest,

    [switch]$Rollback
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 顶层兜底：把未处理异常收敛成一行清晰的中文提示（PS 5.1 默认会喷一屏堆栈）
trap {
    Write-Host ""
    Write-Host "错误：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# ---------- 路径规范化 ----------
function Resolve-FullPath([string]$p) {
    if ([System.IO.Path]::IsPathRooted($p)) {
        return [System.IO.Path]::GetFullPath($p)
    }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $p))
}

if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "源目录不存在: $Path"
}
$srcRoot = (Resolve-Path -LiteralPath $Path).ProviderPath.TrimEnd('\', '/')

if (-not $OutDir) {
    $OutDir = Join-Path $srcRoot '_webp'
}
$outRoot = Resolve-FullPath $OutDir

if (-not $Manifest) {
    $Manifest = Join-Path $outRoot '_convert-manifest.json'
}
$manifestPath = Resolve-FullPath $Manifest

# ---------- Python / Pillow 自检 ----------
function Get-PythonExe {
    foreach ($name in @('python', 'py')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmd) {
            # 用 python.exe 而非 py.exe 的 launcher 语义差异：统一实测能否 import PIL
            $exe = $cmd.Source
            $probe = & $exe -c "import PIL, PIL.features; print(int(PIL.features.check('webp')))" 2>&1
            if ($LASTEXITCODE -eq 0 -and "$probe".Trim() -eq '1') {
                return $exe
            }
        }
    }
    return $null
}

# 内嵌的转换器：由 PowerShell 生成到临时文件后调用。
# 用 json 文件传输清单，避免命令行长度限制与参数转义问题。
$converterSource = @'
import json, sys, os, io
from concurrent.futures import ThreadPoolExecutor
from PIL import Image

plan_path, quality, lossless, jobs = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "1", int(sys.argv[4])
with open(plan_path, "r", encoding="utf-8-sig") as f:
    items = json.load(f)

results = []
def convert(item):
    src, dst = item["src"], item["dst"]
    try:
        if os.path.exists(dst):
            return {"src": src, "dst": dst, "status": "skipped"}
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with Image.open(src) as im:
            im.load()
            has_alpha = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
            work = im.convert("RGBA") if has_alpha else im.convert("RGB")
            kw = {"format": "WEBP", "method": 4}
            if lossless:
                kw.update(lossless=True, exact=True)
            else:
                kw.update(lossless=False, quality=quality)
            if im.info.get("icc_profile"):
                kw["icc_profile"] = im.info["icc_profile"]
            tmp = dst + ".part"
            work.save(tmp, **kw)
            os.replace(tmp, dst)
        return {"src": src, "dst": dst, "status": "ok"}
    except Exception as e:
        try:
            if os.path.exists(dst + ".part"):
                os.remove(dst + ".part")
        except Exception:
            pass
        return {"src": src, "dst": dst, "status": "error", "error": f"{type(e).__name__}: {e}"}

with ThreadPoolExecutor(max_workers=jobs) as ex:
    for r in ex.map(convert, items):
        results.append(r)

print(json.dumps(results, ensure_ascii=False))
'@

function Invoke-Conversion([string[]]$sources) {
    $python = Get-PythonExe
    if (-not $python) {
        throw "找不到可用的 Python + Pillow(WebP)。请安装：python -m pip install --upgrade Pillow"
    }

    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("png2webp_" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    $pyFile = Join-Path $tmpDir 'convert.py'
    $planFile = Join-Path $tmpDir 'plan.json'

    try {
        # 无 BOM UTF-8：PowerShell 5.1 的 -Encoding UTF8 会加 BOM，
        # 而 Python 侧用 utf-8-sig 读取，两者兼容。
        [System.IO.File]::WriteAllText($pyFile, $converterSource, (New-Object System.Text.UTF8Encoding($false)))

        $plan = foreach ($s in $sources) {
            $rel = $s.Substring($srcRoot.Length).TrimStart('\', '/')
            $dstRel = [System.IO.Path]::ChangeExtension($rel, '.webp')
            [pscustomobject]@{
                src = $s
                dst = (Join-Path $outRoot $dstRel)
            }
        }
        # 必须用【无 BOM 的 UTF-8】写 plan：PowerShell 5.1 的 -Encoding UTF8 带 BOM，
        # 用 -Encoding ASCII 则会把中文路径全部变成 '?'（真实踩过的坑，导
        # 致中文目录转换失败）。所以这里直接调 .NET 写无 BOM UTF-8。
        # 坑：PowerShell 的 ConvertTo-Json 对【单元素】集合会输出裸对象而不是数组，
        # Python 侧 `for item in items` 就会遍历到字典的键名（字符串），
        # 报 "TypeError: string indices must be integers"。
        # 用 @($plan) 强制成数组，并保证 JSON 顶层始终是 list。
        $planJson = ConvertTo-Json -InputObject @($plan) -Depth 3 -Compress
        # 注意：别用 -notlike '[*'，'[' 在通配符里是字符类起始，会抛 WildcardPatternException
        if (-not $planJson.TrimStart().StartsWith('[')) { $planJson = "[$planJson]" }
        [System.IO.File]::WriteAllText($planFile, $planJson, (New-Object System.Text.UTF8Encoding($false)))

        $llArg = if ($Lossless) { '1' } else { '0' }
        # 重定向到文件而不是 2>&1：PowerShell 5.1 会把 stderr 每条都包装成
        # NativeCommandError，traceback 的多行信息会被拆散、看不到真正的异常。
        $outFile = Join-Path $tmpDir 'stdout.txt'
        $errFile = Join-Path $tmpDir 'stderr.txt'
        $p = Start-Process -FilePath $python `
            -ArgumentList @($pyFile, $planFile, $Quality, $llArg, $Jobs) `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
            -NoNewWindow -Wait -PassThru
        # 坑：Get-Content -Raw 对空文件返回 $null，而 PowerShell 里
        # [string]$null 依然是 $null（不是空串），后续 .Trim() 就会崩。
        # 必须显式判断后再兜底成 ''。
        $stdout = if (Test-Path -LiteralPath $outFile) { Get-Content -LiteralPath $outFile -Raw -Encoding UTF8 } else { $null }
        $stderr = if (Test-Path -LiteralPath $errFile) { Get-Content -LiteralPath $errFile -Raw -Encoding UTF8 } else { $null }
        if ($null -eq $stdout) { $stdout = '' }
        if ($null -eq $stderr) { $stderr = '' }

        if ($p.ExitCode -ne 0) {
            $msg = @(
                "转换器进程失败 (exit $($p.ExitCode)):"
                '--- stderr ---'
 $stderr.Trim()
                '--- stdout ---'
 $stdout.Trim()
            ) -join "`n"
            throw $msg
        }
        if (-not $stdout.Trim()) {
            throw "转换器没有输出结果。stderr:`n$($stderr.Trim())"
        }
        return $stdout | ConvertFrom-Json
    }
    finally {
        Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ---------- 回滚 ----------
if ($Rollback) {
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        throw "找不到 manifest，无法回滚: $manifestPath"
    }
    $data = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $removed = 0; $missing = 0
    foreach ($e in $data.files) {
        $dst = $e.dst
        # 安全护栏：只删 .webp 且在输出根目录之内
        if ([System.IO.Path]::GetExtension($dst) -ne '.webp') { continue }
        if (-not $dst.StartsWith($outRoot, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if (Test-Path -LiteralPath $dst) {
            Remove-Item -LiteralPath $dst -Force
            $removed++
        }
        else { $missing++ }
    }
    # 清理空的输出子目录
    if (Test-Path -LiteralPath $outRoot) {
        Get-ChildItem -LiteralPath $outRoot -Directory -Recurse -ErrorAction SilentlyContinue |
            Sort-Object -Property FullName -Descending |
            Where-Object { @(Get-ChildItem -LiteralPath $_.FullName -Force).Count -eq 0 } |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    }
    Write-Host "回滚完成：删除 $removed 个 .webp，$missing 个已不存在。" -ForegroundColor Green
    Write-Host "manifest 保留在 $manifestPath（确认无误后可自行删除）。"
    return
}

# ---------- 扫描 ----------
Write-Host "源目录 : $srcRoot"
Write-Host "输出   : $outRoot"
Write-Host "模式   : $(if ($Lossless) { 'lossless' } else { "lossy q=$Quality" })"

$sources = Get-ChildItem -LiteralPath $srcRoot -Recurse -File -Filter '*.png' -ErrorAction SilentlyContinue |
    # 不要回头扫描输出目录自身（OutDir 在源目录里时）
    Where-Object { -not $_.FullName.StartsWith($outRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and $_.FullName -ne $outRoot } |
    ForEach-Object { $_.FullName } |
    Sort-Object

if (-not $sources) {
    Write-Host "没有找到 PNG 文件。" -ForegroundColor Yellow
    return
}

# 分类：已存在输出 → 跳过
$todo = @()
$skip = 0
foreach ($s in $sources) {
    $rel = $s.Substring($srcRoot.Length).TrimStart('\', '/')
    $dst = Join-Path $outRoot ([System.IO.Path]::ChangeExtension($rel, '.webp'))
    if (Test-Path -LiteralPath $dst) { $skip++ }
    else { $todo += $s }
}

Write-Host ("发现 {0} 个 PNG：待转换 {1}，已存在输出跳过 {2}" -f $sources.Count, $todo.Count, $skip)

if (-not $todo) {
    Write-Host "全部已存在输出，无需转换。" -ForegroundColor Green
    return
}

if ($WhatIfPreference) {
    $todo | ForEach-Object { $rel = $_.Substring($srcRoot.Length).TrimStart('\', '/'); Write-Host ("  WOULD  {0} -> {1}" -f $rel, [System.IO.Path]::ChangeExtension($rel, '.webp')) }
    return
}

# ---------- 转换 ----------
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$results = Invoke-Conversion -sources $todo
$sw.Stop()

$ok = @($results | Where-Object status -eq 'ok')
$failed = @($results | Where-Object status -eq 'error')
$skipped = @($results | Where-Object status -eq 'skipped')

# ---------- manifest（增量合并，便于多次运行后一次性回滚） ----------
New-Item -ItemType Directory -Path (Split-Path -Parent $manifestPath) -Force | Out-Null
$previous = @()
if (Test-Path -LiteralPath $manifestPath) {
    try {
        $prevData = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($prevData.files) { $previous = @($prevData.files) }
    }
    catch { Write-Warning "旧 manifest 无法解析，将重建。" }
}
$allFiles = @{}
foreach ($p in $previous) { $allFiles[$p.dst] = [pscustomobject]@{ src = $p.src; dst = $p.dst } }
foreach ($r in $ok) { $allFiles[$r.dst] = [pscustomobject]@{ src = $r.src; dst = $r.dst } }

[pscustomobject]@{
    tool      = 'Convert-PngToWebp.ps1'
    createdAt = (Get-Date).ToString('o')
    outRoot   = $outRoot
    options   = [pscustomobject]@{ quality = $Quality; lossless = [bool]$Lossless }
    files     = @($allFiles.Values | Sort-Object dst)
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

# ---------- 报告 ----------
$inBytes = 0; $outBytes = 0
foreach ($r in $ok) {
    $inBytes += (Get-Item -LiteralPath $r.src).Length
    $outBytes += (Get-Item -LiteralPath $r.dst).Length
}
Write-Host ""
Write-Host ("完成：成功 {0}，失败 {1}，跳过 {2}，用时 {3:N1}s" -f $ok.Count, $failed.Count, $skipped.Count, $sw.Elapsed.TotalSeconds) -ForegroundColor Green
if ($inBytes -gt 0) {
    $ratio = 100.0 * $outBytes / $inBytes
    Write-Host ("体积：{0:N2} MB -> {1:N2} MB ({2:N1}%)" -f ($inBytes / 1MB), ($outBytes / 1MB), $ratio)
}
Write-Host "清单：$manifestPath"
Write-Host "回滚：.\Convert-PngToWebp.ps1 -Path '$Path' -OutDir '$outRoot' -Rollback"

if ($failed.Count -gt 0) {
    Write-Host ""
    Write-Host "失败明细：" -ForegroundColor Red
    $failed | ForEach-Object { Write-Host ("  {0}`n    {1}" -f $_.src, $_.error) -ForegroundColor Red }
    exit 1
}
