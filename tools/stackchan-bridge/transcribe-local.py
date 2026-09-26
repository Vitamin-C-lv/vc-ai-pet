#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
from pathlib import Path

from vosk import KaldiRecognizer, Model, SetLogLevel


WAKE_GRAMMAR_TIERS = [
    (1, ["花花 在 吗", "花花", "[unk]"]),
    (2, ["花花 在吗", "花花", "[unk]"]),
    (3, ["花花", "[unk]"]),
]


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
        return full, None, None, True, None
    full.SetWords(True)

    last_error = None
    for tier, words in WAKE_GRAMMAR_TIERS:
        verifier, warning, error = make_grammar_recognizer(model, sample_rate, words)
        missing = re.search(r"Ignoring word missing in vocabulary: '([^']+)'", warning)
        if verifier is not None and missing is None:
            return full, verifier, tier, True, None
        last_error = missing.group(1) if missing else (error or warning.strip() or "grammar-unavailable")
    return full, None, "FALLBACK", False, last_error


def make_grammar_recognizer(model, sample_rate, words):
    read_fd, write_fd = os.pipe()
    saved_stderr = os.dup(2)
    try:
        os.dup2(write_fd, 2)
        grammar = json.dumps(words, ensure_ascii=False)
        verifier = KaldiRecognizer(model, sample_rate, grammar)
        verifier.SetWords(True)
    except Exception as error:
        verifier = None
        failure = str(error)
    else:
        failure = None
    finally:
        os.dup2(saved_stderr, 2)
        os.close(write_fd)
        warning = os.read(read_fd, 4096).decode("utf-8", errors="replace")
        os.close(read_fd)
        os.close(saved_stderr)
    return verifier, warning, failure


def recognize(model, pcm_path, sample_rate, wake_mode):
    full, verifier, grammar_tier, grammar_supported, grammar_error = make_recognizers(
        model, sample_rate, wake_mode)

    with pcm_path.open("rb") as source:
        while chunk := source.read(8000):
            full.AcceptWaveform(chunk)
            if verifier is not None:
                verifier.AcceptWaveform(chunk)

    full_result = json.loads(full.FinalResult())
    text = str(full_result.get("text", "")).strip()
    if not wake_mode:
        return text

    full_words, full_confidence = words_and_confidence(full_result)
    wake_result = json.loads(verifier.FinalResult()) if verifier is not None else {}
    wake_text = str(wake_result.get("text", "")).strip()
    wake_words, wake_confidence = words_and_confidence(wake_result)
    if verifier is None:
        # Fallback is intentionally local and keeps the previous behavior.
        wake_text = text
        wake_words = full_words
        wake_confidence = full_confidence

    return {
        "text": text,
        "words": full_words,
        "confidence": full_confidence,
        "wakeText": wake_text,
        "wakeWords": wake_words,
        "wakeConfidence": wake_confidence,
        "grammarTier": grammar_tier,
        "grammarSupported": grammar_supported,
        "missingWord": (grammar_error or "花花") if not grammar_supported else None,
        "grammarError": grammar_error,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--pcm", type=Path)
    parser.add_argument("--sample-rate", type=float, default=24000)
    parser.add_argument("--wake-mode", action="store_true")
    parser.add_argument("--worker", action="store_true")
    args = parser.parse_args()

    SetLogLevel(-1)
    model = Model(str(args.model))
    if args.worker:
        print(json.dumps({"ready": True}), flush=True)
        for line in sys.stdin:
            request = json.loads(line)
            try:
                result = recognize(
                    model,
                    Path(request["pcm"]),
                    float(request["sampleRate"]),
                    request.get("wakeMode") is True,
                )
                response = {"requestId": request["requestId"], "ok": True, "result": result}
            except Exception as error:
                response = {"requestId": request["requestId"], "ok": False, "error": str(error)[:120]}
            print(json.dumps(response, ensure_ascii=False), flush=True)
        return 0

    if args.pcm is None:
        parser.error("--pcm is required without --worker")
    result = recognize(model, args.pcm, args.sample_rate, args.wake_mode)
    print(result if isinstance(result, str) else json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
