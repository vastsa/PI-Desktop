import json
import os
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import unittest
import warnings
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font


SOURCE = "原始 样例.xlsx"
NEW = "新建 样例.xlsx"
EDITED = "另存 样例.xlsx"
RECALCULATED = "重算 样例.xlsx"
SHEET = "销售 数据"
ROWS = [{"项目": "甲", "金额": 150}, {"项目": "乙", "金额": 100}]


def make_fixture(directory):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = SHEET
    sheet.append(["项目", "金额", "合计", "工时", "整列合计"])
    sheet.append(["甲", 150, "=SUM(B2:B3)", timedelta(hours=27, minutes=30), "=SUM(B:B)"])
    sheet["D2"].number_format = "[h]:mm:ss"
    sheet.append(["乙", 100])
    sheet["B2"].number_format = "0.00"
    sheet["C2"].font = Font(bold=True)
    workbook.create_sheet("另一 工作表")["A1"] = "保留 中文"
    with TemporaryDirectory() as scratch:
        intermediate = Path(scratch) / "without-cache.xlsx"
        workbook.save(intermediate)
        with ZipFile(intermediate) as original, ZipFile(directory / SOURCE, "w") as cached:
            for part in original.namelist():
                data = original.read(part)
                if part == "xl/worksheets/sheet1.xml":
                    for formula in [b"SUM(B2:B3)", b"SUM(B:B)"]:
                        empty = b"<f>" + formula + b"</f><v></v>"
                        assert empty in data
                        data = data.replace(empty, empty.replace(b"<v></v>", b"<v>250</v>"))
                cached.writestr(part, data)
    (directory / "rows.json").write_text(json.dumps(ROWS, ensure_ascii=False), encoding="utf-8")


def verify_copy(directory, filename, amount, total):
    path = directory / filename
    workbook = load_workbook(path)
    assert workbook.sheetnames == [SHEET, "另一 工作表"]
    assert workbook[SHEET]["B2"].value == amount
    assert workbook[SHEET]["B2"].number_format == "0.00"
    assert workbook[SHEET]["C2"].value == "=SUM(B2:B3)"
    assert workbook[SHEET]["C2"].font.bold
    assert workbook["另一 工作表"]["A1"].value == "保留 中文"
    assert workbook[SHEET]["D2"].value == timedelta(hours=27, minutes=30)
    assert workbook[SHEET]["E2"].value == "=SUM(B:B)"
    cached = load_workbook(path, data_only=True)[SHEET]
    assert cached["C2"].value == cached["E2"].value == total


