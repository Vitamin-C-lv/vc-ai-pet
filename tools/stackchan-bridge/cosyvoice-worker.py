"""On-demand local CosyVoice worker for one StackChan bridge process."""

from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import subprocess
import sys
import time

import modelscope
import torch
import torchaudio

COSYVOICE_HOME = "/home/vitamin_c/.local/share/vc-ai-pet/tts/cosyvoice"
sys.path.insert(0, COSYVOICE_HOME + "/CosyVoice")
sys.path.insert(0, COSYVOICE_HOME + "/CosyVoice/third_party/Matcha-TTS")
original_snapshot_download = modelscope.snapshot_download


def cached_snapshot_download(model_id, *args, **kwargs):
    if model_id == "pengzhendong/wetext":
        return "/home/vitamin_c/.cache/modelscope/hub/pengzhendong/wetext"
    return original_snapshot_download(model_id, *args, **kwargs)


modelscope.snapshot_download = cached_snapshot_download

from cosyvoice.cli.cosyvoice import CosyVoice
from cosyvoice.utils.file_utils import load_wav

MODEL_DIR = "/home/vitamin_c/.cache/vc-ai-pet/models/CosyVoice-300M"
REFERENCE = "/mnt/d/CosyVoice-300M-NPU-Probe/luoxiaohei/reference-luoxiaohei-16k.wav"
PROMPT_TEXT = "那我也能学会你的吞噬吗？那我的领域是不是比你的吞噬厉害？"
ZERO_SHOT_SPK_ID = "huahua-luo-xiaohei"
IDLE_SECONDS = 900
PORT = int(os.environ.get("COSYVOICE_WORKER_PORT", "17873"))

free_mb = int(subprocess.check_output(
    ["/usr/lib/wsl/lib/nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"], text=True
).strip().splitlines()[0])
if free_mb < 2600:
    raise RuntimeError(f"CosyVoice prewarm needs 2600 MB free VRAM; only {free_mb} MB available")

model = CosyVoice(MODEL_DIR, load_jit=False, load_trt=False, fp16=True)
prompt = load_wav(REFERENCE, 16000)
prompt_cache_started = time.perf_counter()
model.add_zero_shot_spk(PROMPT_TEXT, prompt, ZERO_SHOT_SPK_ID)
prompt_cache_ms = (time.perf_counter() - prompt_cache_started) * 1000
last_used = time.monotonic()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            self.send_error(404)
            return
        payload = json.dumps({"status": "ready", "promptCacheMs": round(prompt_cache_ms, 1)}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        global last_used
        if self.path != "/synthesize":
            self.send_error(404)
            return
        try:
            request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            text = str(request["text"]).strip()
            if not text:
                raise ValueError("empty text")
            last_used = time.monotonic()
            synth_started = time.perf_counter()
            first_chunk_ms = None
            chunks = []
            with torch.inference_mode():
                for part in model.inference_zero_shot(
                    text, PROMPT_TEXT, prompt,
                    zero_shot_spk_id=ZERO_SHOT_SPK_ID, stream=True):
                    chunk = part["tts_speech"].detach().cpu()
                    if first_chunk_ms is None:
                        first_chunk_ms = (time.perf_counter() - synth_started) * 1000
                    chunks.append(chunk)
            pcm_ready_ms = (time.perf_counter() - synth_started) * 1000
            wave = torch.cat(chunks, dim=1).squeeze(0)
            duration_sec = wave.numel() / model.sample_rate
            resample_started = time.perf_counter()
            wave = torchaudio.functional.resample(wave, model.sample_rate, 24000)
            resample_ms = (time.perf_counter() - resample_started) * 1000
            pack_started = time.perf_counter()
            pcm = (wave.clamp(-1, 1).numpy() * 32767).astype("<i2").tobytes()
            pcm_pack_ms = (time.perf_counter() - pack_started) * 1000
            last_used = time.monotonic()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(pcm)))
            self.send_header("X-CosyVoice-First-Chunk-Ms", f"{first_chunk_ms:.1f}")
            self.send_header("X-CosyVoice-Pcm-Complete-Ms", f"{pcm_ready_ms:.1f}")
            self.send_header("X-CosyVoice-Resample-Ms", f"{resample_ms:.1f}")
            self.send_header("X-CosyVoice-Pcm-Pack-Ms", f"{pcm_pack_ms:.1f}")
            self.send_header("X-CosyVoice-Audio-Duration-Sec", f"{duration_sec:.3f}")
            self.send_header("X-CosyVoice-Rtf", f"{pcm_ready_ms / 1000 / duration_sec:.3f}")
            self.end_headers()
            self.wfile.write(pcm)
        except Exception as error:
            self.send_error(500, str(error))

    def log_message(self, format, *args):
        print(format % args, flush=True)


server = HTTPServer(("127.0.0.1", PORT), Handler)
server.timeout = 2
print(f"COSYVOICE_READY port={PORT}", flush=True)
while time.monotonic() - last_used < IDLE_SECONDS:
    server.handle_request()
server.server_close()
