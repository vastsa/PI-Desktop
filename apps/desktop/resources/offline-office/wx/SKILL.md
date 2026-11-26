---
name: Offline WX Document Formatting
description: Convert Markdown or DOCX to the WX template and audit the result, or score an existing DOCX and report formatting fixes. Runs offline.
---

Use the normal authorized Bash tool in the active local workspace. Replace
`SKILL_DIR` with the directory reported by the Skill tool. Quote every path and
use only user-authorized paths. Choose a new output directory under an existing
authorized directory; the source is read-only.

- Format and audit: `/bin/sh "SKILL_DIR/wx.sh" convert "Source.md" "WX output"`.
  Markdown and DOCX inputs are accepted. Read `public_summary` in
  `WX output/audit.json` if present. Return `WX output/formatted.docx` with
  the audit result only if the command succeeds. For
  `completed_with_warnings`, list the affected audits and diagnostic codes.
  If delivery is blocked or manual review is required, report the reason,
  diagnostic codes and review items from the report. Do not deliver the
  DOCX as a finished document or mark manual checks complete.
- Review without converting: `/bin/sh "SKILL_DIR/wx.sh" review "Source.docx" "WX review"`.
  Read `WX review/review.md` and report the score and recommended fixes.

These are ordinary WX modes. Report command errors; do not install dependencies,
use a different interpreter, use the network, or edit the input in place.
