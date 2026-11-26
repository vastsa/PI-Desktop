import os
import shutil
import subprocess
import sys
import time
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


def communicate_office(office, command, check_active):
    timeout = 30
    if check_active is None:
        return office.communicate(timeout=timeout)
    deadline = time.monotonic() + timeout
    while True:
        check_active()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(command, timeout)
        try:
            return office.communicate(timeout=min(0.1, remaining))
        except subprocess.TimeoutExpired:
            # Check for cancellation while stdout and stderr are still drained.
            continue


def run_office_process(command, *, cwd, env, check_active=None):
    # A watchdog owns the conversion group. Its pipe closes even if Bash kills Python.
    watchdog = "import os, signal, sys; sys.stdin.buffer.read(1); os.killpg(0, signal.SIGKILL)"
    with subprocess.Popen([sys.executable, "-I", "-c", watchdog], stdin=subprocess.PIPE, process_group=0) as guard:
        with subprocess.Popen(
            command, cwd=cwd, env=env, process_group=guard.pid,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
        ) as office:
            try:
                stdout, stderr = communicate_office(office, command, check_active)
            finally:
                guard.stdin.close()
    return subprocess.CompletedProcess(command, office.returncode, stdout, stderr)
