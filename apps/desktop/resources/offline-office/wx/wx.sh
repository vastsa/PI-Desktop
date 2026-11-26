#!/bin/sh
set -eu

case "${1:-}:$#" in
    convert:3|review:3) ;;
    *) printf '%s\n' 'Usage: wx.sh convert INPUT.md|INPUT.docx NEW_DIRECTORY | review INPUT.docx NEW_DIRECTORY' >&2; exit 2 ;;
esac

operation=$1
input=$2
output=$3
resources=$(CDPATH= cd -- "${0%/*}/../../.." && pwd)
wx=$resources/wx-runtime
python=$resources/office-runtime/python/bin/python3.12
if ! [ -x "$python" ] || ! [ -r "$wx/VERSION" ] || ! [ -r "$wx/scripts/main.py" ] || ! [ -r "$wx/assets/wx_template.docx" ]; then
    printf '%s\n' 'The bundled WX Runtime is missing or incomplete. Reinstall the Pie Code ARM64 package.' >&2
    exit 1
fi

version=$(cat -- "$wx/VERSION")
case "$version" in
    ''|.*|*.|*[!0-9.]*) printf '%s\n' 'The bundled WX Runtime version is invalid.' >&2; exit 1 ;;
esac

case "${PI_DESKTOP_DATA_DIR:-}" in
    /*) WXDF_DEPS=$PI_DESKTOP_DATA_DIR/offline-office/wx-$version/deps ;;
    *) printf '%s\n' 'The managed Pie Code data directory is unavailable.' >&2; exit 1 ;;
esac

umask 077
export WXDF_DEPS WX_DOC_FORMAT_RELEASE=1
# Use the offline package's installer with an explicit writable destination.
"$python" -I -S -B -X utf8 "$wx/scripts/offline_install.py" "$wx/wheelhouse" "$WXDF_DEPS"
mkdir -- "$output"
case "$operation" in
    convert) set -- "--output=$output/formatted.docx" "--report=$output/audit.json" ;;
    review) set -- --review "--report-md=$output/review.md" ;;
esac
# Keep imports beside main.py and in the WX wheelhouse; ignore user Python settings.
set -- "$python" -E -S -B -X utf8 "$wx/scripts/main.py" "--input=$input" "--template=$wx/assets/wx_template.docx" "$@"
if [ "$operation" = review ]; then
    exec "$@"
fi
"$@"

# A successful conversion can still require manual review.
"$python" -I -S -B -X utf8 - "$output" <<'PY'
import json
from pathlib import Path
import sys

output = Path(sys.argv[1])
try:
    summary = json.loads((output / "audit.json").read_text(encoding="utf-8"))["public_summary"]
    status = summary["status"]
    audits = summary["audits"]
    styles = summary["unexpected_styles_count"]
    manual_review = summary["manual_review_required"]
    codes = summary["diagnostic_codes"]
    if (
        summary["schema_version"] != "1.0"
        or not isinstance(audits, dict)
        or not {"audit", "model_audit", "saved_output_audit", "appendix_preservation_audit"} <= audits.keys()
        or type(styles) is not int
        or type(manual_review) is not bool
        or not isinstance(codes, list)
        or not all(isinstance(code, str) for code in codes)
    ):
        raise ValueError("invalid audit summary")
except (KeyError, OSError, TypeError, ValueError):
    sys.exit("WX audit: delivery blocked. Missing or invalid audit summary.")

diagnostics = ", ".join(codes) or "none"
if (
    status not in ("completed", "completed_with_warnings")
    or manual_review
    or styles != 0
    or "passed" not in audits.values()
    or any(result not in ("passed", "not_run") for result in audits.values())
    or not (output / "formatted.docx").is_file()
):
    sys.exit(f"WX audit: delivery blocked. See audit.json (diagnostic codes: {diagnostics}).")
if status == "completed_with_warnings":
    print(f"WX audit: delivery allowed with warnings (diagnostic codes: {diagnostics}).", file=sys.stderr)
PY
