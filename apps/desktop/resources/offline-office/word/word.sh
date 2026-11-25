#!/bin/sh
set -eu

workspace=$PWD
cd -- "${0%/*}"
skill=$PWD
runtime=$skill/../../../office-runtime

missing() {
    printf '%s\n' 'The bundled Office Runtime is missing or incomplete. Reinstall the Pie Code ARM64 package.' >&2
    exit 1
}

operation=${1:-}
case "$operation" in
    create)
        [ "$#" -eq 3 ] || { printf '%s\n' 'Usage: word.sh create OUTPUT.docx TITLE < body.txt' >&2; exit 2; }
        node=$runtime/node/bin/node
        docx=$runtime/node/lib/node_modules/docx
        [ -x "$node" ] && [ -f "$docx/package.json" ] || missing
        ;;
    extract|replace)
        case "$operation:$#" in
            extract:2|replace:5) ;;
            *) printf '%s\n' 'Usage: word.sh extract INPUT.docx | replace INPUT.docx OUTPUT.docx OLD NEW' >&2; exit 2 ;;
        esac
        python=$runtime/python/bin/python3.12
        [ -x "$python" ] || missing
        ;;
    *)
        printf '%s\n' 'Usage: word.sh create | extract | replace' >&2
        exit 2
        ;;
esac

# Do not load modules or preload hooks from the user's environment.
unset NODE_OPTIONS NODE_PATH PYTHONPATH PYTHONHOME
cd -- "$workspace"
if [ "$operation" = create ]; then
    shift
    exec "$node" --no-global-search-paths "$skill/create.cjs" "$docx" "$@"
fi
exec "$python" -I -B -X utf8 "$skill/document.py" "$@"
