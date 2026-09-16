#!/usr/bin/env python3
"""Perform a small, offline ESP image envelope check.

This helper is deliberately independent of esptool.  It checks the image
magic and segment boundaries and reports erased-space statistics.  Full
checksum, appended-hash, chip/revision and app-descriptor validation remains
the responsibility of the official ESP-IDF ``esptool image_info`` command.
The helper never opens a serial port and never writes a file or a device.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
from pathlib import Path


IMAGE_MAGIC = 0xE9
MAX_SEGMENTS = 16


def inspect(path: Path) -> dict:
    data = path.read_bytes()
    result = {
        "file": str(path),
        "fileBytes": len(data),
        "imageMagic": f"0x{data[0]:02x}" if data else None,
        "headerValid": len(data) >= 24 and bool(data) and data[0] == IMAGE_MAGIC,
        "segmentCount": data[1] if len(data) >= 2 else None,
        "segmentsValid": False,
        "segmentLengths": [],
        "nonFfBytes": sum(byte != 0xFF for byte in data),
    }
    if result["fileBytes"]:
        result["ffPercent"] = round(
            100.0 * (result["fileBytes"] - result["nonFfBytes"]) / result["fileBytes"],
            6,
        )
    else:
        result["ffPercent"] = math.nan

    count = result["segmentCount"]
    if not result["headerValid"] or count is None or count > MAX_SEGMENTS:
        return result

    cursor = 24
    lengths = []
    try:
        for _ in range(count):
            if cursor + 8 > len(data):
                return result
            _load_addr, length = struct.unpack_from("<II", data, cursor)
            cursor += 8
            if cursor + length > len(data):
                return result
            lengths.append(length)
            cursor += length
            cursor = (cursor + 3) & ~3
    except struct.error:
        return result

    result["segmentLengths"] = lengths
    result["segmentsValid"] = True
    result["imageDataEndOffset"] = cursor
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()
    result = inspect(args.path)
    if args.as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False, sort_keys=True))
    else:
        for key, value in result.items():
            print(f"{key.upper()}={value}")
    return 0 if result["headerValid"] and result["segmentsValid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
