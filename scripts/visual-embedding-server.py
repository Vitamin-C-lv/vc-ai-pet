#!/usr/bin/env python3
"""Loopback CUDA/CPU Chinese CLIP embedding service for visual retrieval."""

import base64
import binascii
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import BytesIO
from pathlib import Path
from urllib.parse import urlsplit

import torch
from PIL import Image, UnidentifiedImageError
from transformers import ChineseCLIPModel, ChineseCLIPProcessor

MODEL_ID = "OFA-Sys/chinese-clip-vit-base-patch16"
MODEL_REVISION = "36e679e65c2a2fead755ae21162091293ad37834"
MODEL_NAME = f"{MODEL_ID}@{MODEL_REVISION}"
MODEL_DIRECTORY = Path("/mnt/d/VC-AI-Pet/models/Chinese-CLIP-ViT-B16")
HOST = "127.0.0.1"
PORT = 17863
DIMENSION = 512
IMAGE_BATCH_SIZE = 4


def _image_from_data_url(value):
    header, separator, encoded = value.partition(",")
    if not separator or not header.lower().startswith("data:image/") or ";base64" not in header.lower():
        raise ValueError("image must be a base64 data URL")
    try:
        image_data = base64.b64decode(encoded, validate=True)
        with Image.open(BytesIO(image_data)) as image:
            return image.convert("RGB")
    except (binascii.Error, OSError, UnidentifiedImageError) as error:
        raise ValueError("image data could not be decoded") from error


def encode_items(items, processor, model):
    """Encode text and data-URL images into one normalized shared space."""
    if not isinstance(items, list) or not items:
        raise ValueError("input must be a non-empty array")

    results = [None] * len(items)
    text_positions = []
    texts = []
    image_positions = []
    image_urls = []

    for index, item in enumerate(items):
        if not isinstance(item, dict) or len(item) != 1:
            raise ValueError("each input item must contain exactly one text or image field")
        if "text" in item and isinstance(item["text"], str) and item["text"].strip():
            text_positions.append(index)
            texts.append(item["text"])
        elif "image" in item and isinstance(item["image"], str):
            image_positions.append(index)
            image_urls.append(item["image"])
        else:
            raise ValueError("input items require non-empty text or a base64 image data URL")

    with torch.inference_mode():
        if texts:
            text_inputs = processor(
                text=texts,
                padding=True,
                truncation=True,
                max_length=model.config.text_config.max_position_embeddings,
                return_tensors="pt",
            )
            text_inputs = {name: tensor.to(model.device) for name, tensor in text_inputs.items()}
            text_features = model.get_text_features(**text_inputs)
            normalized = torch.nn.functional.normalize(text_features.float(), p=2, dim=-1)
            for index, vector in zip(text_positions, normalized.tolist()):
                results[index] = vector

        for start in range(0, len(image_urls), IMAGE_BATCH_SIZE):
            end = min(start + IMAGE_BATCH_SIZE, len(image_urls))
            images = [_image_from_data_url(url) for url in image_urls[start:end]]
            image_inputs = processor(images=images, return_tensors="pt")
            image_inputs = {name: tensor.to(model.device) for name, tensor in image_inputs.items()}
            image_inputs["pixel_values"] = image_inputs["pixel_values"].to(dtype=model.dtype)
            image_features = model.get_image_features(**image_inputs)
            normalized = torch.nn.functional.normalize(image_features.float(), p=2, dim=-1)
            for index, vector in zip(image_positions[start:end], normalized.tolist()):
                results[index] = vector

    return [{"index": index, "embedding": vector} for index, vector in enumerate(results)]


class EmbeddingHandler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlsplit(self.path).path == "/health":
            device = self.server.model.device
            if device.type == "cuda":
                memory_allocated = round(torch.cuda.memory_allocated(device) / 1024**2, 1)
                memory_reserved = round(torch.cuda.memory_reserved(device) / 1024**2, 1)
            else:
                memory_allocated = 0.0
                memory_reserved = 0.0
            self._send_json(200, {
                "status": "ok",
                "model": MODEL_NAME,
                "dimension": DIMENSION,
                "device": str(device),
                "dtype": str(self.server.model.dtype).removeprefix("torch."),
                "cuda_memory_allocated_mib": memory_allocated,
                "cuda_memory_reserved_mib": memory_reserved,
            })
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if urlsplit(self.path).path != "/v1/embeddings":
            self._send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1:
                raise ValueError("request body is required")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("request body must be a JSON object")
            data = encode_items(payload.get("input"), self.server.processor, self.server.model)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            self._send_json(400, {"error": str(error)})
            return
        self._send_json(200, {"model": MODEL_NAME, "dimension": DIMENSION, "data": data})

    def log_message(self, _format, *_args):
        pass


def load_encoder():
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    processor = ChineseCLIPProcessor.from_pretrained(
        str(MODEL_DIRECTORY),
        local_files_only=True,
    )
    device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
    dtype = torch.float16 if device.type == "cuda" else torch.float32
    model = ChineseCLIPModel.from_pretrained(
        str(MODEL_DIRECTORY),
        local_files_only=True,
    ).to(device=device, dtype=dtype)
    model.eval()
    return processor, model


def main():
    processor, model = load_encoder()
    server = HTTPServer((HOST, PORT), EmbeddingHandler)
    server.processor = processor
    server.model = model
    print(
        f"ChineseCLIP {model.device} {model.dtype} encoder listening on http://{HOST}:{PORT}",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
