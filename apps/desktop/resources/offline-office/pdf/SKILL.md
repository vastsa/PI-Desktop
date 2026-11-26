---
name: Offline PDF
description: Extract text from a PDF, merge PDFs in order, or export an existing .docx, .pptx, or .xlsx file to PDF offline.
---

Use the normal authorized Bash tool in the active local workspace. Use
only paths the user authorized. Replace `SKILL_DIR` with the directory
reported by the Skill tool and quote every path.

- Extract text by page: `/bin/sh "SKILL_DIR/pdf.sh" extract -- "Source.pdf"`.
  There is no OCR. Encrypted PDFs are unsupported.
- Merge all pages in the listed file order:
  `/bin/sh "SKILL_DIR/pdf.sh" merge -- "Merged.pdf" "First.pdf" "Second.pdf"`.
- Export an existing Word, PowerPoint, or Excel file with bundled LibreOffice:
  `/bin/sh "SKILL_DIR/pdf.sh" export -- "Source.docx" "Copy.pdf"`.
  Use the same command for `.pptx` and `.xlsx`. Verify the result with
  `extract` when you expect searchable text.

Choose a new output file for every write. Never overwrite originals,
install dependencies, or fall back to system tools. If an operation fails,
report the error.
