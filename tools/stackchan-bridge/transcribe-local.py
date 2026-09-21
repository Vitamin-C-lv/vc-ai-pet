#!/usr/bin/env python3
import argparse
import json
import os
import re
from pathlib import Path

from vosk import KaldiRecognizer, Model, SetLogLevel


WAKE_GRAMMAR = ["花花", "花花在吗", "[unk]"]


def words_and_confidence(result):
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
    return words, confidence


def make_recognizers(model, sample_rate, wake_mode):
    full = KaldiRecognizer(model, sample_rate)
    if not wake_mode:
        return full, None, True, None
    full.SetWords(True)
    read_fd, write_fd = os.pipe()
    saved_stderr = os.dup(2)
    try:
        os.dup2(write_fd, 2)
        grammar = json.dumps(WAKE_GRAMMAR, ensure_ascii=False)
        verifier = KaldiRecognizer(model, sample_rate, grammar)
        verifier.SetWords(True)
    except Exception as error:
        os.dup2(saved_stderr, 2)
        os.close(write_fd)
        warning = os.read(read_fd, 4096).decode("utf-8", errors="replace")
        os.close(read_fd)
        os.close(saved_stderr)
        return full, None, False, str(error) + (":" + warning.strip() if warning.strip() else "")
    else:
        os.dup2(saved_stderr, 2)
        os.close(write_fd)
        warning = os.read(read_fd, 4096).decode("utf-8", errors="replace")
        os.close(read_fd)
        os.close(saved_stderr)
        missing = re.search(r"Ignoring word missing in vocabulary: '([^']+)'", warning)
        if missing:
            return full, None, False, missing.group(1)
        return full, verifier, True, None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--pcm", type=Path, required=True)
    parser.add_argument("--sample-rate", type=float, default=24000)
    parser.add_argument("--wake-mode", action="store_true")
    args = parser.parse_args()

    SetLogLevel(-1)
    model = Model(str(args.model))
    full, verifier, grammar_supported, grammar_error = make_recognizers(
        model, args.sample_rate, args.wake_mode)

    with args.pcm.open("rb") as source:
        while chunk := source.read(8000):
            full.AcceptWaveform(chunk)
            if verifier is not None:
                verifier.AcceptWaveform(chunk)

    full_result = json.loads(full.FinalResult())
    text = str(full_result.get("text", "")).strip()
    if not args.wake_mode:
        # Preserve the existing microphone STT contract: one plain text line.
        print(text)
        return 0

    full_words, full_confidence = words_and_confidence(full_result)
    wake_result = json.loads(verifier.FinalResult()) if verifier is not None else {}
    wake_text = str(wake_result.get("text", "")).strip()
    wake_words, wake_confidence = words_and_confidence(wake_result)
    if verifier is None:
        # Fallback is intentionally local and keeps the previous behavior.
        wake_text = text
        wake_words = full_words
        wake_confidence = full_confidence

    print(json.dumps({
        "text": text,
        "words": full_words,
        "confidence": full_confidence,
        "wakeText": wake_text,
        "wakeWords": wake_words,
        "wakeConfidence": wake_confidence,
        "grammarSupported": grammar_supported,
        "missingWord": (grammar_error or "花花") if not grammar_supported else None,
        "grammarError": grammar_error,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
