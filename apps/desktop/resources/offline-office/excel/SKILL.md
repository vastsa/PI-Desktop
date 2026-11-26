---
name: Offline Excel
description: Read, analyze, create, edit a copy of, or explicitly recalculate an .xlsx workbook offline.
---

Use the normal authorized Bash tool in the active local workspace. Use only
paths the user authorized. Replace `SKILL_DIR` with the directory reported by
the Skill tool, quote every path and argument, and use a new filename for
every write. Never install dependencies or substitute a system interpreter.

- Read a sheet with pandas: `/bin/sh "SKILL_DIR/excel.sh" read "Source.xlsx" "Sheet1"`.
  The first row supplies column names; the JSON result contains `columns` and
  `data`. Elapsed durations are numeric seconds. Formula cells show the
  results already cached in the workbook.
- Create a new table with pandas: `/bin/sh "SKILL_DIR/excel.sh" create "New.xlsx" "Sheet1" < "rows.json"`.
  Supply a JSON array of row objects, such as `[{"Item":"A","Amount":150}]`.
  Inspect the new workbook with `read`.
- Save a copy after editing an existing plain value cell:
  `/bin/sh "SKILL_DIR/excel.sh" edit "Source.xlsx" "Edited.xlsx" "Sheet1" "B2" '160'`.
  The value is a JSON scalar; quote text as JSON (for example, `'"new text"'`).
  This preserves formulas, styles, and their existing cached results.
- Only when asked to recalculate, run `/bin/sh "SKILL_DIR/excel.sh" recalc "Edited.xlsx" "Recalculated.xlsx"`.
  This refreshes formula caches in a new copy using bundled LibreOffice.
  It supports workbook-local arithmetic and common functions such as `SUM`,
  `AVERAGE`, `COUNT`, `MIN`, `MAX`, and `IF`, including whole-row and
  whole-column ranges. External references, names,
  array formulas, iterative calculation, precision as displayed, and unsupported
  functions fail without writing a copy.

If an operation fails, report the error. Keep the original and any previously
saved copies unchanged.
