# PNG → WebP 批量转换脚本 — 调试记录

脚本：`Convert-PngToWebp.ps1`
环境：Windows PowerShell 5.1.26100 / Python 3.14.7 + Pillow 12.3.0（Pillow 内置 libwebp）

## 方案选择

机器上**没有** ImageMagick（`magick`）也没有 `cwebp`，GDI+ 自带的编码器列表里也没有 WebP
（只有 BMP/JPEG/GIF/TIFF/PNG）。检查后发现 Python + Pillow 的 `features.check('webp')` 返回 True，
所以选用 Pillow 作为转换引擎，通过一个内嵌的 Python 片段并行转换。

## 实际遇到的问题（共 9 个，均已修复）

### 1. 脚本被 PowerShell 5.1 当成 GBK 解析，语法报“一片红”
**现象**：`from concurrent.futures import ThreadPoolExecutor` 报
`The 'from' keyword is not supported in this version of the language`。

**排查**：用 `[System.Management.Automation.Language.Parser]::ParseInput()` 解析全文，
**0 个语法错误**——说明文件本身没问题。但 `powershell.exe -File` 却报错，差别就在读文件时的编码。

**根因**：PowerShell 5.1 的 `-File` 对**无 BOM** 的文件按系统 ANSI 代码页解读，而本机是 **936 (GBK)**。
脚本里的中文注释字节被误解，把后面的引号“吃掉”了，于是整个 here-string 结构错位。

**修复**：脚本必须存为 **UTF-8 with BOM**。验证方式：同样内容加 BOM 后立刻正常。

> 这条最容易踩，因为编辑器默认存无 BOM UTF-8，而 PS 5.1 会静默乱码，报错位置还完全误导。

### 2. `Join-Path` 拼接绝对路径产生畸形路径
**现象**：`GetFullPath` 抛 `The given path's format is not supported`，路径是
`D:\Code\...\D:\Code\...\testdata\_webp`。

**根因**：`Resolve-FullPath` 里无条件 `Join-Path (Get-Location).Path $p`，
当 `$p` 已经是绝对路径（默认 `-OutDir` 就是绝对路径）时，`Join-Path` 不会判定为已绝对而继续拼接。

**修复**：先用 `[System.IO.Path]::IsPathRooted()` 判断，绝对路径直接 `GetFullPath`。

### 3. PowerShell 5.1 `-Encoding UTF8` 写出的文件带 BOM，Python `json.load` 拒绝
**现象**：`json.decoder.JSONDecodeError: Unexpected UTF-8 BOM (decode using utf-8-sig)`。

**修复**：Python 侧改用 `encoding="utf-8-sig"`（能吃掉 BOM），并改用 .NET
`WriteAllText` + `UTF8Encoding($false)` 写无 BOM UTF-8，两边都稳。

### 4. 多行字符串用 `+` 拼接导致语法错误
**现象**：`Missing closing ')' in expression`，位置指向 `throw ("..."` 的下一行。

**根因**：PowerShell 里 `"字符串"` 换行后接 `+` 续行并不按预期工作（不像 C#）。

**修复**：改用数组 + `-join "`n"` 拼接，可读性也更好。

### 5. `-Encoding ASCII` 把中文路径变成 `??`
**现象**：中文目录的文件报
`OSError: [WinError 123] ... '...\_webp\?? ??'`，源路径显示为 `?? ??\?? ?.png`。

**根因**：为绕开第 3 条的 BOM 问题而用 `-Encoding ASCII`，结果中文字符全被替换成 `?`。
中文路径在传给 Python 之前就已经损坏了。

**修复**：改用 .NET `[System.IO.File]::WriteAllText(... , New-Object System.Text.UTF8Encoding($false))`
写**无 BOM 的 UTF-8**，中文路径完整保留。修复后中文/空格文件名转换成功。

### 6. `[string]$null` 在 PowerShell 里仍然是 `$null`
**现象**：`You cannot call a method on a null-valued expression`。

