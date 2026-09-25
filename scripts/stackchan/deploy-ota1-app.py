#!/usr/bin/env python3
"""Deploy one app-only image to ota_1 while preserving ota_0.

The device must currently be running ota_1.  The script first boots the
preserved ota_0, then writes and verifies only ota_1, selects ota_1 using the
other otadata sector, and captures the first boot until rollback validation.
"""

from __future__ import annotations

import argparse
import struct
import tempfile
import time
from pathlib import Path

import esptool
import serial
from esptool.reset import HardReset

try:
    from ota_metadata import OTA_IMG_NEW, OTA_IMG_VALID, next_selector_update, selector_sector, decode_selector
except ModuleNotFoundError:  # pragma: no cover - package-style imports
    from scripts.stackchan.ota_metadata import OTA_IMG_NEW, OTA_IMG_VALID, next_selector_update, selector_sector, decode_selector


OTA_DATA_OFFSET = 0xD000
OTA_0_OFFSET = 0x20000
OTA_1_OFFSET = 0x510000
OTA_SLOT_SIZE = 0x4F0000
SECTOR_SIZE = 0x1000
OTADATA_SIZE = 0x2000
PARTITION_TABLE_OFFSET = 0x8000
PARTITION_TABLE_READ_SIZE = 0x1000
PARTITION_ENTRY_SIZE = 0x20
PARTITION_MAGIC = 0x50AA


def esptool_main(port: str, *args: str) -> None:
    esptool.main(["--chip", "esp32s3", "--port", port, "--baud", "115200", *args])


def verify_chip_mac(port: str, expected_mac: str) -> None:
    """Bind a flash transaction to the user-confirmed physical ESP32-S3."""
    expected = expected_mac.lower().replace(":", "")
    if len(expected) != 12 or any(char not in "0123456789abcdef" for char in expected):
        raise SystemExit("EXPECTED_MAC_INVALID")
    chip = esptool.connect_esp(port=port, chip="esp32s3")
    try:
        actual = "".join(f"{byte:02x}" for byte in chip.read_mac("BASE_MAC"))
    finally:
        try:
            chip.hard_reset(uses_usb=True)
        finally:
            chip._port.close()
    if actual != expected:
        raise SystemExit("DEVICE_IDENTITY_MISMATCH")


def read_otadata(port: str, output: Path, *, no_reset: bool = False) -> bytes:
    output.unlink(missing_ok=True)
    after = ("--after", "no_reset") if no_reset else ()
    esptool_main(port, *after, "read_flash", hex(OTA_DATA_OFFSET), hex(OTADATA_SIZE), str(output))
    metadata = output.read_bytes()
    if len(metadata) != OTADATA_SIZE:
        raise SystemExit("OTADATA_READ_LENGTH_INVALID")
    return metadata


def read_partition_layout(port: str, output: Path) -> dict[str, tuple[int, int]]:
    """Read the device table before any selector or app write.

    The source staging table is not proof of the table already installed on
    the unit.  Refuse the whole transaction when its OTA offsets or sizes do
    not match this guarded app-only route.
    """

    output.unlink(missing_ok=True)
    esptool_main(
        port,
        "--after",
        "no_reset",
        "read_flash",
        hex(PARTITION_TABLE_OFFSET),
        hex(PARTITION_TABLE_READ_SIZE),
        str(output),
    )
    raw = output.read_bytes()
    if len(raw) != PARTITION_TABLE_READ_SIZE:
        raise SystemExit("PARTITION_TABLE_READ_LENGTH_INVALID")

    layout: dict[str, tuple[int, int]] = {}
    for start in range(0, PARTITION_TABLE_READ_SIZE, PARTITION_ENTRY_SIZE):
        magic = struct.unpack_from("<H", raw, start)[0]
        if magic == 0xEBEB or magic == 0xFFFF:
            break
        if magic != PARTITION_MAGIC:
            raise SystemExit("PARTITION_TABLE_ENTRY_INVALID")
        kind = raw[start + 2]
        subtype = raw[start + 3]
        offset, size = struct.unpack_from("<II", raw, start + 4)
        label = raw[start + 12:start + 28].split(b"\0", 1)[0].decode("ascii", "replace")
        if label == "otadata":
            layout["otadata"] = (offset, size)
        elif kind == 0 and subtype == 0x10:
            layout["ota_0"] = (offset, size)
        elif kind == 0 and subtype == 0x11:
            layout["ota_1"] = (offset, size)
    return layout


