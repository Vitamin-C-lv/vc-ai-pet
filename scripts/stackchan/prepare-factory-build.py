#!/usr/bin/env python3
"""Create a fresh, locally configured StackChan factory build tree.

The output tree is intentionally outside the VC-AI-PET worktree.  The bridge
URL is accepted only as a local build input and is never printed or written to
the repository.  This script stages the already-reviewed source patch; it does
not build, flash, erase, or switch OTA metadata.
"""

from __future__ import annotations

import argparse
import ipaddress
import re
import shutil
import subprocess
from urllib.parse import urlparse
from pathlib import Path


EXPECTED_SOURCE_COMMIT = "1b5765599fba8aaad1811d9a79358ccc7051f5f3"
APP_FILES = (
    "lihuahua_body_app.cpp",
    "lihuahua_body_app.h",
    "lihuahua_body_state.cpp",
    "lihuahua_body_state.h",
)
ENTRY_FILE = "lihuahua_body_main.cpp"


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


def run_git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--official-source-root", type=Path, required=True)
    parser.add_argument("--feature-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--bridge-url", required=True)
    args = parser.parse_args()

    source = args.official_source_root.resolve()
    feature = args.feature_root.resolve()
    output = args.output_root.resolve()
    if not source.is_dir() or not (source / ".git").exists():
        raise SystemExit("OFFICIAL_SOURCE_ROOT_INVALID")
    if output.exists():
        raise SystemExit("OUTPUT_ROOT_ALREADY_EXISTS")
    source_commit = run_git(source, "rev-parse", "HEAD")
    if source_commit != EXPECTED_SOURCE_COMMIT:
        raise SystemExit("OFFICIAL_SOURCE_COMMIT_MISMATCH")
    if not valid_bridge_url(args.bridge_url):
        raise SystemExit("BRIDGE_URL_MUST_BE_CURRENT_RFC1918_WLAN_ENDPOINT")

    patch = feature / "device/stackchan/m5stack-factory/patches/app-registration.patch"
    app_source = feature / "device/stackchan/m5stack-factory"
    for filename in (*APP_FILES,):
        if not (app_source / filename).is_file():
            raise SystemExit(f"FEATURE_APP_SOURCE_MISSING:{filename}")
    if not patch.is_file():
        raise SystemExit("REGISTRATION_PATCH_MISSING")

    subprocess.run(
        ["git", "clone", "--no-hardlinks", str(source), str(output)],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    # The official checkout used for the prior build has locally provisioned
    # dependencies ignored by Git.  Carry those exact dependency trees into
    # the fresh staging tree when present; do not fetch or mutate global IDF
    # state as part of this staging step.
    for dependency_dir in ("components", "managed_components", "xiaozhi-esp32"):
        source_dependency = source / "firmware" / dependency_dir
        if source_dependency.is_dir():
            target_dependency = output / "firmware" / dependency_dir
            shutil.copytree(source_dependency, target_dependency, dirs_exist_ok=True)
    app_target = output / "firmware/main/apps/app_lihuahua_body"
    app_target.mkdir(parents=True, exist_ok=False)
    for filename in APP_FILES:
        shutil.copy2(app_source / filename, app_target / filename)

    subprocess.run(
        ["git", "-C", str(output), "apply", "--whitespace=nowarn", str(patch)],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    # The body firmware owns the entry point so the factory AI agent and App
    # Center are not started as a side effect of boot.
    shutil.copy2(app_source / ENTRY_FILE, output / "firmware/main/main.cpp")
    (app_target / "stackchan_body_config.h").write_text(
        "#pragma once\n"
        f'#define STACKCHAN_BODY_BRIDGE_URL "{args.bridge_url}"\n',
        encoding="ascii",
        newline="\n",
    )

    staged_header = (app_target / "stackchan_body_config.h").read_text(encoding="ascii")
    if args.bridge_url not in staged_header:
        raise SystemExit("BRIDGE_URL_CONFIG_NOT_STAGED")
    if run_git(output, "rev-parse", "HEAD") != EXPECTED_SOURCE_COMMIT:
        raise SystemExit("STAGED_SOURCE_COMMIT_CHANGED")

    print(f"FACTORY_SOURCE_COMMIT={source_commit}")
    print("FACTORY_APP_SOURCES_STAGED=YES")
    print("FACTORY_REGISTRATION_PATCHED=YES")
    print("FACTORY_CONFIG_HEADER_STAGED=YES")
    print("BRIDGE_URL_CONFIGURED=YES")
    print(f"STAGING_OUTPUT_ROOT={output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
