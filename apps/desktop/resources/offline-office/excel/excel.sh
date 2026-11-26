#!/bin/sh
set -eu

workspace=$PWD
cd -- "${0%/*}"
skill=$PWD
runtime=$skill/../../../office-runtime
python=$runtime/python/bin/python3.12
[ -x "$python" ] || {
    printf '%s\n' 'The bundled Office Runtime is missing or incomplete. Reinstall the Pie Code ARM64 package.' >&2
    exit 1
}

unset PYTHONPATH PYTHONHOME
cd -- "$workspace"
exec "$python" -I -B -X utf8 "$skill/spreadsheet.py" "$runtime" "$@"
