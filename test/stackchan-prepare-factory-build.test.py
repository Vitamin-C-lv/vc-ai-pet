#!/usr/bin/env python3
"""Tiny Git-fixture regression tests for reusable StackChan staging."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import subprocess
import sys
import tempfile
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPOSITORY_ROOT / "scripts/stackchan/prepare-factory-build.py"


def run(*args: str, cwd: Path) -> str:
    result = subprocess.run(
        args,
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def initialize_git(root: Path) -> None:
    run("git", "init", "-q", cwd=root)
    run("git", "config", "user.name", "StackChan Test", cwd=root)
    run("git", "config", "user.email", "stackchan-test@example.invalid", cwd=root)


def create_official_source(root: Path) -> str:
    root.mkdir()
    initialize_git(root)
    write(
        root / "firmware/main/CMakeLists.txt",
        "idf_component_register(\n                    )\n\n"
        "# Use target_compile_definitions\n",
    )
    write(root / "firmware/main/apps/apps.h", "BASE\n")
    write(root / "firmware/main/main.cpp", "int main() { return 0; }\n")
    write(
        root / "firmware/main/hal/hal.cpp",
        "    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {\n"
        "        ESP_ERROR_CHECK(nvs_flash_erase());\n"
        "        ret = nvs_flash_init();\n"
        "    }\n",
    )
    write(
        root / "firmware/main/hal/board/stackchan_camera.cc",
        "    hal_bridge::app_play_sound(OGG_CAMERA_SHUTTER);\n"
        "    if (display != nullptr) {\n",
    )
    write(root / "firmware/main/hal/board/stackchan.cc", "int stackchan = 1;\n")
    write(root / "firmware/sdkconfig.defaults", "CONFIG_BASE=y\n")
    run("git", "add", ".", cwd=root)
    run("git", "commit", "-qm", "fixture source", cwd=root)
    run("git", "remote", "add", "origin", "https://github.com/m5stack/StackChan.git", cwd=root)
    commit = run("git", "rev-parse", "HEAD", cwd=root)

    write(root / "firmware/components/component.txt", "component\n")
    write(
        root
        / "firmware/managed_components/espressif__esp-sr/model/multinet_model/mn5q8_cn/model.bin",
        "tiny-model\n",
    )
    write(
        root / "firmware/xiaozhi-esp32/scripts/spiffs_assets/pack_model.py",
        "import argparse\n"
        "from pathlib import Path\n"
        "p = argparse.ArgumentParser()\n"
        "p.add_argument('--model_path', required=True)\n"
        "a = p.parse_args()\n"
        "(Path(a.model_path) / 'srmodels.bin').write_bytes(b'tiny-packed-model')\n",
    )
    return commit


def create_feature(root: Path, app_value: str = "first") -> None:
    root.mkdir()
    initialize_git(root)
    app_root = root / "device/stackchan/m5stack-factory"
    app_files = (
        "lihuahua_body_app.cpp",
        "lihuahua_body_app.h",
        "lihuahua_body_state.cpp",
        "lihuahua_body_state.h",
        "lihuahua_body_io.cpp",
        "lihuahua_body_io.h",
        "lihuahua_wake.cpp",
        "lihuahua_wake.h",
    )
    for filename in app_files:
        write(app_root / filename, f"{filename}:{app_value}\n")
    write(app_root / "lihuahua_body_main.cpp", "int body_main = 1;\n")
    write(app_root / "wake-sdkconfig.defaults", "CONFIG_WAKE=y\n")
    write(
        app_root / "patches/app-registration.patch",
        "diff --git a/firmware/main/apps/apps.h b/firmware/main/apps/apps.h\n"
        "index 8d1a494..0d494ff 100644\n"
        "--- a/firmware/main/apps/apps.h\n"
        "+++ b/firmware/main/apps/apps.h\n"
        "@@ -1 +1 @@\n"
        "-BASE\n"
        "+PATCHED\n",
    )
    run("git", "add", ".", cwd=root)
    run("git", "commit", "-qm", "fixture feature", cwd=root)


def load_prepare_module():
    spec = importlib.util.spec_from_file_location("prepare_factory_build", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load prepare-factory-build.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def invoke_prepare(module, source: Path, feature: Path, output: Path, key: str) -> str:
    argv = [
        str(SCRIPT_PATH),
        "--official-source-root",
        str(source),
        "--feature-root",
        str(feature),
        "--output-root",
        str(output),
        "--bridge-url",
        "http://192.168.50.10:17871/v1/body/state",
        "--bridge-key",
        key,
    ]
    capture = io.StringIO()
    old_argv = sys.argv
    try:
        sys.argv = argv
        with contextlib.redirect_stdout(capture):
            result = module.main()
    finally:
        sys.argv = old_argv
    if result != 0:
        raise AssertionError(f"prepare returned {result}")
    return capture.getvalue()


def expect_exit(expected: str, function) -> None:
    try:
        function()
    except SystemExit as error:
        if str(error) != expected:
            raise AssertionError(f"expected {expected}, got {error}") from error
    else:
        raise AssertionError(f"expected SystemExit({expected})")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="stackchan-prepare-test-") as temp:
        root = Path(temp)
        source = root / "official"
        feature = root / "feature"
        output = root / "staging"
        commit = create_official_source(source)
        create_feature(feature)
        module = load_prepare_module()
        module.EXPECTED_SOURCE_COMMIT = commit

        first = invoke_prepare(module, source, feature, output, "A" * 32)
        assert "STAGING_REUSED=NO" in first
        assert (output / module.STAGING_MARKER_FILE).is_file()
        print("TEST_FIRST_PREPARE=PASS")

        build_sentinel = output / "firmware/build/preserved.sentinel"
        managed_sentinel = output / "firmware/managed_components/preserved.sentinel"
        write(build_sentinel, "build-cache\n")
        write(managed_sentinel, "managed-cache\n")
        managed_inode = managed_sentinel.stat().st_ino
        write(output / "firmware/main/apps/app_lihuahua_body/old-only.txt", "old\n")
        write(output / "firmware/sdkconfig", "old-config\n")
        write(
            feature / "device/stackchan/m5stack-factory/lihuahua_body_app.cpp",
            "lihuahua_body_app.cpp:second\n",
        )

        second = invoke_prepare(module, source, feature, output, "B" * 32)
        assert "STAGING_REUSED=YES" in second
        print("TEST_REUSE_MARKED_STAGING=PASS")
        assert build_sentinel.read_text(encoding="utf-8") == "build-cache\n"
        print("TEST_BUILD_SENTINEL_PRESERVED=PASS")
        assert managed_sentinel.stat().st_ino == managed_inode
        assert managed_sentinel.read_text(encoding="utf-8") == "managed-cache\n"
        print("TEST_MANAGED_COMPONENT_SENTINEL_PRESERVED=PASS")
        app_target = output / "firmware/main/apps/app_lihuahua_body"
        assert not (app_target / "old-only.txt").exists()
        assert "second" in (app_target / "lihuahua_body_app.cpp").read_text(encoding="utf-8")
        print("TEST_GENERATED_APP_REFRESHED=PASS")
        config = (app_target / "stackchan_body_config.h").read_text(encoding="ascii")
        assert "A" * 32 not in config
        assert "B" * 32 in config
        assert not (output / "firmware/sdkconfig").exists()
        print("TEST_CONFIG_REFRESHED=PASS")

        unmanaged = root / "unmanaged"
        unmanaged.mkdir()
        expect_exit(
            "OUTPUT_ROOT_EXISTS_UNMANAGED",
            lambda: invoke_prepare(module, source, feature, unmanaged, "C" * 32),
        )
        print("TEST_UNMANAGED_OUTPUT_REFUSED=PASS")

        expect_exit(
            "OUTPUT_ROOT_IS_FEATURE_ROOT",
            lambda: invoke_prepare(module, source, feature, feature, "D" * 32),
        )
        print("TEST_PROTECTED_WORKTREE_REFUSED=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
