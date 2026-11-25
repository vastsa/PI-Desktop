import argparse
import json
import os
import shutil
import sys
from copy import copy
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile

try:
    from lxml.etree import LxmlError
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE
    from pptx.exc import PythonPptxError
    from pptx.opc.constants import RELATIONSHIP_TYPE
    from pptx.oxml.ns import qn
except ImportError as error:
    sys.exit(f"The bundled Office Runtime is incomplete: {error}")


def pptx_path(value):
    path = Path(value)
    if path.suffix.lower() != ".pptx":
        raise argparse.ArgumentTypeError("Use .pptx filenames.")
    return path


def save_new(output, write):
    with TemporaryDirectory(prefix=".pie-ppt-", dir=output.parent) as directory:
        staged = Path(directory) / "presentation.pptx"
        write(staged)
        os.link(staged, output)


def create(output):
    specifications = json.load(sys.stdin)
    if not isinstance(specifications, list) or not specifications or any(
        not isinstance(slide, dict) or set(slide) != {"title", "body"}
        or not all(isinstance(text, str) for text in slide.values())
        for slide in specifications
    ):
        raise ValueError("Provide a nonempty JSON array of slides with string title and body fields.")
    deck = Presentation()
    for spec in specifications:
        slide = deck.slides.add_slide(deck.slide_layouts[1])
        slide.shapes.title.text = spec["title"]
        slide.placeholders[1].text = spec["body"]
    save_new(output, lambda staged: deck.save(str(staged)))


def paragraphs(shapes):
    for shape in shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from paragraphs(shape.shapes)
        elif shape.has_text_frame:
            yield from shape.text_frame.paragraphs
        elif shape.has_table:
            for cell in shape.table.iter_cells():
                if not cell.is_spanned:
                    yield from cell.text_frame.paragraphs


def run_groups(paragraph):
    # paragraph.runs omits breaks and fields, which must interrupt a match.
    runs = iter(paragraph.runs)
    group = []
    for child in paragraph._p:
        if child.tag == qn("a:r"):
            group.append(next(runs))
        elif group:
            yield group
            group = []
    if group:
        yield group


def replace(slide, old, new):
    if not old or any(character in old + new for character in "\t\r\n\v"):
        raise ValueError("Specify a nonempty literal to find and plain text on one line.")
    match = None
    for paragraph in paragraphs(slide.shapes):
        for runs in run_groups(paragraph):
            text = "".join(run.text for run in runs)
            start = text.find(old)
            if start < 0:
                continue
            if match is not None or text.find(old, start + 1) >= 0:
                raise ValueError("Text occurs more than once on this slide; specify a unique match.")
            match = runs, start, start + len(old)
    if match is None:
        raise ValueError("Text was not found on this slide.")
    runs, start, end = match
    offset = 0
    for run in runs:
        text = run.text
        right = offset + len(text)
        if text and right > start and offset < end:
            run.text = text[:max(0, start - offset)] + (new if offset <= start else "") + text[max(0, end - offset):]
        offset = right


def copy_with_slide(source, staged, member, content):
    # Saving the whole deck through python-pptx would reserialize untouched parts.
    if member not in source.namelist():
        raise ValueError("The selected slide has no package part.")
    with ZipFile(staged, "w") as target:
        target.comment = source.comment
        for part in source.infolist():
            if part.filename == member:
                target.writestr(copy(part), content)
            else:
                with source.open(part) as reader, target.open(copy(part), "w") as writer:
                    shutil.copyfileobj(reader, writer)


def main():
    parser = argparse.ArgumentParser(prog="ppt.sh")
    operations = parser.add_subparsers(dest="operation", required=True)
    operations.add_parser("create").add_argument("output", type=pptx_path)
    operations.add_parser("extract").add_argument("source", type=pptx_path)
    edit = operations.add_parser("replace")
    edit.add_argument("source", type=pptx_path)
    edit.add_argument("output", type=pptx_path)
    edit.add_argument("slide", type=int)
    edit.add_argument("old")
    edit.add_argument("new")
    args = parser.parse_args()
    if args.operation == "create":
        create(args.output)
        return
    with args.source.open("rb") as source, ZipFile(source) as archive:
        # python-pptx inflates every ZIP member in memory before reading slides.
        if sum(part.file_size for part in archive.infolist()) > 256 * 1024 * 1024:
            raise ValueError("Expanded presentation exceeds 256 MiB.")
        names = archive.namelist()
        if len(set(names)) != len(names):
            raise ValueError("Presentation contains duplicate package parts.")
        deck = Presentation(source)
        if args.operation == "extract":
            for page, slide in enumerate(deck.slides, 1):
                if page > 1:
                    print()
                print(f"Slide {page}")
                for paragraph in paragraphs(slide.shapes):
                    if paragraph.text:
                        print(paragraph.text.replace("\v", "\n"))
            return
        # Accessing deck.slides renumbers the library's part names in slide order.
        original_members = {rel.target_part: rel.target_part.partname.membername
                            for rel in deck.part.rels.values()
                            if not rel.is_external and rel.reltype == RELATIONSHIP_TYPE.SLIDE}
        slides = deck.slides
        if not 1 <= args.slide <= len(slides):
            raise ValueError(f"Slide number out of range: choose 1–{len(slides)}.")
        slide = slides[args.slide - 1]
        replace(slide, args.old, args.new)
        member, content = original_members[slide.part], slide.part.blob
        save_new(args.output, lambda staged: copy_with_slide(archive, staged, member, content))


if __name__ == "__main__":
    try:
        main()
    except FileExistsError:
        sys.exit("Output already exists; choose a new filename.")
    except (OSError, ValueError, KeyError, BadZipFile, LxmlError, PythonPptxError) as error:
        sys.exit(f"PowerPoint operation failed: {error}")
