"""Exercise project case-alias upgrade and deletion against a real native Host.

Usage: python scripts/e2e-project-path-case.py HOST [--aie] [--expect-bug]
Only a temporary profile and synthetic conversations are used.
"""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import queue
import sqlite3
import subprocess
import tempfile
import threading


class Host:
    def __init__(self, binary, profile):
        env = dict(os.environ, PI_DESKTOP_DATA_DIR=str(profile), AIE_DATA_DIR=str(profile))
        self.process = subprocess.Popen(
            [binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", env=env,
        )
        self.lines = queue.Queue()
        threading.Thread(target=self.read, daemon=True).start()
        try:
            self.call("app.handshake", protocolVersion=11)
        except BaseException:
            self.close()
            raise

    def read(self):
        for line in self.process.stdout:
            self.lines.put(json.loads(line))
        self.lines.put(None)

    def call(self, method, **params):
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 1,
                                            "method": method, "params": params}) + "\n")
        self.process.stdin.flush()
        while True:
            message = self.lines.get(timeout=45)
            if message is None:
                self.process.wait(timeout=10)
                raise AssertionError(f"Host exited: {self.process.returncode}: {self.process.stderr.read()[-1500:]}")
            if message.get("id") == 1:
                assert "error" not in message, message
                return message["result"]

    def close(self):
        self.process.terminate()
        self.process.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host")
    parser.add_argument("--aie", action="store_true")
    parser.add_argument("--expect-bug", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="project-case-2148-") as temporary:
        root = Path(temporary).resolve()
        folder = root / "Alpha"
        folder.mkdir()
        alias = str(root / "alpha").replace("\\", "/")
        assert (root / "alpha").is_dir(), "Run on a case-insensitive filesystem"
        profile = root / "profile"
        host = Host(args.host, profile)
        try:
            first = host.call("session.create", title="Alias conversation", projectPath=str(folder))["session"]["id"]
            second = host.call("session.create", title="Canonical conversation", projectPath=str(folder))["session"]["id"]
            other = root / "Other"
            other.mkdir()
            unrelated = host.call("session.create", title="Unrelated", projectPath=str(other))["session"]["id"]
            for session_id in (first, second, unrelated):
                host.call("session.appendMessage", sessionId=session_id,
                          message={"id": session_id + "-message", "role": "user", "content": "Synthetic fixture", "createdAt": "2026-11-06T00:00:00Z"})
        finally:
            host.close()
        transcripts = {sid: (profile / "sessions" / (sid + ".jsonl")).read_bytes()
                       for sid in (first, second, unrelated)}
        database = profile / "pi.sqlite"
        with closing(sqlite3.connect(database)) as conn:
            canonical_id, canonical = conn.execute("SELECT id,path FROM projects WHERE id=(SELECT project_id FROM sessions WHERE id=?)", (second,)).fetchone()
            assert canonical != alias, (canonical, alias)
            conn.execute("INSERT INTO projects(path,name,created_at,last_opened_at) VALUES(?,?,1,1)", (alias, "Alias"))
            alias_id = conn.execute("SELECT id FROM projects WHERE path=?", (alias,)).fetchone()[0]
            conn.execute("UPDATE sessions SET project_id=? WHERE id=?", (alias_id, first))
            if not args.expect_bug:
                conn.execute("PRAGMA user_version=" + str(33 if args.aie else 27))
            conn.commit()
        host = Host(args.host, profile)
        try:
            projects = host.call("projects.list")["projects"]
            matching = [p for p in projects if p["path"].lower() == canonical.lower()]
            print("Rows after reopen:", [(p["id"], p["path"]) for p in matching], flush=True)
            with closing(sqlite3.connect(database)) as conn:
                owners = dict(conn.execute("SELECT id,project_id FROM sessions WHERE id IN (?,?)", (first, second)))
            if args.expect_bug:
                assert len(matching) == 2, matching
            else:
                assert len(matching) == 1, "Duplicate logical projects survived upgrade"
                assert len(owners) == 2 and len(set(owners.values())) == 1, owners
                for sid in (first, second):
                    assert (profile / "sessions" / (sid + ".jsonl")).read_bytes() == transcripts[sid]
            result = host.call("projects.delete" if args.aie else "projects.remove", path=alias)
            with closing(sqlite3.connect(database)) as conn:
                remaining = dict(conn.execute("SELECT id,project_id FROM sessions"))
                rows = list(conn.execute("SELECT id,path FROM projects"))
            print("Delete result:", result, flush=True)
            print("Alias survived:", first in remaining, "canonical survived:", second in remaining, flush=True)
            assert unrelated in remaining, "An unrelated conversation was deleted"
            assert (profile / "sessions" / (unrelated + ".jsonl")).read_bytes() == transcripts[unrelated]
            assert folder.is_dir(), "Physical project directory was deleted"
            if args.expect_bug:
                assert first in remaining and second not in remaining, remaining
                assert any(p == alias for _, p in rows), rows
                print("CONFIRMED #2148: alias row survived; canonical conversation was deleted", flush=True)
            else:
                assert first not in remaining and second not in remaining, remaining
                assert not any(p.lower() == canonical.lower() for _, p in rows), rows
                for sid in (first, second):
                    assert not (profile / "sessions" / (sid + ".jsonl")).exists()
                print("PASS #2148: upgrade preserved both conversations; explicit deletion removed the unified project", flush=True)
        finally:
            host.close()


if __name__ == "__main__":
    main()
