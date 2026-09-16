#!/usr/bin/env python3
"""Read-only decoder for an ESP-IDF OTA data partition.

The script intentionally reads only the two ESP-IDF selection records at
partition offsets 0x0000 and 0x1000.  It never opens a serial port and never
writes a file or a device.
"""

from __future__ import annotations

import argparse
import binascii
import json
import struct
from pathlib import Path


COPY_OFFSETS = (0x0000, 0x1000)
ENTRY_SIZE = 32
PARTITION_SIZE = 0x2000
STATE_NAMES = {
    0x00000000: "NEW",
    0x00000001: "PENDING_VERIFY",
    0x00000002: "VALID",
    0x00000003: "INVALID",
    0x00000004: "ABORTED",
    0xFFFFFFFF: "UNDEFINED",
}


def crc_for_seq(raw_seq: bytes) -> int:
    """Match ESP-IDF esp_rom_crc32_le(UINT32_MAX, &ota_seq, 4)."""

    return binascii.crc32(raw_seq, 0xFFFFFFFF) & 0xFFFFFFFF


def decode(path: Path, app_count: int = 2) -> dict:
    data = path.read_bytes()
    if len(data) < PARTITION_SIZE:
        raise ValueError(
            f"expected at least 0x{PARTITION_SIZE:x} bytes, got {len(data)}"
        )
    if app_count < 1:
        raise ValueError("app_count must be positive")

    copies = []
    for index, offset in enumerate(COPY_OFFSETS):
        entry = data[offset : offset + ENTRY_SIZE]
        seq_raw = entry[0:4]
        seq = struct.unpack_from("<I", entry, 0)[0]
        state = struct.unpack_from("<I", entry, 24)[0]
        stored_crc = struct.unpack_from("<I", entry, 28)[0]
        computed_crc = crc_for_seq(seq_raw)
        invalid = seq == 0xFFFFFFFF or state in (0x3, 0x4)
        crc_valid = stored_crc == computed_crc
        valid_for_selection = (not invalid) and crc_valid
        slot = None
        if seq not in (0, 0xFFFFFFFF):
            slot = f"ota_{(seq - 1) % app_count}"
        copies.append(
            {
                "copy": index,
                "partitionOffset": f"0x{offset:04x}",
                "otaSeq": seq,
                "otaStateRaw": f"0x{state:08x}",
                "otaState": STATE_NAMES.get(state, "UNKNOWN"),
                "crcStored": f"0x{stored_crc:08x}",
                "crcComputed": f"0x{computed_crc:08x}",
                "crcValid": crc_valid,
                "validForSelection": valid_for_selection,
                "mappedSlot": slot,
            }
        )

    valid = [item for item in copies if item["validForSelection"]]
    selected_copy = None
    if valid:
        selected_copy = max(valid, key=lambda item: (item["otaSeq"], -item["copy"]))

    return {
        "file": str(path),
        "bytesRead": len(data),
        "copy0Offset": "0x0000",
        "copy1Offset": "0x1000",
        "appCount": app_count,
        "copies": copies,
        "selectedCopy": selected_copy["copy"] if selected_copy else None,
        "selectedSlot": selected_copy["mappedSlot"] if selected_copy else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, help="otadata binary readback")
    parser.add_argument("--app-count", type=int, default=2)
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()
    result = decode(args.path, args.app_count)
    if args.as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        for item in result["copies"]:
            print(
                "COPY{copy} OFFSET={partitionOffset} SEQ={otaSeq} "
                "STATE={otaState} STATE_RAW={otaStateRaw} "
                "CRC_STORED={crcStored} CRC_COMPUTED={crcComputed} "
                "CRC_VALID={crcValid} VALID_FOR_SELECTION={validForSelection} "
                "MAPPED_SLOT={mappedSlot}".format(**item)
            )
        print(f"SELECTED_COPY={result['selectedCopy']}")
        print(f"SELECTED_SLOT={result['selectedSlot']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
