import assert from "node:assert/strict";

export function verifyPdfSkillRecipes(content) {
  // Check the loaded examples; only the fixture's reviewed Python runs in Bash.
  const examples = Array.from(content.matchAll(/^```python[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm),
    ([, code]) => code.replace(/^[ \t]*#.*$/gm, ""));
  const readers = examples.filter((code) => /\bpypdf\.PdfReader\s*\(/.test(code));
  assert.ok(readers.some((code) => /\.extract_text\s*\(/.test(code)), "PDF Skill is missing its pypdf text extraction recipe.");
  assert.ok(readers.some((code) => /\bpypdf\.PdfWriter\s*\(/.test(code) &&
    /\.add_page\s*\(/.test(code) && /\.write\s*\(/.test(code)),
  "PDF Skill is missing its pypdf ordered merge recipe.");
}
