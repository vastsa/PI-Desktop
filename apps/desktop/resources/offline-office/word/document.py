import os
import shutil
import sys
from copy import copy
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile

try:
    from lxml import etree
except ImportError as error:
    sys.exit(f"The bundled Office Runtime is incomplete: {error}")


W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
SPACE = "{http://www.w3.org/XML/1998/namespace}space"
DOCUMENT = "word/document.xml"
NON_TEXT = {W + name: char for name, char in {
    "tab": "\t", "br": "\n", "cr": "\n", "noBreakHyphen": "\u2011", "softHyphen": "\u00ad",
    "sym": "\ufffc", "drawing": "\ufffc", "object": "\ufffc", "pict": "\ufffc",
}.items()}


def read_body(archive):
    if archive.namelist().count(DOCUMENT) != 1:
        raise ValueError("Expected exactly one Word document body.")
    part = archive.getinfo(DOCUMENT)
    if part.file_size > 64 * 1024 * 1024:
        raise ValueError("Word document body exceeds 64 MiB.")
    root = etree.fromstring(archive.read(part), etree.XMLParser(resolve_entities=False, no_network=True))
    if root.getroottree().docinfo.doctype or root.tag != W + "document":
        raise ValueError("Expected an ordinary Word document body.")
    return root


def paragraphs(root):
    for paragraph in root.iter(W + "p"):
        yield [node for node in paragraph.iter(W + "t", *NON_TEXT)
               if next(node.iterancestors(W + "p"), None) is paragraph]


def replace(root, old, new):
    if not old or any(char in old for char in NON_TEXT.values()) or any(char in new for char in "\t\r\n"):
        raise ValueError("Specify a nonempty literal to find and plain text on one line.")

    match = None
    for nodes in paragraphs(root):
        current = "".join(NON_TEXT.get(node.tag, node.text or "") for node in nodes)
        start = current.find(old)
        if start < 0:
            continue
        if match is not None or current.find(old, start + 1) >= 0:
            raise ValueError("Text occurs more than once; specify a unique match.")
        match = nodes, start, start + len(old)
    if match is None:
        raise ValueError("Text was not found in the Word document body.")

    nodes, start, end = match
    offset = 0
    for node in nodes:
        text = NON_TEXT.get(node.tag, node.text or "")
        right = offset + len(text)
        if node.tag == W + "t" and right > start and offset < end and text:
            prefix = text[:max(0, start - offset)]
            suffix = text[max(0, end - offset):]
            node.text = prefix + (new if offset <= start else "") + suffix
            if node.text != node.text.strip():
                node.set(SPACE, "preserve")
        offset = right


def save_copy(source, root, output):
    with TemporaryDirectory(prefix=".pie-word-", dir=output.parent) as directory:
        staged = Path(directory) / "document.docx"
        with ZipFile(staged, "w") as target:
            target.comment = source.comment
            for part in source.infolist():
                if part.filename == DOCUMENT:
                    target.writestr(copy(part), etree.tostring(root, encoding="UTF-8", xml_declaration=True))
                else:
                    with source.open(part) as reader, target.open(copy(part), "w") as writer:
                        shutil.copyfileobj(reader, writer)
        os.link(staged, output)


def main():
    operation, source, *args = sys.argv[1:]
    if any(Path(name).suffix.lower() != ".docx" for name in [source, *args[:1]]):
        raise ValueError("Use .docx filenames.")
    with ZipFile(source) as archive:
        root = read_body(archive)
        if operation == "extract":
            for nodes in paragraphs(root):
                print("".join(NON_TEXT.get(node.tag, node.text or "") for node in nodes))
        else:
            output, old, new = args
            replace(root, old, new)
            save_copy(archive, root, Path(output))
            print(f"Saved {output}")


try:
    main()
except FileExistsError:
    sys.exit("Output already exists; choose a new filename.")
except (OSError, ValueError, KeyError, BadZipFile, etree.XMLSyntaxError) as error:
    sys.exit(f"Word operation failed: {error}")
