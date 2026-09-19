#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

from vosk import KaldiRecognizer, Model, SetLogLevel


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--pcm", type=Path, required=True)
    parser.add_argument("--sample-rate", type=float, default=24000)
    parser.add_argument("--wake-mode", action="store_true")
    args = parser.parse_args()

    SetLogLevel(-1)
    recognizer = KaldiRecognizer(Model(str(args.model)), args.sample_rate)
    if args.wake_mode:
        recognizer.SetWords(True)
    with args.pcm.open("rb") as source:
        while chunk := source.read(8000):
            recognizer.AcceptWaveform(chunk)
    result = json.loads(recognizer.FinalResult())
    text = str(result.get("text", "")).strip()
    if not args.wake_mode:
        # Preserve the existing microphone STT contract: one plain text line.
        print(text)
        return 0

    words = []
    for item in result.get("result", []):
        if not isinstance(item, dict) or not isinstance(item.get("word"), str):
            continue
        try:
            confidence = float(item.get("conf", 0.0))
        except (TypeError, ValueError):
            confidence = 0.0
        words.append({"word": item["word"], "conf": confidence})
    confidence = sum(item["conf"] for item in words) / len(words) if words else 0.0
    print(json.dumps({"text": text, "words": words, "confidence": confidence}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
