import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile

SCRIPT = Path(__file__).resolve().parents[1] / "resources/offline-office/word/document.py"
TRANSITIONAL = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
STRICT = "http://purl.oclc.org/ooxml/wordprocessingml/main"


def body(namespace, runs):
    return f'<w:document xmlns:w="{namespace}"><w:body><w:p>{runs}</w:p></w:body></w:document>'


class WordTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        workspace = Path(temporary.name)
        self.source = workspace / "原始 文档.docx"
        self.output = workspace / "另存 副本.docx"

    def write_doc(self, runs, namespace=TRANSITIONAL, part="word/document.xml", mode="Internal"):
        relation = ("http://purl.oclc.org/ooxml/officeDocument/relationships" if namespace == STRICT
                    else "http://schemas.openxmlformats.org/officeDocument/2006/relationships")
        with ZipFile(self.source, "w") as archive:
            archive.writestr("_rels/.rels",
                             '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                             f'<Relationship Id="rId1" Type="{relation}/officeDocument" Target="/{part}" TargetMode="{mode}"/>'
                             '</Relationships>')
            archive.writestr(part, body(namespace, runs))
            if part != "word/document.xml":
                archive.writestr("word/document.xml", body(TRANSITIONAL, "<w:r><w:t>未引用</w:t></w:r>"))

    def word(self, operation, *args, source=None):
        return subprocess.run([sys.executable, "-B", "-X", "utf8", SCRIPT, operation,
                               source or self.source, *args], capture_output=True, text=True)

    def test_extract_and_replace_respect_position_tab(self):
        self.write_doc('<w:r><w:t>甲</w:t></w:r><w:r><w:ptab w:alignment="center" w:relativeTo="margin" w:leader="none"/>'
                       '</w:r><w:r><w:t>乙</w:t></w:r>')
        result = self.word("extract")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "甲\t乙\n")
        self.assertNotEqual(self.word("replace", self.output, "甲乙", "丙").returncode, 0)
        self.assertFalse(self.output.exists())

    def test_extract_and_replace_follow_the_main_part_relationship(self):
        for namespace in [TRANSITIONAL, STRICT]:
            with self.subTest(namespace=namespace):
                self.output.unlink(missing_ok=True)
                part = "word/main%20document.xml"
                self.write_doc("<w:r><w:t>真实正文</w:t></w:r>", namespace, part)
                original = self.source.read_bytes()
                result = self.word("extract")
                self.assertEqual((result.returncode, result.stdout), (0, "真实正文\n"), result.stderr)
                result = self.word("replace", self.output, "真实", "修改")
                self.assertEqual(result.returncode, 0, result.stderr)
                with ZipFile(self.source) as before, ZipFile(self.output) as after:
                    self.assertIn("修改正文".encode(), after.read(part))
                    for member in ["_rels/.rels", "word/document.xml"]:
                        self.assertEqual(before.read(member), after.read(member))
                self.assertEqual(self.source.read_bytes(), original)

    def test_rejects_a_non_internal_main_part(self):
        self.write_doc("<w:r><w:t>正文</w:t></w:r>", mode="External")
        result = self.word("extract")
        self.assertNotEqual(result.returncode, 0)

    def test_refuses_to_overwrite_the_original_or_an_existing_copy(self):
        self.write_doc("<w:r><w:t>原文</w:t></w:r>")
        original = self.source.read_bytes()
        self.output.write_bytes(b"existing copy")
        for output, expected in [(self.source, original), (self.output, b"existing copy")]:
            with self.subTest(output=output):
                result = self.word("replace", output, "原文", "修改")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Output already exists", result.stderr)
                self.assertEqual(output.read_bytes(), expected)
                self.assertEqual(self.source.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
