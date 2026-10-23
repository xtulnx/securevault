#!/usr/bin/env python3
"""Build the bundled service and run/package the Tauri desktop app."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "desktop"


def run(*args, cwd=ROOT, env=None):
    subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "dev", "build", "check", "test"])
    parser.add_argument("--target")
    parser.add_argument("--bundles", help="打包格式，例如 app、app,dmg 或 deb")
    incoming = sys.argv[1:]
    separator = incoming.index('--') if '--' in incoming else len(incoming)
    forwarded = incoming[separator + 1:]
    args = parser.parse_args(incoming[:separator])
    target = args.target or subprocess.check_output(["rustc", "--print", "host-tuple"], text=True).strip()
    version = next(line.split('"')[1] for line in (ROOT / "server/Cargo.toml").read_text().splitlines() if line.startswith("version ="))
    config = json.loads((DESKTOP / "tauri.conf.json").read_text())
    desktop_version = next(line.split('"')[1] for line in (DESKTOP / "Cargo.toml").read_text().splitlines() if line.startswith("version ="))
    if config["version"] != version or desktop_version != version:
        raise SystemExit("server/Cargo.toml、desktop/Cargo.toml 和 desktop/tauri.conf.json 版本必须一致")
    environment = os.environ.copy()
    # Make artifact discovery deterministic even when a shell overrides Cargo's target directory.
    environment["CARGO_TARGET_DIR"] = str(ROOT / "server/target")
    run("cargo", "build", "--locked", "--release", "--manifest-path", ROOT / "server/Cargo.toml", "--target", target, env=environment)
    suffix = ".exe" if "windows" in target else ""
    binaries = DESKTOP / "binaries"
    binaries.mkdir(exist_ok=True)
    shutil.copy2(ROOT / f"server/target/{target}/release/securevault{suffix}", binaries / f"securevault-{target}{suffix}")
    if args.action == "prepare": return
    environment["CARGO_TARGET_DIR"] = str(DESKTOP / "target")
    if args.action in ("check", "test"):
        run("cargo", args.action, "--locked", "--manifest-path", DESKTOP / "Cargo.toml", "--target", target, env=environment)
        return
    cli = ROOT / "node_modules/.bin" / ("tauri.cmd" if os.name == "nt" else "tauri")
    if not cli.exists(): raise SystemExit("请先在项目根目录执行 npm ci")
    arguments = [cli, args.action, "--target", target]
    if args.action == "build":
        bundles = args.bundles or ('app' if 'apple-darwin' in target else 'nsis' if 'windows' in target else 'deb')
        arguments += ["--bundles", bundles, "--", "--locked", *forwarded]
    else:
        arguments += ["--no-watch", "--no-dev-server", "--", "--locked", "--", *forwarded]
    run(*arguments, cwd=DESKTOP, env=environment)
    if args.action == "build" and "apple-darwin" in target:
        run("codesign", "--verify", "--deep", "--strict", DESKTOP / f"target/{target}/release/bundle/macos/SecureVault.app")


if __name__ == "__main__":
    main()