**根因**：`Get-Content -Raw` 读**空文件**返回 `$null`。而在 PowerShell 中
`[string]$null` **不会**变成空串，仍然是 `$null`，紧接着 `.Trim()` 直接崩。
（我第一版就是用 `[string]$(...)` 想强转，实测无效。）

**修复**：显式 `if ($null -eq $x) { $x = '' }` 兜底。

### 7. `ConvertTo-Json` 对单元素集合输出裸对象而非数组
**现象**：只剩 1 个文件待转换时，Python 报
`TypeError: string indices must be integers, not 'str'`。

**根因**：`$plan | ConvertTo-Json` 在 `$plan` 只有 1 个元素时，输出 `{...}` 而不是 `[{...}]`。
Python 侧 `for item in items` 遍历到的是字典的**键名字符串**。

**修复**：`ConvertTo-Json -InputObject @($plan)` 强制数组化，并额外断言 JSON 顶层以 `[` 开头。

> 这条只在“只剩 1 个文件”时触发，全量跑 8 个文件时完全正常——典型的边界 bug。

### 8. `-notlike '[*'` 里 `[` 是通配符语法
**现象**：`The specified wildcard character pattern is not valid: [*`。

**根因**：PowerShell 的 `-like/-notlike` 中 `[` 是字符类起始，单独出现是非法模式。

**修复**：改用 `.TrimStart().StartsWith('[')` 做纯字符串比较。

### 9. `2>&1` 吞掉 Python traceback
**现象**：只看到 `NativeCommandError` 和一行 `Traceback (most recent call last):`，真正的异常信息全丢。

**根因**：PowerShell 5.1 会把原生命令 stderr 的**每一行**包装成 `NativeCommandError` 错误记录，
多行 traceback 被拆散、淹没在错误流里。

**修复**：改用 `Start-Process -RedirectStandardOutput/-RedirectStandardError` 重定向到文件，
失败时把 stderr 全文拼进异常消息。这条不修的话，前面第 3、5、7 条根本没法定位。

## 验证结果

| 场景 | 结果 |
|---|---|
| 全量转换 8 个 PNG（含 RGBA / 调色板 / 灰度 / 中文空格名 / 大写扩展名） | 成功 7，失败 1 |
| 损坏的 PNG（伪造文件） | 正确报错并**继续处理其余文件**，退出码 1 |
| 目录结构镜像 | 完整保留（`sub/deep/`、`中文 目录/`） |
| 透明通道 | RGBA、调色板+transparency 均正确保留为 RGBA |
| 跳过已存在输出 | 第二次运行 0 转换，文件 mtime/size 完全未变 |
| 无损模式 | 解码后与源图**逐像素一致**（`ImageChops.difference` bbox 为 None） |
| 回滚 | 精确删除 7 个 .webp，源 PNG 一字节未动 |
| 边界：目录不存在 / 空目录 / 无 manifest 回滚 | 均为清晰中文提示，退出码 1 |

## 回滚方式

```powershell
# 方式一（推荐）：按 manifest 精确删除
.\Convert-PngToWebp.ps1 -Path <源目录> -Rollback

# 方式二：整个输出目录端掉（仅当 OutDir 是专用目录时）
Remove-Item <OutDir> -Recurse
```

安全护栏：回滚只删 **扩展名为 `.webp`** 且路径**在 OutDir 之内**、且**在 manifest 里出现过**的文件。
源 PNG 永远不会被触碰。

## 使用示例

```powershell
# 预览
.\Convert-PngToWebp.ps1 -Path .\assets -WhatIf

# 转换（默认输出到 .\assets\_webp，q=82）
.\Convert-PngToWebp.ps1 -Path .\assets

# 高压缩质量 + 8 线程
.\Convert-PngToWebp.ps1 -Path .\assets -Quality 90 -Jobs 8

# 无损
.\Convert-PngToWebp.ps1 -Path .\assets -Lossless
```
