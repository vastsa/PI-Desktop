---
name: Offline Word
description: Create, extract, or save a copy of a .docx document without internet access.
---

Use the normal authorized Bash tool in the active local workspace. Use only paths
the user authorized. Use the skill directory reported by the Skill tool in place
of `SKILL_DIR`; quote every path and argument. Keep the working directory in the
project. Use a new output filename for every write.

- Create: `/bin/sh "SKILL_DIR/word.sh" create "New document.docx" "Title" < "body.txt"`.
  Supply UTF-8 plain text on stdin, one paragraph per line. Use the workspace
  Write tool to prepare the body if needed. Creation uses bundled Node docx.
- Extract main document text, including tables: `/bin/sh "SKILL_DIR/word.sh" extract "Source document.docx"`.
- Save a copy while replacing one literal occurrence within a paragraph:
  `/bin/sh "SKILL_DIR/word.sh" replace "Source document.docx" "Edited copy.docx" "old text" "new text"`.
  Inspect the output after editing. Replacement text takes the style of the
  first matched run. For an absent or repeated match, ask for a unique edit.

If the command fails, report its error. Never fall back to another interpreter,
install dependencies, access a network, or edit the source in place.
