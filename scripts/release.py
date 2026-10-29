#!/usr/bin/env python3
"""Shared release validation and packaging for local builds and GitHub Actions."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tomllib
import zipfile


ROOT = Path(__file__).resolve().parent.parent
TARGETS = (
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
)


def validate_versions(root=ROOT):
    """Reject inconsistent app versions before any platform build starts."""
    versions = {}
    for directory, name in (("server", "securevault"), ("desktop", "securevault-desktop")):
        manifest_path = f"{directory}/Cargo.toml"
        manifest = tomllib.loads((root / manifest_path).read_text(encoding="utf-8"))
        versions[manifest_path] = manifest["package"]["version"]
        lock_path = f"{directory}/Cargo.lock"
        lock = tomllib.loads((root / lock_path).read_text(encoding="utf-8"))
        packages = [p for p in lock["package"] if p["name"] == name]
        if len(packages) != 1:
            raise ValueError(f"{lock_path} must contain exactly one {name} package")
        versions[lock_path] = packages[0]["version"]
    config_path = "desktop/tauri.conf.json"
    versions[config_path] = json.loads((root / config_path).read_text(encoding="utf-8"))["version"]
    version = versions["server/Cargo.toml"]
    mismatches = [f"{path}={value}" for path, value in versions.items() if value != version]
    if mismatches:
        raise ValueError(f"Version mismatch: server/Cargo.toml={version}; " + "; ".join(mismatches))
    return version


def metadata():
    version = validate_versions()
    result = subprocess.run(
        ["cargo", "metadata", "--locked", "--no-deps", "--format-version", "1",
         "--manifest-path", str(ROOT / "server/Cargo.toml")],
        check=True, capture_output=True, text=True,
    )
    data = json.loads(result.stdout)
    package = next(p for p in data["packages"] if p["name"] == "securevault")
    if package["version"] != version:
        raise ValueError("Cargo metadata version does not match server/Cargo.toml")
    return version, Path(data["target_directory"])


def verify_tag(version, tag):
    if tag != f"v{version}":
        raise ValueError(
            f"Tag {tag} must match Cargo.toml version v{version}. "
            "Commit matching server/Cargo.toml and server/Cargo.lock versions "
            "before creating the tag, or create a new tag matching the current version. "
            "Re-running the old tag does not change its source."
        )


def archive_name(version, target):
    extension = "zip" if "windows" in target else "tar.gz"
    return f"securevault-{version}-{target}.{extension}"


def package(version, target, target_directory, destination):
    binary_name = "securevault.exe" if "windows" in target else "securevault"
    binary = target_directory / target / "release" / binary_name
    if not binary.is_file():
        raise ValueError(f"Release binary missing: {binary}; build this target first")
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / archive_name(version, target)
    member = f"securevault-{version}-{target}/{binary_name}"
    if "windows" in target:
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
            output.write(binary, member)
    else:
        with tarfile.open(archive, "w:gz") as output:
            output.add(binary, arcname=member)
    return archive


def checksums(version, destination):
    expected = {archive_name(version, target) for target in TARGETS}
    actual = {p.name for p in destination.iterdir() if p.is_file() and
              (p.name.endswith(".tar.gz") or p.name.endswith(".zip"))}
    if actual != expected:
        raise ValueError(
            f"Release assets incomplete or unexpected; missing: {sorted(expected - actual)}; "
            f"unexpected: {sorted(actual - expected)}"
        )
    lines = []
    for name in sorted(expected):
        digest = hashlib.sha256()
        with (destination / name).open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        lines.append(f"{digest.hexdigest()}  {name}\n")
    result = destination / "SHA256SUMS"
    result.write_text("".join(lines), encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    version_parser = commands.add_parser("version")
    version_parser.add_argument("--tag")
    package_parser = commands.add_parser("package")
    package_parser.add_argument("--target", required=True, choices=TARGETS)
    package_parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    checksum_parser = commands.add_parser("checksums")
    checksum_parser.add_argument("--version", required=True)
    checksum_parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    try:
        if args.command == "checksums":
            print(checksums(args.version, args.dist))
        else:
            version, target_directory = metadata()
            if args.command == "version":
                if args.tag is not None:
                    verify_tag(version, args.tag)
                print(version)
            else:
                print(package(version, args.target, target_directory, args.dist))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        detail = error.stderr or "" if isinstance(error, subprocess.CalledProcessError) else ""
        parser.exit(1, f"{error}\n{detail}")


if __name__ == "__main__":
    main()