class ExcelCommands(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.workspace = self.root / "project"
        self.workspace.mkdir()
        make_fixture(self.workspace)
        self.original = (self.workspace / SOURCE).read_bytes()
        self.launcher = self.root / "plugins/pie.offline-office/excel/excel.sh"
        source = Path(__file__).resolve().parents[1] / "resources/offline-office/excel"
        shutil.copytree(source, self.launcher.parent)
        shutil.copyfile(source.parent / "office_document.py", self.launcher.parents[1] / "office_document.py")
        self.runtime = self.root / "office-runtime"
        self.install_tool("python/bin/python3.12", sys.executable)

    def install_tool(self, relative, executable, *args):
        file = self.runtime / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(f'#!/bin/sh\nexec {shlex.join([executable, *args])} "$@"\n', encoding="utf-8")
        file.chmod(0o755)

    def excel(self, *args, body=None, error=None):
        result = subprocess.run(
            ["/bin/sh", str(self.launcher), *args], cwd=self.workspace, text=True,
            input=body, capture_output=True, env={**os.environ, "PATH": ""}, timeout=40,
        )
        if error is not None:
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn(error, result.stderr)
        else:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_create_and_read_a_table(self):
        self.excel("create", NEW, SHEET, body=json.dumps(ROWS, ensure_ascii=False))
        self.assertEqual(json.loads(self.excel("read", NEW, SHEET))["data"], [["甲", 150], ["乙", 100]])
        self.assertEqual(load_workbook(self.workspace / NEW)[SHEET]["B2"].value, 150)

    def test_edit_keeps_the_formula_cache_and_refuses_overwriting(self):
        self.excel("edit", SOURCE, EDITED, SHEET, "B2", "160")
        verify_copy(self.workspace, EDITED, 160, 250)
        with ZipFile(self.workspace / SOURCE) as original, ZipFile(self.workspace / EDITED) as saved:
            self.assertEqual(original.namelist(), saved.namelist())
            for name in original.namelist():
                if name != "xl/worksheets/sheet1.xml":
                    self.assertEqual(original.read(name), saved.read(name), name)
        self.excel("edit", SOURCE, SOURCE, SHEET, "B2", "0", error="Output already exists")
        self.excel("create", EDITED, SHEET, body=json.dumps(ROWS), error="Output already exists")
        self.assertEqual((self.workspace / SOURCE).read_bytes(), self.original)
        verify_copy(self.workspace, EDITED, 160, 250)

    def test_recalculate_only_changes_the_new_copy(self):
        executable = shutil.which("soffice")
        if executable is None:
            self.skipTest("LibreOffice is available in the Office Runtime, not this host.")
        self.install_tool("libreoffice/program/soffice", executable)
        self.excel("edit", SOURCE, EDITED, SHEET, "B2", "160")
        self.excel("recalc", EDITED, RECALCULATED)
        verify_copy(self.workspace, EDITED, 160, 250)
        verify_copy(self.workspace, RECALCULATED, 160, 260)
        self.assertEqual((self.workspace / SOURCE).read_bytes(), self.original)

    def assert_recalculation_stops_descendants(self, *, cancel):
        ready = self.root / "calc.sock"
        fixture = self.root / "calc.py"
        fixture.write_text("""import socket
import subprocess
import sys

if sys.argv[1] == "worker":
    with socket.socket(socket.AF_UNIX) as connection:
        connection.connect(sys.argv[2])
        connection.sendall(b"R")
        connection.recv(1)
else:
    subprocess.run([sys.executable, __file__, "worker", sys.argv[1]], check=True)
""", encoding="utf-8")
        self.install_tool("libreoffice/program/soffice", sys.executable, str(fixture), str(ready))
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(ready))
            listener.listen()
            listener.settimeout(10)
            with subprocess.Popen(
                ["/bin/sh", str(self.launcher), "recalc", SOURCE, RECALCULATED],
                cwd=self.workspace, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                start_new_session=True,
            ) as command:
                try:
                    connection, _ = listener.accept()
                    with connection:
                        connection.settimeout(5)
                        self.assertEqual(connection.recv(1), b"R")
                        if cancel:
                            os.killpg(command.pid, signal.SIGKILL)
                        _, stderr = command.communicate(timeout=35)
                        self.assertNotEqual(command.returncode, 0)
                        if not cancel:
                            self.assertIn("timed out", stderr)
                        try:
                            self.assertEqual(connection.recv(1), b"")
                        except TimeoutError:
                            self.fail("Calc worker survived after recalculation stopped.")
                finally:
                    if command.poll() is None:
                        os.killpg(command.pid, signal.SIGKILL)
        self.assertFalse((self.workspace / RECALCULATED).exists())
        self.assertEqual((self.workspace / SOURCE).read_bytes(), self.original)

    def test_recalculate_timeout_stops_descendants(self):
        self.assert_recalculation_stops_descendants(cancel=False)

    def test_bash_cancellation_stops_recalculation_descendants(self):
        self.assert_recalculation_stops_descendants(cancel=True)

    def test_recalculate_whole_columns_and_rows(self):
        executable = shutil.which("soffice")
        if executable is None:
            self.skipTest("LibreOffice is available in the Office Runtime, not this host.")
        self.install_tool("libreoffice/program/soffice", executable)
        workbook = Workbook()
        workbook.active.append([150, 100])
        workbook.active.append([110])
        formulas = ["=SUM(A:A)", "=SUM($1:$1)", "=SUM('另一 工作表'!$A:$B)"]
        workbook.active.append([None, *formulas])
        workbook.create_sheet("另一 工作表").append([10, 20])
        source = self.workspace / "汇总.xlsx"
        workbook.save(source)
        before = source.read_bytes()
        self.excel("recalc", source.name, RECALCULATED)
        saved = self.workspace / RECALCULATED
        self.assertEqual([cell.value for cell in load_workbook(saved, data_only=True).active[3][1:]], [260, 250, 30])
        self.assertEqual([cell.value for cell in load_workbook(saved).active[3][1:]], formulas)
        self.assertEqual(source.read_bytes(), before)

    def test_recalculate_updates_text_errors_and_cross_sheet_references(self):
        executable = shutil.which("soffice")
        if executable is None:
            self.skipTest("LibreOffice is available in the Office Runtime, not this host.")
        self.install_tool("libreoffice/program/soffice", executable)
        workbook = Workbook()
        workbook.create_sheet("销售 数据")["A1"] = 260
        workbook.active.append(['=IF(\'销售 数据\'!A1=260,"正确","错误")', "=1/0", "=1=1"])
        # Display formatting must not change the underlying Excel serials.
        workbook.active.append([60, "=A2+1"])
        workbook.active["A2"].number_format = "yyyy-mm-dd"
        workbook.active.append([0.123456789, "=A3*86400"])
        workbook.active["A3"].number_format = "hh:mm:ss"
        source = self.workspace / "跨表.xlsx"
        workbook.save(source)
        self.excel("recalc", source.name, RECALCULATED)
        result = load_workbook(self.workspace / RECALCULATED, data_only=True).active
        self.assertEqual([result[ref].value for ref in ["A1", "B1", "C1"]], ["正确", "#DIV/0!", True])
        self.assertEqual(result["B2"].value, 61)
        self.assertAlmostEqual(result["B3"].value, 10666.6665696, places=6)

    def test_recalculate_preserves_excel_shared_formulas(self):
        executable = shutil.which("soffice")
        if executable is None:
            self.skipTest("LibreOffice is available in the Office Runtime, not this host.")
        self.install_tool("libreoffice/program/soffice", executable)
        workbook = Workbook()
        workbook.active.append([150, 100, "=SUM(A1:B1)"])
        workbook.active.append([160, 100, "=SUM(A2:B2)"])
        ordinary = self.workspace / "ordinary.xlsx"
        source = self.workspace / "shared.xlsx"
        workbook.save(ordinary)
        with ZipFile(ordinary) as original, ZipFile(source, "w") as shared:
            for part in original.namelist():
                contents = original.read(part)
                if part == "xl/worksheets/sheet1.xml":
                    contents = (contents.replace(b"<f>SUM(A1:B1)</f>", b'<f t="shared" ref="C1:C2" si="0">SUM(A1:B1)</f>')
                                .replace(b"<f>SUM(A2:B2)</f>", b'<f t="shared" si="0"/>'))
                shared.writestr(part, contents)
        self.excel("recalc", source.name, RECALCULATED)
        result = load_workbook(self.workspace / RECALCULATED, data_only=True).active
        self.assertEqual([result[ref].value for ref in ["C1", "C2"]], [250, 260])
        self.assertEqual(load_workbook(self.workspace / RECALCULATED).active["C2"].value, "=SUM(A2:B2)")

    def test_json_text_is_not_written_as_a_formula(self):
        self.excel("create", NEW, SHEET, body='[{"Text": "=SUM(1,2)"}]')
        self.excel("edit", SOURCE, EDITED, SHEET, "A2", '"=SUM(1,2)"')
        for path, coordinate in [(NEW, "A2"), (EDITED, "A2")]:
            cell = load_workbook(self.workspace / path)[SHEET][coordinate]
            self.assertEqual((cell.value, cell.data_type), ("=SUM(1,2)", "s"))

    def test_read_preserves_text_ids_and_numeric_precision(self):
        workbook = Workbook()
        workbook.active.append(["id", "value", "status"])
        workbook.active.append(["00123", 0.12345678912345, "#DIV/0!"])
        workbook.active.append(["00090", 0.0000000000004])
        source = self.workspace / "precision.xlsx"
        workbook.save(source)
        data = json.loads(self.excel("read", source.name, workbook.active.title))["data"]
        self.assertEqual(data, [["00123", 0.12345678912345, "#DIV/0!"], ["00090", 0.0000000000004, ""]])

    def test_read_returns_elapsed_durations_in_seconds(self):
        workbook = Workbook()
        workbook.active.append(["task", "duration"])
        for name, duration in [("工时", timedelta(hours=27, minutes=30)), ("调整", -timedelta(seconds=0.5))]:
            workbook.active.append([name, duration])
            workbook.active.cell(workbook.active.max_row, 2).number_format = "[h]:mm:ss.000"
        source = self.workspace / "工时.xlsx"
        workbook.save(source)
        table = json.loads(self.excel("read", source.name, workbook.active.title))
        self.assertEqual(table, {"columns": ["task", "duration"], "data": [["工时", 99000], ["调整", -0.5]]})

    def test_rejects_dtd_in_a_workbook_before_reading_or_copying(self):
        source = self.workspace / "untrusted.xlsx"
        with ZipFile(self.workspace / SOURCE) as original, ZipFile(source, "w") as modified:
            for part in original.namelist():
                contents = original.read(part)
                if part == "xl/worksheets/sheet1.xml":
                    contents = b'<!DOCTYPE worksheet [<!ENTITY unwanted "text">]>' + contents
                modified.writestr(part, contents)
        self.excel("read", source.name, SHEET, error="DTD is not allowed")
        self.excel("edit", source.name, EDITED, SHEET, "B2", "160", error="DTD is not allowed")
        self.assertFalse((self.workspace / EDITED).exists())

    def test_rejects_duplicate_workbook_parts(self):
        source = self.workspace / SOURCE
        with ZipFile(source, "a") as archive, warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            archive.writestr("xl/workbook.xml", archive.read("xl/workbook.xml"))
        self.excel("read", source.name, SHEET, error="Duplicate part")

    def test_recalculation_refuses_formulas_outside_the_supported_scope(self):
        self.install_tool("libreoffice/program/soffice", "/usr/bin/false")
        for formula in ['=INDIRECT("B2")', "=SUM(Total)", "=SUM('[External.xlsx]Sheet'!A:A)"]:
            with self.subTest(formula=formula):
                workbook = Workbook()
                workbook.active["A1"] = formula
                source = self.workspace / "unsupported.xlsx"
                workbook.save(source)
                before = source.read_bytes()
                self.excel("recalc", source.name, RECALCULATED, error="unsupported or external formula")
                self.assertFalse((self.workspace / RECALCULATED).exists())
                self.assertEqual(source.read_bytes(), before)

    def test_recalculate_refuses_incompatible_calculation_settings(self):
        self.install_tool("libreoffice/program/soffice", "/usr/bin/false")
        workbook = Workbook()
        workbook.calculation.iterate = True
        workbook.active["A1"] = "=(A1+2)/2"
        source = self.workspace / "iterative.xlsx"
        workbook.save(source)
        self.excel("recalc", source.name, RECALCULATED, error="iterative calculation")
        self.assertFalse((self.workspace / RECALCULATED).exists())


if __name__ == "__main__":
    if sys.argv[1:] == ["fixture"]:
        make_fixture(Path.cwd())
    elif sys.argv[1:] == ["verify"]:
        verify_copy(Path.cwd(), EDITED, 160, 250)
        verify_copy(Path.cwd(), RECALCULATED, 160, 260)
        assert load_workbook(NEW)[SHEET]["B2"].value == 150
    else:
        unittest.main()
