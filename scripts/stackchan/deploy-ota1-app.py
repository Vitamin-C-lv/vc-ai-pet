#!/usr/bin/env python3
"""Deploy one app-only image to ota_1 while preserving ota_0.

The device must currently be running ota_1.  The script first boots the
preserved ota_0, then writes and verifies only ota_1, selects ota_1 using the
other otadata sector, and captures the first boot until rollback validation.
"""

from __future__ import annotations

import argparse
import tempfile
import time
from pathlib import Path

import esptool
import serial
from esptool.reset import HardReset

try:
    from ota_metadata import next_selector_update, selector_sector, decode_selector
except ModuleNotFoundError:  # pragma: no cover - package-style imports
    from scripts.stackchan.ota_metadata import next_selector_update, selector_sector, decode_selector


OTA_DATA_OFFSET = 0xD000
OTA_0_OFFSET = 0x20000
OTA_1_OFFSET = 0x510000
OTA_SLOT_SIZE = 0x4F0000
SECTOR_SIZE = 0x1000
OTADATA_SIZE = 0x2000


def esptool_main(port: str, *args: str) -> None:
    esptool.main(["--chip", "esp32s3", "--port", port, "--baud", "115200", *args])


def read_otadata(port: str, output: Path) -> bytes:
    output.unlink(missing_ok=True)
    esptool_main(port, "read_flash", hex(OTA_DATA_OFFSET), hex(OTADATA_SIZE), str(output))
    metadata = output.read_bytes()
    if len(metadata) != OTADATA_SIZE:
        raise SystemExit("OTADATA_READ_LENGTH_INVALID")
    return metadata


def write_selector_and_verify(
    port: str,
    metadata: bytes,
    copy: int,
    seq: int,
    selector_path: Path,
    readback_path: Path,
) -> None:
    selector_path.write_bytes(selector_sector(metadata, copy, seq))
    offset = OTA_DATA_OFFSET + copy * SECTOR_SIZE
    esptool_main(
        port,
        "--after",
        "no_reset",
        "write_flash",
        hex(offset),
        str(selector_path),
    )
    readback = read_otadata(port, readback_path)
    selector = decode_selector(readback, copy)
    if not selector.valid or selector.sequence != seq or selector.slot != (seq - 1) % 2:
        raise SystemExit(f"OTADATA_READBACK_INVALID:copy={copy}:seq={seq}")


def write_ota1_image_and_verify(port: str, image: Path) -> None:
    if OTA_1_OFFSET == OTA_0_OFFSET:
        raise SystemExit("OTA_SLOT_OFFSETS_COLLIDE")
    esptool_main(port, "--after", "no_reset", "write_flash", hex(OTA_1_OFFSET), str(image))
    esptool_main(port, "verify_flash", hex(OTA_1_OFFSET), str(image))


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
        # Read fresh metadata for this mutation and select the inactive copy.
        metadata = read_otadata(args.port, temp / "otadata-before-ota0.bin")
        ota0_selector = temp / "select-ota0.bin"
        ota0_copy, ota0_seq = next_selector_update(metadata, slot=0)
        write_selector_and_verify(
            args.port,
            metadata,
            ota0_copy,
            ota0_seq,
            ota0_selector,
            temp / "otadata-after-ota0-selector.bin",
        )
        ota0_log = capture_boot(args.port, evidence / "ota0-safety-boot.log")
        if "Loaded app from partition at offset 0x20000" not in ota0_log:
            raise SystemExit("OTA0_SAFETY_BOOT_NOT_PROVEN")

        # A failed write/verify raises here, so no ota_1 selector is changed.
        write_ota1_image_and_verify(args.port, image)

        # Read fresh metadata after the image transaction.  Boot state changes
        # may have modified either copy, so stale metadata must never plan this
        # second selector write.
        metadata = read_otadata(args.port, temp / "otadata-before-ota1.bin")
        ota1_selector = temp / "select-ota1.bin"
        ota1_copy, ota1_seq = next_selector_update(metadata, slot=1)
        write_selector_and_verify(
            args.port,
            metadata,
            ota1_copy,
            ota1_seq,
            ota1_selector,
            temp / "otadata-after-ota1-selector.bin",
        )
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
