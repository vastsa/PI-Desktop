import argparse
import os
import select
import subprocess
import sys
from pathlib import Path

# Isolated Python does not add the bundled skill directory to sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from office_document import run_office_process, save_new

try:
    from pypdf import PdfReader, PdfWriter
    from pypdf.errors import PyPdfError
except ImportError as error:
    sys.exit(f"The bundled Office Runtime is incomplete: {error}")


OFFICE_FILTERS = {
    ".docx": ("Office Open XML Text", "writer_pdf_Export"),
    ".pptx": ("Impress MS PowerPoint 2007 XML", "impress_pdf_Export"),
    ".xlsx": ("Calc MS Excel 2007 XML", "calc_pdf_Export"),
}


def pdf_path(value):
    path = Path(value)
    if path.suffix.lower() != ".pdf":
        raise argparse.ArgumentTypeError("Use .pdf filenames.")
    return path


def office_path(value):
    path = Path(value)
    if path.suffix.lower() not in OFFICE_FILTERS:
        raise argparse.ArgumentTypeError("Use a .docx, .pptx, or .xlsx source.")
    return path


def read_pdf(source):
    reader = PdfReader(source)
    if reader.is_encrypted:
        raise ValueError(f"Encrypted PDF is unsupported: {source}")
    if not reader.pages:
        raise ValueError(f"PDF contains no pages: {source}")
    return reader


def extract(source):
    pages = [page.extract_text().strip() for page in read_pdf(source).pages]
    if not any(pages):
        raise ValueError("The PDF contains no extractable text. OCR is not supported.")
    print("\n\n".join(f"Page {number}\n{text}".rstrip() for number, text in enumerate(pages, 1)))


def merge(sources, staged):
    writer = PdfWriter()
    for source in sources:
        for page in read_pdf(source).pages:
            writer.add_page(page)
    with staged.open("wb") as output:
        writer.write(output)


def check_export_active():
    # Only the Bash-group parent holds the write end of this pipe.
    if select.select([sys.stdin], [], [], 0)[0]:
        raise InterruptedError("PDF export cancelled.")


def export(source, staged, runtime):
    soffice = runtime / "libreoffice/program/soffice"
    if not os.access(soffice, os.X_OK):
        raise ValueError("The bundled Office Runtime is missing LibreOffice. Reinstall the Pie Code ARM64 package.")
    directory = staged.parent.resolve()
    profile = directory / "profile"
    config = profile / "user/registrymodifications.xcu"
    config.parent.mkdir(parents=True)
    config.write_text(
        '<oor:items xmlns:oor="http://openoffice.org/2001/registry">'
        '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
        '<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>'
        '<prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>'
        '</item></oor:items>',
        encoding="utf-8",
    )
    # LibreOffice's batch conversion opens the source read-only.
    converted = directory / "converted"
    converted.mkdir()
    import_filter, pdf_filter = OFFICE_FILTERS[source.suffix.lower()]
    result = run_office_process(
        [str(soffice), f"-env:UserInstallation={profile.as_uri()}", "--headless",
         f"--infilter={import_filter}", "--convert-to", f"pdf:{pdf_filter}",
         "--outdir", str(converted), str(source.absolute())],
        cwd=directory,
        check_active=check_export_active,
        env={
            # LibreOffice places a Unix socket under TMPDIR, which has a short path limit.
            "HOME": str(directory), "TMPDIR": "/tmp", "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8", "SAL_USE_VCLPLUGIN": "svp",
            "LD_LIBRARY_PATH": f"{runtime / 'lib'}:{soffice.parent}",
        },
    )
    pdf = converted / (source.stem + ".pdf")
    if result.returncode or not pdf.is_file():
        detail = (result.stderr or result.stdout).strip()
        raise ValueError(f"Bundled LibreOffice did not export the PDF: {detail or 'no PDF produced'}")
    read_pdf(pdf)
    check_export_active()
    pdf.rename(staged)


def run_export_worker(runtime, source, output):
    # Bash kills its process group; the worker must survive long enough to clean up.
    command = [sys.executable, "-I", "-B", "-X", "utf8", __file__, runtime,
               "--export-worker", "--", str(source), str(output)]
    with subprocess.Popen(command, stdin=subprocess.PIPE, start_new_session=True) as worker:
        return worker.wait()


def main():
    parser = argparse.ArgumentParser(description="Process PDFs with the bundled Office Runtime.")
    commands = parser.add_subparsers(dest="operation", required=True)
    commands.add_parser("extract").add_argument("source", type=pdf_path)
    combine = commands.add_parser("merge")
    combine.add_argument("output", type=pdf_path)
    combine.add_argument("sources", type=pdf_path, nargs="+")
    convert = commands.add_parser("export")
    convert.add_argument("source", type=office_path)
    convert.add_argument("output", type=pdf_path)
    arguments = sys.argv[2:]
    worker = arguments[:1] == ["--export-worker"]
    args = parser.parse_args(["export", *arguments[1:]] if worker else arguments)
    if args.operation == "extract":
        extract(args.source)
        return
    if os.path.lexists(args.output):
        raise FileExistsError(f"Output already exists: {args.output}")
    if args.operation == "merge":
        save_new(args.output, lambda staged: merge(args.sources, staged))
    elif worker:
        check_export_active()
        save_new(args.output, lambda staged: export(args.source, staged, Path(sys.argv[1]).resolve()))
    else:
        return run_export_worker(sys.argv[1], args.source, args.output)
    print(f"Saved {args.output}")


try:
    sys.exit(main())
except (OSError, ValueError, PyPdfError, subprocess.TimeoutExpired) as error:
    sys.exit(str(error))
