#!/usr/bin/env python3
"""Create or refresh a locally configured StackChan factory build tree.

The output tree is intentionally outside the VC-AI-PET worktree.  The bridge
URL is accepted only as a local build input and is never printed or written to
the repository.  A marked output tree is reused so its build and dependency
caches survive firmware iterations.  This script stages the already-reviewed
source patch; it does not build, flash, erase, or switch OTA metadata.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import shutil
import struct
import subprocess
import sys
import zlib
from urllib.parse import urlparse
from pathlib import Path


EXPECTED_SOURCE_COMMIT = "1b5765599fba8aaad1811d9a79358ccc7051f5f3"
EXPECTED_UPSTREAM_URL = "https://github.com/m5stack/StackChan.git"
STAGING_MARKER_FILE = ".vc-ai-pet-stackchan-staging.json"
STAGING_MARKER_PURPOSE = "vc-ai-pet-stackchan-factory-staging"
DEPENDENCY_DIRS = ("components", "managed_components", "xiaozhi-esp32")
TRACKED_STAGING_PATHS = (
    "firmware/main/CMakeLists.txt",
    "firmware/main/apps/apps.h",
    "firmware/main/main.cpp",
    "firmware/main/hal/hal.cpp",
    "firmware/main/hal/board/stackchan.cc",
    "firmware/main/hal/board/stackchan_camera.cc",
    "firmware/sdkconfig.defaults",
)
GENERATED_STAGING_PATHS = (
    "firmware/main/apps/app_lihuahua_body",
    "firmware/.vc-ai-pet-local-wake",
    "firmware/sdkconfig",
    "firmware/sdkconfig.old",
)
APP_FILES = (
    "lihuahua_body_app.cpp",
    "lihuahua_body_app.h",
    "lihuahua_body_state.cpp",
    "lihuahua_body_state.h",
    "lihuahua_body_io.cpp",
    "lihuahua_body_io.h",
    "lihuahua_wake.cpp",
    "lihuahua_wake.h",
)
ENTRY_FILE = "lihuahua_body_main.cpp"
WAKE_DEFAULTS_FILE = "wake-sdkconfig.defaults"
EMBEDDED_WAKE_MODEL_FILE = "lihuahua_mn5q8_cn_srmodels.zlib"


def valid_bridge_url(value: str) -> bool:
    parsed = urlparse(value)
    if parsed.scheme != "http" or parsed.path != "/v1/body/state" or parsed.port != 17871:
        return False
    try:
        address = ipaddress.ip_address(parsed.hostname or "")
    except ValueError:
        return False
    return any(
        address in ipaddress.ip_network(network)
        for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
    )


def valid_bridge_key(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_-]{32,128}", value))


def run_git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def path_is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def protected_worktrees(feature: Path) -> tuple[Path, ...]:
    worktrees = []
    for line in run_git(feature, "worktree", "list", "--porcelain").splitlines():
        if line.startswith("worktree "):
            worktrees.append(Path(line.removeprefix("worktree ")).resolve())
    return tuple(worktrees)


def validate_output_location(output: Path, source: Path, feature: Path) -> None:
    if output == source:
        raise SystemExit("OUTPUT_ROOT_IS_OFFICIAL_SOURCE_ROOT")
    if output == feature:
        raise SystemExit("OUTPUT_ROOT_IS_FEATURE_ROOT")
    for worktree in protected_worktrees(feature):
        if path_is_within(output, worktree):
            raise SystemExit("OUTPUT_ROOT_IS_PROTECTED_WORKTREE")


def marker_payload(source_commit: str) -> dict[str, object]:
    return {
        "schema": 1,
        "purpose": STAGING_MARKER_PURPOSE,
        "officialSourceCommit": source_commit,
        "createdBy": "prepare-factory-build.py",
    }


def write_staging_marker(output: Path, source_commit: str) -> None:
    marker = output / STAGING_MARKER_FILE
    marker.write_text(
        json.dumps(marker_payload(source_commit), indent=2) + "\n",
        encoding="utf-8",
    )
    marker.chmod(0o600)


def validate_expected_upstream(root: Path, error: str) -> str:
    try:
        remote = run_git(root, "remote", "get-url", "origin")
    except subprocess.CalledProcessError:
        raise SystemExit(error) from None
    if remote.rstrip("/").removesuffix(".git").lower() != EXPECTED_UPSTREAM_URL.removesuffix(".git").lower():
        raise SystemExit(error)
    return remote


def validate_reusable_staging(output: Path) -> None:
    marker = output / STAGING_MARKER_FILE
    try:
        payload = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise SystemExit("OUTPUT_ROOT_EXISTS_UNMANAGED") from None
    required_marker = marker_payload(EXPECTED_SOURCE_COMMIT)
    if any(payload.get(key) != value for key, value in required_marker.items()):
        raise SystemExit("OUTPUT_ROOT_EXISTS_UNMANAGED")
    if not (output / ".git").is_dir():
        raise SystemExit("OUTPUT_ROOT_EXISTS_UNMANAGED")
    try:
        output_commit = run_git(output, "rev-parse", "HEAD")
    except subprocess.CalledProcessError:
        raise SystemExit("OUTPUT_ROOT_EXISTS_UNMANAGED") from None
    if output_commit != EXPECTED_SOURCE_COMMIT:
        raise SystemExit("STAGED_SOURCE_COMMIT_MISMATCH")
    validate_expected_upstream(output, "STAGED_SOURCE_UPSTREAM_MISMATCH")


def initialize_missing_dependencies(source: Path, output: Path) -> None:
    for dependency_dir in DEPENDENCY_DIRS:
        target_dependency = output / "firmware" / dependency_dir
        if target_dependency.is_dir():
            continue
        source_dependency = source / "firmware" / dependency_dir
        if not source_dependency.is_dir():
            raise SystemExit(f"DEPENDENCY_SOURCE_MISSING:{dependency_dir}")
        shutil.copytree(source_dependency, target_dependency)


def refresh_reusable_staging(output: Path) -> None:
    run_git(
        output,
        "restore",
        "--source=HEAD",
        "--worktree",
        "--",
        *TRACKED_STAGING_PATHS,
    )
    for relative_path in GENERATED_STAGING_PATHS:
        target = output / relative_path
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists() or target.is_symlink():
            target.unlink()


def apply_body_safety_edits(output: Path) -> None:
    hal_path = output / "firmware/main/hal/hal.cpp"
    hal_text = hal_path.read_text(encoding="utf-8")
    nvs_block = (
        "    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {\n"
        "        ESP_ERROR_CHECK(nvs_flash_erase());\n"
        "        ret = nvs_flash_init();\n"
        "    }\n"
    )
    if hal_text.count(nvs_block) != 1:
        raise SystemExit("NVS_ERASE_BLOCK_NOT_FOUND_OR_NOT_UNIQUE")
    hal_path.write_text(hal_text.replace(nvs_block, "", 1), encoding="utf-8", newline="\n")

    camera_path = output / "firmware/main/hal/board/stackchan_camera.cc"
    camera_text = camera_path.read_text(encoding="utf-8")
    shutter = "    hal_bridge::app_play_sound(OGG_CAMERA_SHUTTER);"
    preview = "    if (display != nullptr) {"
    if camera_text.count(shutter) != 1 or camera_text.count(preview) != 1:
        raise SystemExit("CAMERA_FACTORY_SIDE_EFFECTS_NOT_FOUND_OR_NOT_UNIQUE")
    camera_text = camera_text.replace(shutter, "    if (hal_bridge::is_xiaozhi_mode()) hal_bridge::app_play_sound(OGG_CAMERA_SHUTTER);", 1)
    camera_text = camera_text.replace(preview, "    if (display != nullptr && hal_bridge::is_xiaozhi_mode()) {", 1)
    camera_path.write_text(camera_text, encoding="utf-8", newline="\n")


def stage_embedded_wake_model(output: Path, app_target: Path) -> None:
    """Pack the already-present compact ESP-SR model into the OTA1 app.

    The Factory assets partition is shared by ota_0 and ota_1.  Embedding the
    small quantized Chinese MultiNet pack keeps this phase app-only while
    leaving that recovery data untouched.
    """
    source_model = output / "firmware/managed_components/espressif__esp-sr/model/multinet_model/mn5q8_cn"
    if not source_model.is_dir():
        raise SystemExit("ESP_SR_MN5Q8_CN_MODEL_MISSING")
    model_stage = output / "firmware/.vc-ai-pet-local-wake/multinet_model"
    model_stage.mkdir(parents=True, exist_ok=False)
    shutil.copytree(source_model, model_stage / "mn5q8_cn")
    packer = output / "firmware/xiaozhi-esp32/scripts/spiffs_assets/pack_model.py"
    packed = model_stage / "srmodels.bin"
    subprocess.run(
        [sys.executable, str(packer), "--model_path", str(model_stage)],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    if not packed.is_file() or packed.stat().st_size <= 0:
        raise SystemExit("ESP_SR_EMBEDDED_MODEL_PACK_FAILED")
    compressed = zlib.compress(packed.read_bytes(), level=9)
    (app_target / EMBEDDED_WAKE_MODEL_FILE).write_bytes(struct.pack("<I", packed.stat().st_size) + compressed)

    cmake_path = output / "firmware/main/CMakeLists.txt"
    cmake_text = cmake_path.read_text(encoding="utf-8")
    marker = "                    )\n\n# Use target_compile_definitions"
    addition = (
        "                    )\n\n"
        "# VC-AI-PET local wake model is embedded in the OTA1 app; do not flash\n"
        "# the shared assets partition used by the ota_0 recovery image.\n"
        "set(LIHUAHUA_WAKE_MODEL_FILE \"${CMAKE_CURRENT_SOURCE_DIR}/apps/app_lihuahua_body/"
        f"{EMBEDDED_WAKE_MODEL_FILE}\")\n"
        "if(EXISTS \"${LIHUAHUA_WAKE_MODEL_FILE}\")\n"
        "    target_add_binary_data(${COMPONENT_LIB} \"${LIHUAHUA_WAKE_MODEL_FILE}\" BINARY)\n"
        "endif()\n\n"
        "# Use target_compile_definitions"
    )
    if cmake_text.count(marker) != 1:
        raise SystemExit("MAIN_CMAKE_COMPONENT_MARKER_NOT_FOUND_OR_NOT_UNIQUE")
    cmake_path.write_text(cmake_text.replace(marker, addition, 1), encoding="utf-8", newline="\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--official-source-root", type=Path, required=True)
    parser.add_argument("--feature-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--bridge-url", required=True)
    parser.add_argument("--bridge-key", default="", help="local pairing key; never commit or print")
    args = parser.parse_args()

    source = args.official_source_root.resolve()
    feature = args.feature_root.resolve()
    output = args.output_root.resolve()
    if not source.is_dir() or not (source / ".git").exists():
        raise SystemExit("OFFICIAL_SOURCE_ROOT_INVALID")
    source_commit = run_git(source, "rev-parse", "HEAD")
    if source_commit != EXPECTED_SOURCE_COMMIT:
        raise SystemExit("OFFICIAL_SOURCE_COMMIT_MISMATCH")
    source_remote = validate_expected_upstream(source, "OFFICIAL_SOURCE_UPSTREAM_MISMATCH")
    if run_git(source, "status", "--porcelain", "--untracked-files=no"):
        raise SystemExit("OFFICIAL_SOURCE_TRACKED_WORKTREE_DIRTY")
    if not valid_bridge_url(args.bridge_url):
        raise SystemExit("BRIDGE_URL_MUST_BE_CURRENT_RFC1918_WLAN_ENDPOINT")
    if args.bridge_key and not valid_bridge_key(args.bridge_key):
        raise SystemExit("BRIDGE_KEY_MUST_BE_HIGH_ENTROPY_BASE64URL")

    patch = feature / "device/stackchan/m5stack-factory/patches/app-registration.patch"
    app_source = feature / "device/stackchan/m5stack-factory"
    for filename in (*APP_FILES,):
        if not (app_source / filename).is_file():
            raise SystemExit(f"FEATURE_APP_SOURCE_MISSING:{filename}")
    if not patch.is_file():
        raise SystemExit("REGISTRATION_PATCH_MISSING")
    wake_defaults = app_source / WAKE_DEFAULTS_FILE
    if not wake_defaults.is_file():
        raise SystemExit("WAKE_DEFAULTS_MISSING")

    validate_output_location(output, source, feature)
    reused = output.exists()
    if reused:
        validate_reusable_staging(output)
    else:
        output.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["git", "clone", "--no-hardlinks", str(source), str(output)],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        run_git(output, "remote", "set-url", "origin", source_remote)
        output.chmod(0o700)
        if run_git(output, "rev-parse", "HEAD") != EXPECTED_SOURCE_COMMIT:
            raise SystemExit("STAGED_SOURCE_COMMIT_MISMATCH")
        write_staging_marker(output, source_commit)

    # Dependencies are initialized only when absent.  Existing dependency and
    # build trees are deliberately retained across prepares.
    initialize_missing_dependencies(source, output)
    refresh_reusable_staging(output)
    app_target = output / "firmware/main/apps/app_lihuahua_body"
    app_target.mkdir(parents=True, exist_ok=False)
    for filename in APP_FILES:
        shutil.copy2(app_source / filename, app_target / filename)
    stage_embedded_wake_model(output, app_target)
    defaults_path = output / "firmware/sdkconfig.defaults"
    with defaults_path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write("\n# VC-AI-PET Phase 4.2 local wake\n")
        handle.write(wake_defaults.read_text(encoding="utf-8"))

    subprocess.run(
        ["git", "-C", str(output), "apply", "--whitespace=nowarn", str(patch)],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    apply_body_safety_edits(output)
    # The body firmware owns the entry point so the factory AI agent and App
    # Center are not started as a side effect of boot.
    shutil.copy2(app_source / ENTRY_FILE, output / "firmware/main/main.cpp")
    config_path = app_target / "stackchan_body_config.h"
    config_path.write_text(
        "#pragma once\n"
        f'#define STACKCHAN_BODY_BRIDGE_URL "{args.bridge_url}"\n'
        f'#define STACKCHAN_BODY_KEY "{args.bridge_key}"\n',
        encoding="ascii",
        newline="\n",
    )
    config_path.chmod(0o600)

    staged_header = (app_target / "stackchan_body_config.h").read_text(encoding="ascii")
    if args.bridge_url not in staged_header:
        raise SystemExit("BRIDGE_URL_CONFIG_NOT_STAGED")
    if f'#define STACKCHAN_BODY_KEY "{args.bridge_key}"' not in staged_header:
        raise SystemExit("BRIDGE_KEY_CONFIG_NOT_STAGED")
    if run_git(output, "rev-parse", "HEAD") != EXPECTED_SOURCE_COMMIT:
        raise SystemExit("STAGED_SOURCE_COMMIT_CHANGED")

    print(f"FACTORY_SOURCE_COMMIT={source_commit}")
    print("FACTORY_APP_SOURCES_STAGED=YES")
    print("FACTORY_REGISTRATION_PATCHED=YES")
    print("FACTORY_CONFIG_HEADER_STAGED=YES")
    print("BRIDGE_URL_CONFIGURED=YES")
    print(f"BRIDGE_KEY_CONFIGURED={'YES' if args.bridge_key else 'NO'}")
    print(f"STAGING_REUSED={'YES' if reused else 'NO'}")
    print("BUILD_CACHE_PRESERVED=YES")
    print("MANAGED_COMPONENTS_REUSED=YES" if reused else "MANAGED_COMPONENTS_INITIALIZED=YES")
    print(f"STAGING_OUTPUT_ROOT={output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
