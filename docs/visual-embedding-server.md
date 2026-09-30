# Local visual embedding service

The service computes Chinese-CLIP image and text vectors for Pet-owned visual
retrieval. It is separate from the shared Local Brain and does not load the Qwen
VLM. It uses CUDA FP16 when PyTorch can see a GPU, otherwise it uses CPU FP32.
The process binds only to 127.0.0.1:17863. Production runs it through the
Pet-owned `vc-ai-pet-visual-encoder.service` unit; a manual foreground launch
is also available for testing.

## Install

Run from the vc-ai-pet repository:

    python3 -m venv /home/vitamin_c/.local/share/vc-ai-pet/visual-encoder/venv
    /home/vitamin_c/.local/share/vc-ai-pet/visual-encoder/venv/bin/python -m pip install -r requirements-visual-embedding.txt

The requirements file uses the official PyTorch CUDA 12.8 wheel index and PyPI.
CUDA support uses the existing Windows NVIDIA driver through WSL; do not install
a Linux NVIDIA driver or CUDA toolkit in WSL. The persistent model directory is
/mnt/d/VC-AI-Pet/models/Chinese-CLIP-ViT-B16. Download only the model files
listed below at revision
36e679e65c2a2fead755ae21162091293ad37834; the service runs offline with
local_files_only enabled.

    /home/vitamin_c/.local/share/vc-ai-pet/visual-encoder/venv/bin/python -c 'from huggingface_hub import snapshot_download; snapshot_download(repo_id="OFA-Sys/chinese-clip-vit-base-patch16", revision="36e679e65c2a2fead755ae21162091293ad37834", local_dir="/mnt/d/VC-AI-Pet/models/Chinese-CLIP-ViT-B16", allow_patterns=["config.json", "preprocessor_config.json", "pytorch_model.bin", "vocab.txt"])'

This selects the single Transformers checkpoint, about 753 MB. The repository
also contains an equivalent 753 MB training checkpoint named
clip_cn_vit-b-16.pt; it is not needed here.

## Run

    /home/vitamin_c/.local/share/vc-ai-pet/visual-encoder/venv/bin/python scripts/visual-embedding-server.py

GET http://127.0.0.1:17863/health reports model readiness. POST
http://127.0.0.1:17863/v1/embeddings accepts an array of text entries and/or
base64 image data URLs:

    {"input":[{"text":"一只趴在沙发上的狗"},{"image":"data:image/jpeg;base64,..."}]}

The response contains one L2-normalized 512-dimensional vector per input in
the same order, with the corresponding input index. Text is encoded together;
text tokenization truncates at the model's configured 512-token maximum.
Images are processed in batches of four. The health response reports the active
device and dtype. Stop the manually started process with Ctrl-C when the
one-shot use is complete.

Transformers is pinned to 4.52.4: the tested 4.57.1 Chinese-CLIP text path used
a missing pooled output and failed. The encoder uses the supported CLS-token
projection in the pinned release. On this machine the CUDA Python environment
uses about 6.54 GiB of disk, in addition to the approximately 718 MiB model.

## Production service and index

Install `scripts/vc-ai-pet-visual-encoder.service` in `/etc/systemd/system/`,
then enable and start that unit. It restarts on failure and uses offline model
loading. GPU initialization falls back to CPU when CUDA is unavailable.

    node scripts/build-visual-semantic-index.mjs --sandbox-root /home/vitamin_c/.local/share/vc-ai-pet/sandbox

The command reads existing conversation metadata and thumbnail files. It writes
only the derived embedding table in the existing Pet visual-experience database.
Runtime indexing processes new or changed photos in the background; image bytes
are not read during vector search. Image and original owner-caption vectors are
ranked separately and fused into at most five candidates. The leading two
eligible originals are checked by the existing local VLM before any photo is
sent. Named subject recall additionally checks the original owner labels so a
different named pet cannot be relabelled by the model. No hidden reasoning is
published or used as confirmed memory.
