import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
from copy import copy
from datetime import date, time
from pathlib import Path, PurePosixPath
from posixpath import normpath
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile

try:
    import pandas as pd
    from lxml import etree
    from openpyxl import Workbook, load_workbook
    from openpyxl.formula import Tokenizer
    from openpyxl.formula.tokenizer import TokenizerError
    from openpyxl.utils.cell import coordinate_to_tuple, range_boundaries
    from openpyxl.utils.exceptions import InvalidFileException
except ImportError as error:
    sys.exit(f"The bundled Office Runtime is incomplete: {error}")


NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
REL_TYPE = REL[1:-1] + "/"
SPACE = "{http://www.w3.org/XML/1998/namespace}space"
CELL = r"\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6}"
REFERENCE = re.compile(rf"(?:(?:'((?:[^']|'')+)'|([^'!:\[\]|]+))!)?{CELL}(?::{CELL})?", re.I)
LOCAL_FUNCTIONS = {"ABS", "AND", "AVERAGE", "COUNT", "COUNTA", "IF", "MAX", "MIN", "NOT", "OR", "ROUND", "SUM"}
MAX_XML_BYTES = 64 * 1024 * 1024


class NoDocumentType:
    def doctype(self, name, public_id, system_id):
        raise ValueError("DTD is not allowed in an XLSX package.")

    def close(self):
        return None


def read_xml(archive, part):
    info = archive.getinfo(part)
    if info.file_size > MAX_XML_BYTES:
        raise ValueError(f"XLSX XML part exceeds 64 MiB: {part}")
    root = etree.fromstring(archive.read(info), etree.XMLParser(resolve_entities=False, no_network=True))
    if root.getroottree().docinfo.doctype:
        raise ValueError("DTD is not allowed in an XLSX package.")
    return root


def validate_archive(archive):
    names = archive.namelist()
    if len(set(names)) != len(names):
        raise ValueError("Duplicate part in XLSX package.")
    contents = read_xml(archive, "[Content_Types].xml")
    xml_parts = set()
    xml_extensions = {".xml", ".rels", ".vml"}
    for part in contents:
        if part.get("ContentType", "").endswith("xml"):
            if extension := part.get("Extension"):
                xml_extensions.add("." + extension.lower())
            if name := part.get("PartName"):
                xml_parts.add(name.lstrip("/"))
    # Parse without building trees before handing the archive to openpyxl.
    for part in archive.infolist():
        if part.filename not in xml_parts and PurePosixPath(part.filename).suffix.lower() not in xml_extensions:
            continue
        if part.file_size > MAX_XML_BYTES:
            raise ValueError(f"XLSX XML part exceeds 64 MiB: {part.filename}")
        with archive.open(part) as stream:
            etree.parse(stream, etree.XMLParser(target=NoDocumentType(), resolve_entities=False, no_network=True))


def local_part(parent, relationship):
    target = relationship.attrib["Target"]
    part = normpath(target.lstrip("/") if target.startswith("/") else str(parent / target))
    if relationship.get("TargetMode", "Internal") != "Internal" or part.startswith("../"):
        raise ValueError("An XLSX worksheet must be stored inside the workbook.")
    return part


def worksheet_parts(archive):
    related = read_xml(archive, "_rels/.rels")
    main = next((item for item in related if item.get("Type") == REL_TYPE + "officeDocument"), None)
    if main is None:
        raise ValueError("Expected a standard XLSX workbook.")
    member = PurePosixPath(local_part(PurePosixPath(), main))
    relationships = read_xml(archive, str(member.parent / "_rels" / (member.name + ".rels")))
    paths = {item.attrib["Id"]: local_part(member.parent, item) for item in relationships
             if item.get("Type") == REL_TYPE + "worksheet"}
    book = read_xml(archive, str(member))
    return {sheet.attrib["name"]: paths[sheet.attrib[REL + "id"]]
            for sheet in book.findall(f"{NS}sheets/{NS}sheet") if sheet.get(REL + "id") in paths}


def sheet_cells(root):
    return {cell.attrib["r"]: cell for cell in root.iterfind(f"{NS}sheetData/{NS}row/{NS}c")}


def write_copy(source, staged, modified):
    with ZipFile(staged, "w") as target:
        target.comment = source.comment
        for part in source.infolist():
            if part.filename in modified:
                data = etree.tostring(modified[part.filename], encoding="UTF-8", xml_declaration=True)
                target.writestr(copy(part), data)
            else:
                with source.open(part) as reader, target.open(copy(part), "w") as writer:
                    shutil.copyfileobj(reader, writer)


def validate_scalar(value):
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, str):
        if len(value.encode("utf-16-le")) <= 65534:
            # XML serialization must fail before publishing on unsupported control characters.
            etree.Element("value").text = value
            return
    if isinstance(value, (int, float)) and math.isfinite(value):
        return
    raise ValueError("Use a finite JSON number, boolean, null, or text up to 32767 characters.")


