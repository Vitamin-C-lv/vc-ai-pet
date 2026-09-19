#!/usr/bin/env python3
"""Metadata-only tests for the guarded ota_1 deployment planner."""

from __future__ import annotations

import struct
import unittest

from ota_metadata import (
    ERASED,
    OTA_IMG_ABORTED,
    OTA_IMG_INVALID,
    OTA_IMG_VALID,
    OTADATA_SIZE,
    SECTOR_SIZE,
    active_selector,
    crc,
    decode_selector,
    inactive_copy,
    next_selector_update,
    selected_slot,
    selector_sector,
)


def metadata_fixture(*entries: tuple[int, int] | None) -> bytes:
    metadata = bytearray(b"\xff" * OTADATA_SIZE)
    for copy, entry in enumerate(entries):
        if entry is None:
            continue
        seq, state = entry
        sector = bytearray(selector_sector(bytes(metadata), copy, seq))
        struct.pack_into("<I", sector, 24, state)
        metadata[copy * SECTOR_SIZE : (copy + 1) * SECTOR_SIZE] = sector
    return bytes(metadata)


class OtaMetadataTests(unittest.TestCase):
    def test_phase3c_aborted_copy_is_not_active(self) -> None:
        metadata = metadata_fixture((1, OTA_IMG_VALID), (2, OTA_IMG_ABORTED))
        active = active_selector(metadata)
        self.assertIsNotNone(active)
        self.assertEqual((active.copy, active.sequence, active.slot), (0, 1, 0))
        self.assertEqual(selected_slot(metadata), 0)
        self.assertEqual(inactive_copy(metadata), 1)

    def test_toggle_ota1_ota0_ota1_uses_inactive_copy_and_monotonic_sequences(self) -> None:
        metadata = metadata_fixture((1, OTA_IMG_VALID), (2, OTA_IMG_ABORTED))
        copy, seq = next_selector_update(metadata, slot=1)
        self.assertEqual((copy, seq), (1, 2))
        metadata = bytearray(metadata)
        metadata[copy * SECTOR_SIZE : (copy + 1) * SECTOR_SIZE] = selector_sector(
            bytes(metadata), copy, seq
        )

        copy, seq = next_selector_update(bytes(metadata), slot=0)
        self.assertEqual((copy, seq), (0, 3))
        metadata[copy * SECTOR_SIZE : (copy + 1) * SECTOR_SIZE] = selector_sector(
            bytes(metadata), copy, seq
        )
        copy, seq = next_selector_update(bytes(metadata), slot=1)
        self.assertEqual((copy, seq), (1, 4))

    def test_single_valid_copy_and_both_valid_copies(self) -> None:
        single = metadata_fixture((7, OTA_IMG_VALID), None)
        self.assertEqual(next_selector_update(single, slot=1), (1, 8))

        both = metadata_fixture((5, OTA_IMG_VALID), (6, OTA_IMG_VALID))
        self.assertEqual(next_selector_update(both, slot=0), (0, 7))
        self.assertEqual(inactive_copy(both), 0)

    def test_erased_invalid_and_aborted_are_unusable(self) -> None:
        erased = b"\xff" * OTADATA_SIZE
        self.assertIsNone(active_selector(erased))
        self.assertEqual(next_selector_update(erased, slot=0), (0, 1))

        invalid = metadata_fixture((1, OTA_IMG_INVALID), (2, OTA_IMG_ABORTED))
        self.assertIsNone(active_selector(invalid))
        self.assertEqual(next_selector_update(invalid, slot=1), (0, 2))

    def test_crc_and_selector_state_are_officially_encoded(self) -> None:
        metadata = metadata_fixture((9, OTA_IMG_VALID), None)
        selector = decode_selector(metadata, 0)
        self.assertTrue(selector.crc_valid)
        self.assertTrue(selector.valid)
        self.assertEqual(struct.unpack_from("<I", metadata, 28)[0], crc(9))


if __name__ == "__main__":
    unittest.main()
