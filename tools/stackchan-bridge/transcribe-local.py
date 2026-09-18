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
    args = parser.parse_args()

    SetLogLevel(-1)
    recognizer = KaldiRecognizer(Model(str(args.model)), args.sample_rate)
    with args.pcm.open("rb") as source:
        while chunk := source.read(8000):
            recognizer.AcceptWaveform(chunk)
    result = json.loads(recognizer.FinalResult())
    print(str(result.get("text", "")).strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
