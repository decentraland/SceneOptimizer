#!/usr/bin/env bash
# Reference script — DO NOT RUN as part of the SceneOptimizer pipeline.
#
# This is the original validated bash script that was tested against
# Decentraland's runtime on Genesis Plaza. It is checked in here purely as a
# reference so the meshopt stage's flag set can be cross-checked against the
# version that was proven to work in DCL.
#
# The actual pipeline integration lives in ../../src/meshopt.js.
#
# Defaults applied to every file:
#   -tr   keep external texture URIs (don't embed sibling PNGs into the GLB)
#   -kn   keep named nodes/meshes — required for Decentraland's "_collider" convention
#   -vpf  use float positions instead of int + node scale; otherwise gltfpack inserts
#         unnamed child nodes under named ones to hold the scale, breaking DCL's
#         collider lookup which expects the named node to own the mesh directly.
#         (Costs ~7% of the savings vs -vpi but preserves the scene structure.)
#   -kv   keep source vertex attributes even if unused. Required because DCL
#         applies textures at runtime to "image plane" meshes that have no
#         material in the static glTF — gltfpack would otherwise drop their
#         UVs as unused, breaking runtime texture sampling.
#   -vtf  store UVs as float instead of quantized int. glTFast has known issues
#         (#75, #814) interpreting non-normalized integer UVs from
#         KHR_mesh_quantization, which manifests as misaligned/garbled textures
#         on runtime-loaded image planes. Float UVs avoid the problem.
# gltfpack still quantizes normals, colors, and animations by default.

DEFAULT_ARGS="-tr -kn -vpf -kv -vtf"

set -euo pipefail

DIR="."
IN_PLACE=0
EXTRA_ARGS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --in-place) IN_PLACE=1; shift ;;
    --extra) EXTRA_ARGS="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

OUT_DIR="optimized"
if [[ "$IN_PLACE" == "1" ]]; then
  read -p "Overwrite originals in $DIR? [y/N] " confirm
  [[ "$confirm" == "y" || "$confirm" == "Y" ]] || exit 0
fi

GLTFPACK="${GLTFPACK:-./gltfpack_macos}"
[[ -x "$GLTFPACK" ]] || { echo "Missing gltfpack binary at $GLTFPACK" >&2; exit 1; }

REPORT="meshopt-report.tsv"
echo -e "before\tafter\tdelta\tpct\tfile" > "$REPORT"

while IFS= read -r -d '' SRC; do
  case "$SRC" in
    */node_modules/*|*/.git/*|*/optimized/*) continue ;;
  esac
  if [[ "$IN_PLACE" == "1" ]]; then
    DST="$SRC"
  else
    REL="${SRC#$DIR/}"
    DST="$DIR/$OUT_DIR/$REL"
    mkdir -p "$(dirname "$DST")"
  fi

  BEFORE=$(stat -f%z "$SRC")
  if ! "$GLTFPACK" -i "$SRC" -o "$DST" $DEFAULT_ARGS $EXTRA_ARGS 2>/dev/null; then
    echo "FAILED: $SRC" >&2
    continue
  fi
  AFTER=$(stat -f%z "$DST")
  DELTA=$(( BEFORE - AFTER ))
  PCT=$(awk "BEGIN { printf \"%.1f\", ($DELTA / $BEFORE) * 100 }")
  echo -e "${BEFORE}\t${AFTER}\t${DELTA}\t${PCT}\t${SRC}" >> "$REPORT"
done < <(find "$DIR" \( -name '*.glb' -o -name '*.gltf' \) -print0)

echo
echo "Top 20 savings:"
sort -t$'\t' -k3,3rn "$REPORT" | head -20 | awk -F'\t' '{ printf "  %s: %s -> %s (%s%%)\n", $5, $1, $2, $4 }'