def create(staged, sheet):
    if not sheet or len(sheet) > 31 or sheet.startswith("'") or sheet.endswith("'"):
        raise ValueError("Use a valid Excel worksheet name of at most 31 characters.")
    rows = json.load(sys.stdin)
    if not isinstance(rows, list) or not rows or not all(isinstance(row, dict) and row for row in rows):
        raise ValueError("Provide a nonempty JSON array of row objects on stdin.")
    for row in rows:
        for name, value in row.items():
            validate_scalar(name)
            validate_scalar(value)
    with pd.ExcelWriter(staged, engine="openpyxl") as writer:
        pd.DataFrame(rows, dtype=object).to_excel(writer, sheet_name=sheet, index=False)
        # JSON strings are literal cell values, even when they start with '='.
        for row in writer.sheets[sheet].iter_rows():
            for cell in row:
                if cell.data_type in {"f", "e"}:
                    cell.data_type = "s"


def json_value(value):
    if pd.isna(value):
        return None
    return value.isoformat() if isinstance(value, (date, time)) else value


def read_table(source, sheet):
    with pd.ExcelFile(source, engine="openpyxl") as excel:
        frame = pd.read_excel(excel, sheet_name=sheet, dtype=object, keep_default_na=False)
        rows = frame.to_numpy(dtype=object).tolist()
        # The pandas engine maps Excel error cells to NaN. Keep their visible values.
        if frame.isna().any(axis=None):
            cells = excel.book[sheet].iter_rows(min_row=2, max_row=len(rows) + 1, max_col=len(frame.columns))
            for row, sheet_row in zip(rows, cells):
                for index, cell in enumerate(sheet_row):
                    if cell.data_type == "e":
                        row[index] = cell.value
    print(json.dumps({
        "columns": [json_value(value) for value in frame.columns.tolist()],
        "data": [[json_value(value) for value in row] for row in rows],
    }, ensure_ascii=False, allow_nan=False, separators=(",", ":")))


def edit(archive, staged, sheet, coordinate, value):
    coordinate = coordinate.upper()
    row, column = coordinate_to_tuple(coordinate)
    validate_scalar(value)
    parts = worksheet_parts(archive)
    if sheet not in parts:
        raise ValueError(f"Worksheet not found: {sheet}")
    part = parts[sheet]
    root = read_xml(archive, part)
    cell = sheet_cells(root).get(coordinate)
    if cell is None or cell.find(NS + "f") is not None or "cm" in cell.attrib or "vm" in cell.attrib:
        raise ValueError("Choose an existing ordinary value cell, outside formulas and arrays.")
    for formula in root.iter(NS + "f"):
        if formula.get("ref") and formula.get("t") in {"array", "dataTable"}:
            left, top, right, bottom = range_boundaries(formula.get("ref"))
            if top <= row <= bottom and left <= column <= right:
                raise ValueError("Choose an existing ordinary value cell, outside formulas and arrays.")
    for child in list(cell):
        if child.tag in {NS + "v", NS + "is"}:
            cell.remove(child)
    if isinstance(value, str):
        cell.set("t", "inlineStr")
        inline = etree.Element(NS + "is")
        cell.insert(0, inline)
        text = etree.SubElement(inline, NS + "t")
        text.set(SPACE, "preserve")
        text.text = value
    elif value is None:
        cell.attrib.pop("t", None)
    else:
        cell.set("t", "b" if isinstance(value, bool) else "n")
        number = etree.Element(NS + "v")
        number.text = str(int(value) if isinstance(value, bool) else value)
        cell.insert(0, number)
    write_copy(archive, staged, {part: root})


def local_formula(formula, names):
    for token in Tokenizer(formula).items:
        if token.type == "FUNC" and token.subtype == "OPEN":
            if token.value[:-1].upper() not in LOCAL_FUNCTIONS:
                return False
        if token.type == "OPERAND" and token.subtype == "RANGE":
            reference = REFERENCE.fullmatch(token.value)
            if reference is None:
                return False
            escaped, plain = reference.groups()
            name = escaped.replace("''", "'") if escaped is not None else plain
            if name is not None and name.casefold() not in names:
                return False
    return True


def calculation_input(source, archive, directory):
    original = load_workbook(source, keep_links=False)
    if original.calculation and (original.calculation.iterate or original.calculation.fullPrecision is False):
        raise ValueError("Cannot recalculate workbooks using iterative calculation or precision as displayed.")
    scratch = Workbook()
    scratch.remove(scratch.active)
    scratch.epoch = original.epoch
    parts = worksheet_parts(archive)
    names = {name.casefold() for name in parts}
    targets = {}
    for name, part in parts.items():
        root = read_xml(archive, part)
        output_sheet = scratch.create_sheet(name)
        formulas = {}
        for coordinate, cell in sheet_cells(root).items():
            original_cell = original[name][coordinate]
            value = original_cell.value
            formula = cell.find(NS + "f")
            if formula is not None:
                # Only workbook-local scalar formulas reach LibreOffice; the new
                # workbook carries no links, macros, embedded objects or names.
                if (formula.get("t", "normal") not in {"normal", "shared"}
                        or not isinstance(value, str) or not local_formula(value, names)):
                    raise ValueError(f"Cannot recalculate an unsupported or external formula at {name}!{coordinate}.")
                formulas[coordinate] = cell
            elif cell.get("t", "n") == "n" and (numeric := cell.findtext(NS + "v")):
                # A date or time display style does not change the stored number.
                value = float(numeric)
            if value is not None:
                output_sheet[coordinate] = value
                if isinstance(value, str):
                    output_sheet[coordinate].data_type = original_cell.data_type
        if formulas:
            targets[name] = (part, root, formulas)
    if not targets:
        raise ValueError("Workbook has no formulas to recalculate.")
    input_path = directory / "input.xlsx"
    scratch.save(input_path)
    return input_path, targets


