---
name: PowerShell Encoding
description: Use when creating, editing, generating or reviewing any .ps1 file in this repository — PowerShell scripts must be saved as UTF-8 with BOM whenever they contain non-ASCII text.
---

# PowerShell script encoding

**Rule:** every PowerShell script (`.ps1`) in this repository that contains
non-ASCII characters — typically a Chinese comment, string literal, or
`#requires` block — must be saved as **UTF-8 with BOM**.

Pure-ASCII scripts need no BOM. UTF-16 is never acceptable.

This is a hard rule, not a style preference. Violating it silently corrupts the
file on the machines this project targets.

## Why

Windows PowerShell 5.1 — still the default `powershell.exe` on supported
Windows versions — decides how to read a script *before* parsing it:

| File starts with | PowerShell 5.1 decodes it as |
| --- | --- |
| UTF-8 BOM (`EF BB BF`) | UTF-8 ✅ |
| UTF-16 LE/BE BOM | UTF-16 ✅ |
| no BOM | **the system ANSI code page** ⚠️ |

On a Chinese Windows install that code page is **936 (GBK)**. Every non-ASCII
byte in the file is then decoded as garbage.

The failure is nasty because it happens *before* the parser runs, so the damage
surfaces far from the real cause:

- A `#` comment containing Chinese text can swallow the quote that terminates
  the next string, so a later here-string or `param()` block collapses.
- The reported errors name English identifiers and point at the wrong line
  numbers, so the encoding problem is easy to misdiagnose as a syntax bug.
- The file still parses fine under PowerShell 7 (`pwsh`) and in editors, so
  tests can pass locally while `powershell.exe -File` fails for users.

Observed in this repository: a script with Chinese comments and a BOM was
reported as
`The 'from' keyword is not supported in this version of the language`
— a parse error inside an embedded Python block, three hundred lines away from
the actual cause. Adding the BOM fixed it with no other change.

## Do

- Save `.ps1` files as **UTF-8 with BOM** (`UTF-8 with signature` in VS Code,
  `utf-8-sig` in Python, `UTF8Encoding($true)` in .NET).
- Keep the BOM when you edit an existing script — many editors and
  "normalize encoding" tools strip it on save.
- When generating a script from another language, write the BOM explicitly:

  ```powershell
  # PowerShell: preserve an existing file's text, re-add the BOM
  $p = 'tools\build.ps1'
  $text = [System.IO.File]::ReadAllText($p)
  [System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($true)))
  ```

  ```python
  # Python
  with open(path, "w", encoding="utf-8-sig", newline="\r\n") as f:
      f.write(script)
  ```

  ```js
  // Node
  import { writeFileSync } from "node:fs";
  writeFileSync(path, "\uFEFF" + script, "utf8");
  ```

## Do not

- Do not "fix" an encoding problem by switching to `-Encoding ASCII` in
  `Set-Content`/`Out-File`. That replaces every non-ASCII character with `?`,
  destroying Chinese paths and comments. Write UTF-8 without a BOM only for
  files consumed by tools that reject a BOM, and use `utf-8-sig` on the reading
  side when you do.
- Do not save `.ps1` as UTF-16. `pwsh` and `powershell.exe` handle it
  inconsistently, and most tooling expects UTF-8.
- Do not assume a passing `pwsh` run proves the script works for users. Test the
  actual host (`powershell.exe`) when the script has non-ASCII content.

## Enforcement

```bash
pnpm check:powershell-encoding
# or
node scripts/check-powershell-encoding.mjs
```

The gate fails when a scanned `.ps1`:

1. is not valid UTF-8 (for example legacy GBK), or
2. contains non-ASCII bytes but has no UTF-8 BOM, or
3. is UTF-16 encoded.

It skips build output and dependencies (`node_modules`, `dist`, `release`,
`target`, `.git`, and similar) so only authored scripts are checked.

## Related notes

- When a script passes a non-ASCII path to a child process, write any
  intermediate manifest/plan file as **UTF-8 without BOM** via
  `[System.IO.File]::WriteAllText` with `UTF8Encoding($false)`. PowerShell 5.1's
  `-Encoding UTF8` adds a BOM that strict parsers (Go, some JSON readers) reject.
  The distinction: *the script itself needs the BOM; data files it writes to
  other tools often must not have one.*
- `powershell.exe` wraps each line of a native command's stderr in a
  `NativeCommandError` record, which shreds multi-line tracebacks. Redirect to
  files with `Start-Process -RedirectStandardError` when diagnosing failures.
