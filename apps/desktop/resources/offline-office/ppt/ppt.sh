#!/bin/sh
set -eu

workspace=$PWD
cd -- "${0%/*}"
skill=$PWD
python=$skill/../../../office-runtime/python/bin/python3.12
if [ ! -x "$python" ]; then
    printf '%s\n' 'The bundled Office Runtime is missing or incomplete. Reinstall the Pie Code ARM64 package.' >&2
    exit 1
fi

cd -- "$workspace"
exec "$python" -I -B -X utf8 "$skill/presentation.py" "$@"
