#!/usr/bin/env bash
# Installs OpenMontage + free Piper voices (RU/EN). Safe to re-run.
# Can be pasted as-is into the cloud environment's "Setup script".
# Needs network access to github.com and huggingface.co.
set -e
OM="${OPENMONTAGE_DIR:-$HOME/openmontage}"
if [ ! -d "$OM/.git" ]; then
  GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/calesthio/openmontage "$OM"
fi
cd "$OM"
[ -x .venv/bin/python ] || make setup
mkdir -p "$HOME/.piper/models"
cd "$HOME/.piper/models"
for v in ru/ru_RU/denis/medium/ru_RU-denis-medium en/en_US/lessac/medium/en_US-lessac-medium; do
  f=$(basename "$v")
  [ -s "$f.onnx" ] || curl -fsSL -o "$f.onnx" "https://huggingface.co/rhasspy/piper-voices/resolve/main/$v.onnx"
  [ -s "$f.onnx.json" ] || curl -fsSL -o "$f.onnx.json" "https://huggingface.co/rhasspy/piper-voices/resolve/main/$v.onnx.json"
done
echo "OpenMontage ready in $OM (use $OM/.venv/bin/python)"
