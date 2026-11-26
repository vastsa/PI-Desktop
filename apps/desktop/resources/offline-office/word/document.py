import sys
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import BadZipFile, ZipFile

# Isolated Python does not add the bundled skill directory to sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from office_document import replacement_text, save_package_copy

try:
    from lxml import etree
except ImportError as error:
    sys.exit(f"The bundled Office Runtime is incomplete: {error}")


WORD_NAMESPACES = {
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
}
MAIN_PART_TYPES = {
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
    "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
}
RELATIONSHIPS = "{http://schemas.openxmlformats.org/package/2006/relationships}"
SPACE = "{http://www.w3.org/XML/1998/namespace}space"
NON_TEXT = {
    "tab": "\t", "ptab": "\t", "br": "\n", "cr": "\n",
    "noBreakHyphen": "\u2011", "softHyphen": "\u00ad",
    "sym": "\ufffc", "drawing": "\ufffc", "object": "\ufffc", "pict": "\ufffc",
}


def read_xml(archive, name):
    if archive.namelist().count(name) != 1:
        raise ValueError(f"Expected exactly one Word package part: {name}")
    part = archive.getinfo(name)
    if part.file_size > 64 * 1024 * 1024:
        raise ValueError(f"Word package part exceeds 64 MiB: {name}")
    root = etree.fromstring(archive.read(part), etree.XMLParser(resolve_entities=False, no_network=True))
    if root.getroottree().docinfo.doctype:
        raise ValueError("Word package XML must not contain a document type.")
    return root


def read_body(archive):
    relationships = read_xml(archive, "_rels/.rels")
    if relationships.tag != RELATIONSHIPS + "Relationships":
        raise ValueError("Expected Word package relationships.")
    main_parts = [rel for rel in relationships.findall(RELATIONSHIPS + "Relationship")
                  if rel.get("Type") in MAIN_PART_TYPES]
    if len(main_parts) != 1 or main_parts[0].get("TargetMode", "Internal") != "Internal":
        raise ValueError("Expected exactly one internal Word document body.")

    target = main_parts[0].get("Target", "")
    uri = urlsplit(target)
    # Package part names and ZIP entry names retain URI escapes.
    member = uri.path.removeprefix("/")
    if (uri.scheme or uri.netloc or any(char in "?#\\" or ord(char) <= 32 for char in target)
            or any(piece in {"", ".", ".."} for piece in member.split("/"))):
        raise ValueError("Invalid Word document body path.")

    root = read_xml(archive, member)
    if root.tag not in {f"{{{namespace}}}document" for namespace in WORD_NAMESPACES}:
        raise ValueError("Expected an ordinary Word document body.")
    return member, root


def paragraphs(root):
    word = root.tag.removesuffix("document")
    paragraph_tag, text_tag = word + "p", word + "t"
    separators = {word + name: char for name, char in NON_TEXT.items()}
    for paragraph in root.iter(paragraph_tag):
        yield [(node, node.text or "") if node.tag == text_tag else (None, separators[node.tag])
               for node in paragraph.iter(text_tag, *separators)
               if next(node.iterancestors(paragraph_tag), None) is paragraph]


def replace(root, old, new):
    if not old or any(char in old for char in NON_TEXT.values()) or any(char in new for char in "\t\r\n"):
        raise ValueError("Specify a nonempty literal to find and plain text on one line.")

    for node, text in replacement_text(
        paragraphs(root), old, new,
        missing="Text was not found in the Word document body.",
        repeated="Text occurs more than once; specify a unique match.",
    ):
        node.text = text
        if text != text.strip():
            node.set(SPACE, "preserve")


def main():
    operation, source, *args = sys.argv[1:]
    if any(Path(name).suffix.lower() != ".docx" for name in [source, *args[:1]]):
        raise ValueError("Use .docx filenames.")
    with ZipFile(source) as archive:
        member, root = read_body(archive)
        if operation == "extract":
            for nodes in paragraphs(root):
                print("".join(text for _, text in nodes))
        else:
            output, old, new = args
            replace(root, old, new)
            content = etree.tostring(root, encoding="UTF-8", xml_declaration=True)
            save_package_copy(archive, Path(output), member, content)
            print(f"Saved {output}")


try:
    main()
except FileExistsError:
    sys.exit("Output already exists; choose a new filename.")
except (OSError, ValueError, KeyError, BadZipFile, etree.XMLSyntaxError) as error:
    sys.exit(f"Word operation failed: {error}")
