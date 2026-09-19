"""Pure ESP-IDF otadata planning helpers.

This module intentionally has no serial, esptool, filesystem, or device
side-effects.  It is used by the guarded ota_1 deploy script and by metadata
unit tests.
"""

from __future__ import annotations

import binascii
import struct
from dataclasses import dataclass


SECTOR_SIZE = 0x1000
OTADATA_SIZE = 0x2000
ERASED = 0xFFFFFFFF
OTA_IMG_NEW = 0
OTA_IMG_PENDING_VERIFY = 1
OTA_IMG_VALID = 2
# ESP-IDF v5.5.4 enum values.  Both states are intentionally excluded from
# USABLE_STATES below; their numeric order still matters when decoding
# otadata written by the bootloader.
OTA_IMG_INVALID = 3
OTA_IMG_ABORTED = 4
USABLE_STATES = frozenset((OTA_IMG_NEW, OTA_IMG_PENDING_VERIFY, OTA_IMG_VALID))
MAX_SEQUENCE = 0xFFFFFFFE


@dataclass(frozen=True)
class OtaSelector:
    copy: int
    sequence: int
    state: int
    crc_valid: bool

    @property
    def valid(self) -> bool:
        return (
            self.sequence != ERASED
            and self.crc_valid
            and self.state in USABLE_STATES
        )

    @property
    def slot(self) -> int | None:
        if self.sequence == ERASED:
            return None
        return (self.sequence - 1) % 2


def crc(seq: int) -> int:
    """ESP-IDF's ota_select_entry CRC over the little-endian sequence."""

    return binascii.crc32(struct.pack("<I", seq), 0xFFFFFFFF) & 0xFFFFFFFF


def _check_metadata(metadata: bytes, copy: int | None = None) -> None:
    if len(metadata) != OTADATA_SIZE:
        raise ValueError("OTADATA_LENGTH_INVALID")
    if copy is not None and copy not in (0, 1):
        raise ValueError("OTADATA_COPY_INVALID")


def selector_sector(metadata: bytes, copy: int, seq: int) -> bytes:
    _check_metadata(metadata, copy)
    if not 1 <= seq <= MAX_SEQUENCE:
        raise ValueError("OTADATA_SEQUENCE_INVALID")
    start = copy * SECTOR_SIZE
    sector = bytearray(metadata[start : start + SECTOR_SIZE])
    struct.pack_into("<I", sector, 0, seq)
    struct.pack_into("<I", sector, 24, OTA_IMG_NEW)
    struct.pack_into("<I", sector, 28, crc(seq))
    return bytes(sector)


def decode_selector(metadata: bytes, copy: int) -> OtaSelector:
    _check_metadata(metadata, copy)
    start = copy * SECTOR_SIZE
    sector = metadata[start : start + SECTOR_SIZE]
    seq = struct.unpack_from("<I", sector, 0)[0]
    state = struct.unpack_from("<I", sector, 24)[0]
    stored_crc = struct.unpack_from("<I", sector, 28)[0]
    return OtaSelector(copy, seq, state, stored_crc == crc(seq))


def valid_sequence(metadata: bytes, copy: int) -> int | None:
    selector = decode_selector(metadata, copy)
    return selector.sequence if selector.valid else None


def active_selector(metadata: bytes) -> OtaSelector | None:
    _check_metadata(metadata)
    selectors = [decode_selector(metadata, copy) for copy in (0, 1)]
    usable = [selector for selector in selectors if selector.valid]
    if not usable:
        return None
    return max(usable, key=lambda selector: (selector.sequence, -selector.copy))


def inactive_copy(metadata: bytes) -> int:
    active = active_selector(metadata)
    return 0 if active is None else 1 - active.copy


def selected_slot(metadata: bytes) -> int | None:
    active = active_selector(metadata)
    return None if active is None else active.slot


def next_selector_update(metadata: bytes, slot: int) -> tuple[int, int]:
    """Return ``(inactive_copy, sequence)`` for the next target-slot write."""

    _check_metadata(metadata)
    if slot not in (0, 1):
        raise ValueError("OTA_SLOT_INVALID")
    active = active_selector(metadata)
    candidate = 0 if active is None else active.sequence
    candidate += 1
    while candidate <= MAX_SEQUENCE and (candidate - 1) % 2 != slot:
        candidate += 1
    if candidate > MAX_SEQUENCE:
        raise ValueError("OTADATA_SEQUENCE_EXHAUSTED")
    return inactive_copy(metadata), candidate


def next_sequence_for_slot(metadata: bytes, slot: int) -> int:
    return next_selector_update(metadata, slot)[1]
