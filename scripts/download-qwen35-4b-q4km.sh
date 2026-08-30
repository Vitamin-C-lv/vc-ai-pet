#!/usr/bin/env bash
set -euo pipefail

ROOT="/mnt/d/VC-AI-Pet"
MODEL_DIR="$ROOT/models/Qwen3.5-4B"
MODEL="$MODEL_DIR/Qwen3.5-4B-Q4_K_M.gguf"
PART="$MODEL.part"

# Official upstream model: Qwen/Qwen3.5-4B (Apache-2.0).
# GGUF quantization source: unsloth/Qwen3.5-4B-GGUF.
# We use a ready GGUF to avoid downloading/converting the much larger BF16/safetensors
# model and creating temporary multi-GB copies on C:/WSL.
REVISION="720bb031aae5488eae5d6a78768e6d826662b2ae"
EXPECTED_SIZE_BYTES=2740937888
EXPECTED_SHA256="00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4"
URL="https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/${REVISION}/Qwen3.5-4B-Q4_K_M.gguf?download=true"

mkdir -p "$MODEL_DIR" "$ROOT/cache" "$ROOT/temp"
export HF_HOME="$ROOT/cache"
export HUGGINGFACE_HUB_CACHE="$ROOT/cache"
export XDG_CACHE_HOME="$ROOT/cache"
export TMPDIR="$ROOT/temp"
export TMP="$ROOT/temp"
export TEMP="$ROOT/temp"

if [[ -f "$MODEL" ]]; then
  SIZE="$(stat -c %s "$MODEL")"
  if (( SIZE > 2500000000 )); then
    echo "MODEL_ALREADY_PRESENT=$MODEL"
    echo "MODEL_BYTES=$SIZE"
    echo "MODEL_STORAGE_D_ONLY=PASS"
    echo "MMPROJ_DOWNLOADED=NO"
    exit 0
  fi
fi

echo "Downloading Qwen3.5-4B Q4_K_M GGUF directly to D: ..."
curl --location \
  --fail \
  --retry 15 \
  --retry-all-errors \
  --retry-delay 5 \
  --connect-timeout 30 \
  --continue-at - \
  --output "$PART" \
  "$URL"

SIZE="$(stat -c %s "$PART")"
if (( SIZE != EXPECTED_SIZE_BYTES )); then
  echo "ERROR: downloaded file has unexpected size: $SIZE bytes (expected $EXPECTED_SIZE_BYTES)" >&2
  rm -f "$PART"
  exit 3
fi

SHA256="$(sha256sum "$PART" | awk '{print $1}')"
if [[ "$SHA256" != "$EXPECTED_SHA256" ]]; then
  echo "ERROR: downloaded file has unexpected SHA-256: $SHA256" >&2
  rm -f "$PART"
  exit 4
fi

mv -f "$PART" "$MODEL"

echo "UPSTREAM_MODEL=Qwen/Qwen3.5-4B"
echo "GGUF_SOURCE=unsloth/Qwen3.5-4B-GGUF"
echo "MODEL_PATH=$MODEL"
echo "MODEL_BYTES=$SIZE"
echo "MODEL_SHA256=$SHA256"
echo "MODEL_STORAGE_D_ONLY=PASS"
echo "MMPROJ_DOWNLOADED=NO"
