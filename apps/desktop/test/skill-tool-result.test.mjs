import assert from "node:assert/strict";
import test from "node:test";

import { formatSkillToolContent } from "../electron/main/skill-document.ts";

test("Skill tool content identifies the document and its reference directory", () => {
  const content = formatSkillToolContent({
    id: "redmine",
    name: "Redmine",
    location: "/Users/example/.agents/skills/redmine/SKILL.md",
    body: "Read `SECRET.md` from this skill directory.",
  });

  assert.match(content, /Location: \/Users\/example\/\.agents\/skills\/redmine\/SKILL\.md/);
  assert.match(content, /References are relative to \/Users\/example\/\.agents\/skills\/redmine\./);
  assert.ok(content.endsWith("Read `SECRET.md` from this skill directory."));
});
