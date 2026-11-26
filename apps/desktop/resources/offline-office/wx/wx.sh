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
if ! [ -x "$python" ] || ! [ -r "$wx/scripts/main.py" ] || ! [ -r "$wx/assets/wx_template.docx" ]; then
    printf '%s\n' 'The bundled WX Runtime is missing or incomplete. Reinstall the Pie Code ARM64 package.' >&2
    exit 1
fi

case "${PI_DESKTOP_DATA_DIR:-}" in
    /*) WXDF_DEPS=$PI_DESKTOP_DATA_DIR/offline-office/wx-0.21.3/deps ;;
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
exec "$python" -E -S -B -X utf8 "$wx/scripts/main.py" "--input=$input" "--template=$wx/assets/wx_template.docx" "$@"
