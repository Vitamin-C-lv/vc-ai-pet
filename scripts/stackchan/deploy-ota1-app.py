#!/usr/bin/env python3
"""Deploy one app-only image to ota_1 while preserving ota_0.

The device must currently be running ota_1.  The script first boots the
preserved ota_0, then writes and verifies only ota_1, selects ota_1 using the
other otadata sector, and captures the first boot until rollback validation.
"""

from __future__ import annotations

import argparse
import binascii
import os
import struct
import tempfile
import time
from pathlib import Path

import esptool
import serial
from esptool.reset import HardReset


OTA_DATA_OFFSET = 0xD000
OTA_0_OFFSET = 0x20000
OTA_1_OFFSET = 0x510000
OTA_SLOT_SIZE = 0x4F0000
SECTOR_SIZE = 0x1000


def crc(seq: int) -> int:
    return binascii.crc32(struct.pack("<I", seq), 0xFFFFFFFF) & 0xFFFFFFFF


def selector_sector(metadata: bytes, copy: int, seq: int) -> bytes:
    start = copy * SECTOR_SIZE
    sector = bytearray(metadata[start : start + SECTOR_SIZE])
    struct.pack_into("<I", sector, 0, seq)
    struct.pack_into("<I", sector, 24, 0)  # ESP_OTA_IMG_NEW
    struct.pack_into("<I", sector, 28, crc(seq))
    return bytes(sector)


def valid_sequence(metadata: bytes, copy: int) -> int | None:
    start = copy * SECTOR_SIZE
    sector = metadata[start : start + SECTOR_SIZE]
    seq = struct.unpack_from("<I", sector, 0)[0]
    state = struct.unpack_from("<I", sector, 24)[0]
    stored_crc = struct.unpack_from("<I", sector, 28)[0]
    if seq == 0xFFFFFFFF or stored_crc != crc(seq) or state in (3, 4):
        return None
    return seq


def next_sequence_for_slot(metadata: bytes, slot: int) -> int:
    sequences = [valid_sequence(metadata, copy) for copy in range(2)]
    current = max((seq for seq in sequences if seq is not None), default=0)
    candidate = current + 1
    while (candidate - 1) % 2 != slot:
        candidate += 1
    return candidate


def esptool_main(port: str, *args: str) -> None:
    esptool.main(["--chip", "esp32s3", "--port", port, "--baud", "115200", *args])


def capture_boot(port: str, output: Path, seconds: int = 43) -> str:
    device = serial.Serial()
    device.port = port
    device.baudrate = 115200
    device.timeout = 0.2
    device.dtr = False
    device.rts = False
    device.open()
    HardReset(device, uses_usb=True)()
    deadline = time.monotonic() + seconds
    chunks: list[bytes] = []
    while time.monotonic() < deadline:
        try:
            chunks.append(device.read(max(1, device.in_waiting)))
        except serial.SerialException:
            device.close()
            time.sleep(0.3)
            try:
                device.open()
            except serial.SerialException:
                time.sleep(0.3)
    device.close()
    raw = b"".join(chunks)
    output.write_bytes(raw)
    return raw.decode(errors="replace")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", default="COM5")
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    args = parser.parse_args()

    image = args.image.resolve()
    evidence = args.evidence_dir.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    image_bytes = image.read_bytes()
    if not image_bytes or image_bytes[0] != 0xE9 or len(image_bytes) > OTA_SLOT_SIZE:
        raise SystemExit("OTA1_IMAGE_INVALID_OR_TOO_LARGE")

    with tempfile.TemporaryDirectory(prefix="lihuahua-ota1-") as temporary:
        temp = Path(temporary)
        metadata_path = temp / "otadata.bin"
        esptool_main(args.port, "read_flash", hex(OTA_DATA_OFFSET), "0x2000", str(metadata_path))
        metadata = metadata_path.read_bytes()
        if len(metadata) != 0x2000:
            raise SystemExit("OTADATA_READ_LENGTH_INVALID")

        # Next monotonic sequence for two OTA slots: odd selects ota_0.
        ota0_selector = temp / "select-ota0.bin"
        ota0_seq = next_sequence_for_slot(metadata, slot=0)
        ota0_selector.write_bytes(selector_sector(metadata, copy=0, seq=ota0_seq))
        esptool_main(args.port, "--after", "no_reset", "write_flash", "0xD000", str(ota0_selector))
        ota0_log = capture_boot(args.port, evidence / "ota0-safety-boot.log")
        if "Loaded app from partition at offset 0x20000" not in ota0_log:
            raise SystemExit("OTA0_SAFETY_BOOT_NOT_PROVEN")

        esptool_main(args.port, "--after", "no_reset", "write_flash", hex(OTA_1_OFFSET), str(image))
        esptool_main(args.port, "verify_flash", hex(OTA_1_OFFSET), str(image))

        # Even sequence selects ota_1; copy0 and the ota_0 app remain untouched.
        ota1_selector = temp / "select-ota1.bin"
        ota1_seq = next_sequence_for_slot(metadata, slot=1)
        ota1_selector.write_bytes(selector_sector(metadata, copy=1, seq=ota1_seq))
        esptool_main(args.port, "--after", "no_reset", "write_flash", "0xE000", str(ota1_selector))
        ota1_log = capture_boot(args.port, evidence / "ota1-first-boot.log")
        required = (
            "Loaded app from partition at offset 0x510000",
            "partition=ota_1, state=1",
            "marking current app valid",
        )
        missing = [item for item in required if item not in ota1_log]
        if missing:
            raise SystemExit("OTA1_ACCEPTANCE_MISSING:" + ",".join(missing))

    print(f"OTA1_IMAGE_BYTES={len(image_bytes)}")
    print("OTA0_APP_WRITES=0")
    print("OTA1_WRITE_VERIFIED=YES")
    print("OTA1_FIRST_BOOT_VALIDATED=YES")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
