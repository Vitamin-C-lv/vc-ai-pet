# 李花花 v0.2 Storage Policy

## Live life data

Keep the already-proven v0.1 sandbox:

`~/.local/share/vc-ai-pet/sandbox`

This holds state, identity, pet-memory.db, room/home/toybox/diary data.
Do not migrate it merely to save C: space.

## Large local-model data

All large model/cache/temp paths are under:

`D:\VC-AI-Pet\`

WSL view:

`/mnt/d/VC-AI-Pet/`

Primary v0.2 model:

`D:\VC-AI-Pet\models\Qwen3.5-4B\Qwen3.5-4B-Q4_K_M.gguf`

Source model: official `Qwen/Qwen3.5-4B`.
Ready GGUF quant: `unsloth/Qwen3.5-4B-GGUF` Q4_K_M (~2.74 GB).

Required:
- model GGUF: D only
- model cache: D only
- model temp: D only
- no Hugging Face cache under `~/.cache`
- no model copy inside WSL ext4
- no model copy under Windows C:

v0.2 does NOT download an mmproj. Qwen3.5 is already a native multimodal family,
but visual inference is deliberately deferred to v0.3.

## Disaster recovery reservation

Reserve:

`E:\VC-AI-Pet-Backup`

Do not create a high-frequency live mirror in v0.2-A/B. E: is a mechanical disk.
Future survival backups should capture irreplaceable life data, not redownloadable model/build artifacts.