def recalculate(runtime, source, archive, staged):
    runtime = runtime.resolve()
    soffice = runtime / "libreoffice/program/soffice"
    if not os.access(soffice, os.X_OK):
        raise ValueError("The bundled Office Runtime is missing LibreOffice. Reinstall the Pie Code ARM64 package.")
    directory = staged.parent.resolve()
    input_path, targets = calculation_input(source, archive, directory)
    converted = directory / "converted"
    converted.mkdir()
    profile = (directory / "profile").as_uri()
    result = subprocess.run(
        [str(soffice), f"-env:UserInstallation={profile}", "--headless", "--convert-to",
         "xlsx:Calc MS Excel 2007 XML", "--outdir", str(converted), str(input_path)],
        cwd=directory, env={
            "HOME": str(directory), "TMPDIR": str(directory), "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8", "SAL_USE_VCLPLUGIN": "svp",
            "LD_LIBRARY_PATH": f"{runtime / 'lib'}:{soffice.parent}",
        }, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
    )
    output_path = converted / input_path.name
    if result.returncode or not output_path.is_file():
        raise ValueError(f"Bundled LibreOffice did not recalculate the workbook: {(result.stderr or result.stdout).strip()}")
    modified = {}
    data = None
    with ZipFile(output_path) as computed:
        computed_parts = worksheet_parts(computed)
        for name, (part, root, formulas) in targets.items():
            values = sheet_cells(read_xml(computed, computed_parts[name]))
            for coordinate, cell in formulas.items():
                calculated = values.get(coordinate)
                cache = None if calculated is None else calculated.find(NS + "v")
                kind = None if calculated is None else calculated.get("t", "n")
                if kind == "s" and cache is not None:
                    if data is None:
                        data = load_workbook(output_path, data_only=True, keep_links=False)
                    cache = etree.Element(NS + "v")
                    cache.text = data[name][coordinate].value
                    kind = "str"
                if cache is None or kind not in {"n", "b", "e", "str"}:
                    raise ValueError(f"LibreOffice returned no supported value for {name}!{coordinate}.")
                previous = cell.find(NS + "v")
                if previous is not None:
                    cell.replace(previous, copy(cache))
                else:
                    cell.insert(cell.index(cell.find(NS + "f")) + 1, copy(cache))
                cell.set("t", kind)
            modified[part] = root
    write_copy(archive, staged, modified)


def xlsx(value):
    path = Path(value)
    if path.suffix.lower() != ".xlsx":
        raise argparse.ArgumentTypeError("Use .xlsx filenames.")
    return path


def main(runtime):
    parser = argparse.ArgumentParser(description="Work with .xlsx files using the bundled Office Runtime.")
    commands = parser.add_subparsers(dest="operation", required=True)
    for name, arguments in {
        "read": ("source", "sheet"), "create": ("output", "sheet"),
        "edit": ("source", "output", "sheet", "coordinate", "value"), "recalc": ("source", "output"),
    }.items():
        command = commands.add_parser(name)
        for argument in arguments:
            command.add_argument(argument, type=xlsx if argument in {"source", "output"} else str)
    args = parser.parse_args(sys.argv[2:])
    if args.operation == "read":
        with args.source.open("rb") as source:
            with ZipFile(source) as archive:
                validate_archive(archive)
            read_table(source, args.sheet)
        return
    if os.path.lexists(args.output):
        raise FileExistsError(args.output)
    with TemporaryDirectory(prefix=".pie-excel-", dir=args.output.parent) as directory:
        staged = Path(directory) / "saved.xlsx"
        if args.operation == "create":
            create(staged, args.sheet)
        else:
            with args.source.open("rb") as source, ZipFile(source) as archive:
                validate_archive(archive)
                if args.operation == "edit":
                    edit(archive, staged, args.sheet, args.coordinate, json.loads(args.value))
                else:
                    recalculate(runtime, source, archive, staged)
        os.link(staged, args.output)
    print(f"Saved {args.output}")


try:
    main(Path(sys.argv[1]))
except FileExistsError:
    sys.exit("Output already exists; choose a new filename.")
except (OSError, ValueError, KeyError, OverflowError, BadZipFile, InvalidFileException, TokenizerError, etree.XMLSyntaxError,
        subprocess.TimeoutExpired) as error:
    sys.exit(f"Excel operation failed: {error}")