def write_selector_and_verify(
    port: str,
    metadata: bytes,
    copy: int,
    seq: int,
    selector_path: Path,
    readback_path: Path,
    state: int = OTA_IMG_NEW,
) -> None:
    selector_path.write_bytes(selector_sector(metadata, copy, seq, state=state))
    offset = OTA_DATA_OFFSET + copy * SECTOR_SIZE
    esptool_main(
        port,
        "--after",
        "no_reset",
        "write_flash",
        hex(offset),
        str(selector_path),
    )
    # Keep the chip in the bootloader until capture_boot() performs the one
    # observed app boot. A readback reset here can start NEW -> PENDING_VERIFY,
    # and the next reset would immediately mark ota_1 ABORTED.
    readback = read_otadata(port, readback_path, no_reset=True)
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
    parser.add_argument("--port", required=True)
    parser.add_argument("--expected-mac", required=True, help="ESP32-S3 base MAC confirmed independently for this unit")
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--resume-verified-ota1", action="store_true",
                        help="verify the already-written ota_1 image, then select and observe one boot")
    args = parser.parse_args()

    image = args.image.resolve()
    evidence = args.evidence_dir.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    image_bytes = image.read_bytes()
    if not image_bytes or image_bytes[0] != 0xE9 or len(image_bytes) > OTA_SLOT_SIZE:
        raise SystemExit("OTA1_IMAGE_INVALID_OR_TOO_LARGE")

    verify_chip_mac(args.port, args.expected_mac)
    with tempfile.TemporaryDirectory(prefix="lihuahua-ota1-") as temporary:
        temp = Path(temporary)
        device_layout = read_partition_layout(args.port, temp / "partition-table.bin")
        expected_layout = {
            "otadata": (OTA_DATA_OFFSET, OTADATA_SIZE),
            "ota_0": (OTA_0_OFFSET, OTA_SLOT_SIZE),
            "ota_1": (OTA_1_OFFSET, OTA_SLOT_SIZE),
        }
        if device_layout != expected_layout:
            raise SystemExit(
                "DEVICE_PARTITION_LAYOUT_MISMATCH:"
                + repr({"device": device_layout, "expected": expected_layout})
            )
        if not args.resume_verified_ota1:
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
                state=OTA_IMG_VALID,
            )
            ota0_log = capture_boot(args.port, evidence / "ota0-safety-boot.log")
            # Require the StackChan board banner. A generic ESP32-S3 app (or
            # merely booting the expected offset) is not a safe recovery app.
            ota0_boot_proven = (
                "SKU=m5stack-stack-chan" in ota0_log
                and "cat-litter ESP32-S3 Wi-Fi link test" not in ota0_log
            )
            if not ota0_boot_proven:
                raise SystemExit("OTA0_SAFETY_BOOT_NOT_PROVEN")

            # A failed write/verify raises here, so no ota_1 selector is changed.
            write_ota1_image_and_verify(args.port, image)
        else:
            # Resume only when the exact image is still present in ota_1.
            esptool_main(args.port, "verify_flash", hex(OTA_1_OFFSET), str(image))

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
    print("OTA1_WRITE_VERIFIED=YES" if not args.resume_verified_ota1 else "OTA1_IMAGE_REVERIFIED=YES")
    print("OTA1_FIRST_BOOT_VALIDATED=YES")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
