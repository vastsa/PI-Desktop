import os
import shutil
from copy import copy
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile


def replacement_text(paragraphs, old, new, *, missing, repeated):
    match = None
    for segments in paragraphs:
        text = "".join(text for _, text in segments)
        start = text.find(old)
        if start < 0:
            continue
        if match is not None or text.find(old, start + 1) >= 0:
            raise ValueError(repeated)
        match = segments, start, start + len(old)
    if match is None:
        raise ValueError(missing)

    segments, start, end = match
    changes = []
    offset = 0
    for target, text in segments:
        right = offset + len(text)
        if text and right > start and offset < end:
            if target is None:
                raise ValueError("Matched text includes a read-only field; choose editable text.")
            prefix = text[:max(0, start - offset)]
            suffix = text[max(0, end - offset):]
            changes.append((target, prefix + (new if offset <= start else "") + suffix))
        offset = right
    return changes


def save_new(output, write):
    with TemporaryDirectory(prefix=".pie-office-", dir=output.parent) as directory:
        staged = Path(directory) / output.name
        write(staged)
        os.link(staged, output)


def save_package_copy(source, output, member, content):
    source.getinfo(member)

    def write(staged):
        with ZipFile(staged, "w") as target:
            target.comment = source.comment
            for part in source.infolist():
                if part.filename == member:
                    target.writestr(copy(part), content)
                else:
                    with source.open(part) as reader, target.open(copy(part), "w") as writer:
                        shutil.copyfileobj(reader, writer)

    save_new(output, write)
