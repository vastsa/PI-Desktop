import os
import shutil
import signal
import socket
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


class PdfCommands(unittest.TestCase):
    def test_cancelling_export_removes_partial_files_and_leaves_source_unchanged(self):
        with TemporaryDirectory(prefix="pie-pdf-", dir="/tmp") as directory:
            root = Path(directory)
            work = root / "project"
            work.mkdir()
            source = work / "源 文件.docx"
            source.write_bytes(b"original")
            output = work / "另存 文件.pdf"

            plugin = root / "plugins/pie.offline-office"
            shutil.copytree(Path(__file__).resolve().parents[1] / "resources/offline-office", plugin)
            runtime = root / "office-runtime"
            python = runtime / "python/bin/python3.12"
            python.parent.mkdir(parents=True)
            python.symlink_to(sys.executable)
            soffice = runtime / "libreoffice/program/soffice"
            soffice.parent.mkdir(parents=True)
            fixture = root / "office.py"
            fixture.write_text("""import socket
import sys
from pathlib import Path

outdir = Path(sys.argv[sys.argv.index("--outdir") + 1])
(outdir / "partial.pdf").write_bytes(b"partial export")
with socket.socket(socket.AF_UNIX) as socket:
    socket.connect(sys.argv[1])
    socket.sendall(b"R")
    socket.recv(1)
""", encoding="utf-8")
            ready = root / "office.sock"
            soffice.write_text(
                f'#!/bin/sh\nexec "{sys.executable}" "{fixture}" "{ready}" "$@"\n', encoding="utf-8",
            )
            soffice.chmod(0o755)

            with socket.socket(socket.AF_UNIX) as listener:
                listener.bind(str(ready))
                listener.listen()
                listener.settimeout(10)
                with subprocess.Popen(
                    ["/bin/sh", str(plugin / "pdf/pdf.sh"), "export", "--", str(source), str(output)],
                    cwd=work, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                ) as command:
                    try:
                        connection, _ = listener.accept()
                        with connection:
                            connection.settimeout(5)
                            self.assertEqual(connection.recv(1), b"R")
                            os.killpg(command.pid, signal.SIGKILL)
                            _, error = command.communicate(timeout=10)
                            self.assertEqual(command.returncode, -signal.SIGKILL, error)
                            self.assertEqual(connection.recv(1), b"", "LibreOffice survived after cancellation.")
                    finally:
                        if command.poll() is None:
                            os.killpg(command.pid, signal.SIGKILL)

            self.assertEqual(list(work.iterdir()), [source])
            self.assertEqual(source.read_bytes(), b"original")


if __name__ == "__main__":
    unittest.main()
