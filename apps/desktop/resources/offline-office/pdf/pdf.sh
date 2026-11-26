#!/bin/sh
set -eu

workspace=$PWD
cd -- "${0%/*}"
skill=$PWD
runtime=$skill/../../../office-runtime
python=$runtime/python/bin/python3.12
if [ ! -x "$python" ]; then
    printf '%s\n' 'The bundled Office Runtime is missing or incomplete. Reinstall the Pie Code ARM64 package.' >&2
    exit 1
fi

cd -- "$workspace"
# The bundled crypto wheel's ARM acceleration can trap on Kylin virtual CPUs.
export OPENSSL_armcap=0
exec "$python" -I -B -X utf8 "$skill/pdf_document.py" "$runtime" "$@"
