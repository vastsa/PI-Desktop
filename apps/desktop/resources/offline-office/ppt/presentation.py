import argparse
import json
import sys
from pathlib import Path
from zipfile import BadZipFile, ZipFile

# Isolated Python does not add the bundled skill directory to sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from office_document import replacement_text, save_new, save_package_copy

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
        if any(props.get("hidden") in ("1", "true") for props in shape._element.xpath("./*/p:cNvPr")):
            continue
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from paragraphs(shape.shapes)
        elif shape.has_text_frame:
            yield from shape.text_frame.paragraphs
        elif shape.has_table:
            for cell in shape.table.iter_cells():
                if not cell.is_spanned:
                    yield from cell.text_frame.paragraphs


def text_segments(paragraph):
    # Fields are visible but read-only. Line breaks and empty fields interrupt a match.
    return [(child, child.text) if child.tag == qn("a:r") else (None, child.text or "\v")
            for child in paragraph._p.content_children]


def replace(slide, old, new):
    if not old or any(character in old + new for character in "\t\r\n\v"):
        raise ValueError("Specify a nonempty literal to find and plain text on one line.")
    for run, text in replacement_text(
        (text_segments(paragraph) for paragraph in paragraphs(slide.shapes)), old, new,
        missing="Text was not found on this slide.",
        repeated="Text occurs more than once on this slide; specify a unique match.",
    ):
        run.text = text


MAX_EXPANDED_SIZE = 256 * 1024 * 1024


def check_package(archive):
    # python-pptx inflates every ZIP member in memory before reading slides.
    if sum(part.file_size for part in archive.infolist()) > MAX_EXPANDED_SIZE:
        raise ValueError("Expanded presentation exceeds 256 MiB.")
    names = archive.namelist()
    if len(set(names)) != len(names):
        raise ValueError("Presentation contains duplicate package parts.")


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
        check_package(archive)
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
        # Saving the whole deck through python-pptx would reserialize untouched parts.
        save_package_copy(archive, args.output, member, content)


if __name__ == "__main__":
    try:
        main()
    except FileExistsError:
        sys.exit("Output already exists; choose a new filename.")
    except (OSError, ValueError, KeyError, BadZipFile, LxmlError, PythonPptxError) as error:
        sys.exit(f"PowerPoint operation failed: {error}")
