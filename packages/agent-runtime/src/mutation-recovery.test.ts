import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isPatchCommand, mutationFailureKey } from "./mutation-recovery.js";

describe("mutationFailureKey", () => {
  it("uses a stable lexical identity when the target does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-missing-edit-"));
    try {
      const expected = resolve(root, "missing", "example.ts");
      expect(await mutationFailureKey("missing/example.ts", root)).toBe(expected);
      expect(await mutationFailureKey("./missing/sub/../example.ts", root)).toBe(expected);
      expect(await mutationFailureKey(expected, root)).toBe(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("respects the directory's actual case sensitivity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-case-edit-"));
    try {
      await writeFile(join(root, "a.ts"), "lower\n");
      const caseSensitive = await stat(join(root, "A.ts")).then(
        () => false,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return true;
          throw error;
        },
      );
      if (caseSensitive) {
        await writeFile(join(root, "A.ts"), "upper\n");
        expect(await mutationFailureKey("a.ts", root)).not.toBe(await mutationFailureKey("A.ts", root));
      } else {
        expect(await mutationFailureKey("a.ts", root)).toBe(await mutationFailureKey("A.ts", root));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("preserves POSIX backslashes in file names", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-backslash-edit-"));
    try {
      await writeFile(join(root, "a\\b.ts"), "literal\n");
      expect(await mutationFailureKey("a\\b.ts", root)).toBe(join(await realpath(root), "a\\b.ts"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("isPatchCommand", () => {
  // #1985: the git check used to anchor `git` and `apply` to the same blob of
  // text, so any command that mentioned git and later carried the word apply
  // counted as a patch — three failed searches terminated the turn.
  it("does not count searches and other tools that merely mention apply", () => {
    expect(isPatchCommand("git log --oneline | grep apply")).toBe(false);
    expect(isPatchCommand("git pull && kubectl apply -f k8s/")).toBe(false);
    expect(isPatchCommand("git diff --stat; terraform apply")).toBe(false);
    expect(isPatchCommand("git grep apply")).toBe(false);
    expect(isPatchCommand("echo git apply p.diff")).toBe(false);
    expect(isPatchCommand("git log | grep apply | wc -l")).toBe(false);
    expect(isPatchCommand("git format-patch -1")).toBe(false);
    expect(isPatchCommand("echo apply_patch")).toBe(false);
    expect(isPatchCommand(42)).toBe(false);
    expect(isPatchCommand(undefined)).toBe(false);
  });

  it("still counts real patch invocations", () => {
    expect(isPatchCommand("git apply p.diff")).toBe(true);
    expect(isPatchCommand("git apply --check p.diff")).toBe(true);
    expect(isPatchCommand("git -C repo apply x.diff")).toBe(true);
    expect(isPatchCommand("git --git-dir .git apply x.diff")).toBe(true);
    expect(isPatchCommand("git --work-tree=/tmp apply x.diff")).toBe(true);
    expect(isPatchCommand("cd x && git apply p.diff")).toBe(true);
    expect(isPatchCommand("/usr/bin/git apply p.diff")).toBe(true);
    expect(isPatchCommand("env git apply p.diff")).toBe(true);
    expect(isPatchCommand("FOO=1 git apply p.diff")).toBe(true);
    expect(isPatchCommand("git status\ngit apply x.diff")).toBe(true);
    expect(isPatchCommand("git apply")).toBe(true);
    expect(isPatchCommand("apply_patch <<'EOF'\n*** Begin Patch\nEOF")).toBe(true);
    expect(isPatchCommand("env apply_patch <<'EOF'\nEOF")).toBe(true);
    expect(isPatchCommand("/opt/tools/apply_patch < p.diff")).toBe(true);
    expect(isPatchCommand("patch -p1 < p.diff")).toBe(true);
    expect(isPatchCommand("command patch -p1 < p.diff")).toBe(true);
    expect(isPatchCommand("cd x && patch -p1 < p.diff")).toBe(true);
  });

  it("keeps quoted option values whole so real patch commands still count", () => {
    // #2016 review: whitespace splitting ate a quoted option value's tail and
    // mistook it for the subcommand, so these real patch commands fell out of
    // the recovery budget entirely.
    expect(isPatchCommand('git -C "/tmp/my project" apply p.diff')).toBe(true);
    expect(isPatchCommand("git -C '/tmp/my project' apply p.diff")).toBe(true);
    expect(isPatchCommand('git -c core.sshCommand="ssh -i /tmp/key" apply p.diff')).toBe(true);
    expect(isPatchCommand("git -C /tmp/my\\ project apply p.diff")).toBe(true);
    expect(isPatchCommand('env "git" apply p.diff')).toBe(true);
  });

  it("does not split on operators inside quotes", () => {
    // The quoted `;` and `|` are argument text, not command boundaries: no
    // patch process runs in either command.
    expect(isPatchCommand('printf "%s" "hello; patch notes"')).toBe(false);
    expect(isPatchCommand('echo "patch"; git log | grep apply')).toBe(false);
    expect(isPatchCommand('git log --grep "a|b"')).toBe(false);
  });

  it("keeps empty quoted arguments as tokens", () => {
    // #2016 review round two: `git -C "" apply` is a real patch (git accepts
    // an empty -C value), so the empty argument must occupy the option-value
    // slot instead of vanishing and promoting `apply` into it. The mirror
    // control keeps an empty command word from promoting `patch`.
    expect(isPatchCommand('git -C "" apply p.diff')).toBe(true);
    expect(isPatchCommand('"" patch notes')).toBe(false);
  });

  it("treats heredoc bodies and comments as payload, not commands", () => {
    // #2016 review round two: heredoc data lines and comments used to become
    // command segments, so ordinary failures of these commands could still
    // trigger the false termination.
    expect(isPatchCommand("cat <<'EOF'\npatch notes\nEOF")).toBe(false);
    expect(isPatchCommand('printf "%s" x # ; patch notes')).toBe(false);
    expect(isPatchCommand("cat <<EOF\ngit apply p.diff\nEOF")).toBe(false);
    // The command line that opens the heredoc still counts, with or without
    // following body lines.
    expect(isPatchCommand("patch <<'EOF'\nbody\nEOF")).toBe(true);
    expect(isPatchCommand("apply_patch <<'EOF'\n*** Begin Patch\nEOF")).toBe(true);
  });

  it("matches heredoc delimiters exactly, stripping tabs only for <<-", () => {
    // #2016 review round three: `line.trim()` accepted a space-prefixed
    // delimiter, so ` EOF` ended the body early and the lines after it — the
    // real payload — became commands.
    expect(isPatchCommand("cat <<'EOF'\n EOF\nordinary text\npatch notes\nEOF")).toBe(false);
    expect(isPatchCommand("cat <<EOF\n\tEOF\npatch -p1 < x.diff")).toBe(false);
    // `<<-` is the one form whose delimiter may carry leading tabs.
    expect(isPatchCommand("cat <<-EOF\n\tbody\n\tEOF\npatch -p1 < x.diff")).toBe(true);
    expect(isPatchCommand("cat <<-'EOF'\n\tbody\n\tEOF\npatch notes")).toBe(true);
    // `<<-` strips tabs only: a space-prefixed delimiter still does not close.
    expect(isPatchCommand("cat <<-EOF\n body\n EOF\npatch notes\nEOF")).toBe(false);
  });

  it("reads the heredoc redirection word the way the shell does", () => {
    // #2016 review round five: `<< EOF` (a space before the word) and
    // `<<\EOF` (an escaped word) both name the same delimiter, and an empty
    // quoted word is still a word. Missing any of them made payload become
    // commands, or a real following patch disappear into a body.
    expect(isPatchCommand("cat << EOF\npatch notes\nEOF")).toBe(false);
    expect(isPatchCommand("cat <<\tEOF\npatch notes\nEOF")).toBe(false);
    expect(isPatchCommand("cat << EOF\nbody\nEOF\npatch -p1 < x.diff")).toBe(true);
    expect(isPatchCommand("cat <<-  EOF\n\tbody\n\tEOF\npatch notes")).toBe(true);
    expect(isPatchCommand("cat <<\\EOF\nhello\nEOF\npatch -p1 < x.diff")).toBe(true);
    expect(isPatchCommand("cat <<'EOF'\nhello\nEOF\npatch -p1 < x.diff")).toBe(true);
    expect(isPatchCommand('cat <<"EOF"\nhello\nEOF\npatch -p1 < x.diff')).toBe(true);
    // An empty quoted word: the body ends at an empty line, so text before it
    // is payload and text after it is a command.
    expect(isPatchCommand('cat <<""\npatch notes')).toBe(false);
    expect(isPatchCommand('cat <<""\n\npatch notes')).toBe(true);
  });

  it("queues every heredoc on the opening line before reading bodies", () => {
    // #2016 review round three: one stored tag made the parser treat the
    // second redirect as payload on the opening line, so `cat <<A <<B` never
    // consumed B's body and ordinary text after A became commands.
    expect(isPatchCommand("cat <<A <<B\nA\nordinary text\npatch notes\nB")).toBe(false);
    expect(isPatchCommand("cat <<A <<B\nA\nB\npatch notes")).toBe(true);
    // The opening line is not body: a patch after `;` on it still executes.
    expect(isPatchCommand("cat <<EOF; git apply p.diff\nbody\nEOF")).toBe(true);
    expect(isPatchCommand("cat <<A <<B; patch -p1 < x.diff\nA\nB")).toBe(true);
    // Both spellings of the first tag still queue with a later one.
    expect(isPatchCommand("cat <<-'A' <<\"B\"\n\tbody\n\tA\nB\npatch notes")).toBe(true);
  });
});
