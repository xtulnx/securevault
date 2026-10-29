import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

import release


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        scratch = release.ROOT / "samples/.build"
        scratch.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="release-test-", dir=scratch)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.target = self.root / "target with spaces"
        self.dist = self.root / "dist"

    def build_fixture(self, target):
        name = "securevault.exe" if "windows" in target else "securevault"
        binary = self.target / target / "release" / name
        binary.parent.mkdir(parents=True)
        binary.write_bytes(f"binary for {target}".encode())
        binary.chmod(0o755)
        # Packaging must exclude other build files and front-end/runtime data.
        (binary.parent / "vault.meta.json").write_text("must not ship")
        return binary

    def test_all_platform_archives_contain_only_the_correct_executable(self):
        for target in release.TARGETS:
            with self.subTest(target=target):
                binary = self.build_fixture(target)
                archive = release.package("0.1.0", target, self.target, self.dist)
                member = f"securevault-0.1.0-{target}/{binary.name}"
                if "windows" in target:
                    self.assertEqual(archive.suffix, ".zip")
                    with zipfile.ZipFile(archive) as packaged:
                        self.assertEqual(packaged.namelist(), [member])
                        self.assertEqual(packaged.read(member), binary.read_bytes())
                else:
                    with tarfile.open(archive) as packaged:
                        self.assertEqual(packaged.getnames(), [member])
                        self.assertEqual(packaged.extractfile(member).read(), binary.read_bytes())
                        self.assertTrue(packaged.getmember(member).mode & 0o111)

    def test_missing_binary_is_rejected_without_creating_an_archive(self):
        with self.assertRaisesRegex(ValueError, "Release binary missing"):
            release.package("0.1.0", release.TARGETS[0], self.target, self.dist)
        self.assertFalse(self.dist.exists())

    def test_checksums_require_all_release_platforms_and_reject_extra_archives(self):
        for target in release.TARGETS:
            self.build_fixture(target)
            release.package("0.1.0", target, self.target, self.dist)
        checksum = release.checksums("0.1.0", self.dist)
        lines = checksum.read_text().splitlines()
        self.assertEqual(len(lines), 4)
        for line in lines:
            digest, name = line.split("  ")
            self.assertEqual(digest, hashlib.sha256((self.dist / name).read_bytes()).hexdigest())
        (self.dist / "unexpected.zip").write_bytes(b"stale artifact")
        with self.assertRaisesRegex(ValueError, "unexpected.zip"):
            release.checksums("0.1.0", self.dist)
        (self.dist / "unexpected.zip").unlink()
        missing = release.archive_name("0.1.0", release.TARGETS[0])
        (self.dist / missing).unlink()
        with self.assertRaisesRegex(ValueError, "x86_64-unknown-linux-gnu"):
            release.checksums("0.1.0", self.dist)

    def test_tag_must_match_the_manifest_including_prerelease(self):
        release.verify_tag("0.1.0", "v0.1.0")
        release.verify_tag("0.2.0-rc.1", "v0.2.0-rc.1")
        for tag in ["v0.0.3", "0.1.0", "v0.1.0-rc.1"]:
            with self.subTest(tag=tag), self.assertRaisesRegex(ValueError, "must match"):
                release.verify_tag("0.1.0", tag)

    def version_fixture(self):
        root = self.root / "project"
        for directory, name in (("server", "securevault"), ("desktop", "securevault-desktop")):
            (root / directory).mkdir(parents=True, exist_ok=True)
            (root / directory / "Cargo.toml").write_text(
                f'[package]\nname = "{name}"\nversion = "0.2.0"\n', encoding="utf-8")
            (root / directory / "Cargo.lock").write_text(
                f'[[package]]\nname = "{name}"\nversion = "0.2.0"\n', encoding="utf-8")
        (root / "desktop/tauri.conf.json").write_text(
            json.dumps({"version": "0.2.0"}), encoding="utf-8")
        return root

    def test_app_manifests_and_lockfiles_must_share_one_version(self):
        root = self.version_fixture()
        self.assertEqual(release.validate_versions(root), "0.2.0")
        for path in ("server/Cargo.lock", "desktop/Cargo.toml", "desktop/Cargo.lock", "desktop/tauri.conf.json"):
            with self.subTest(path=path):
                file = root / path
                original = file.read_text(encoding="utf-8")
                file.write_text(original.replace("0.2.0", "0.1.0"), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, path):
                    release.validate_versions(root)
                file.write_text(original, encoding="utf-8")

    def test_lockfile_must_include_the_application_package(self):
        root = self.version_fixture()
        (root / "desktop/Cargo.lock").write_text(
            '[[package]]\nname = "unrelated"\nversion = "0.2.0"\n', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "desktop/Cargo.lock.*securevault-desktop"):
            release.validate_versions(root)

    def test_version_cli_reports_the_real_manifest_and_rejects_an_old_tag(self):
        command = [sys.executable, str(release.ROOT / "scripts/release.py"), "version"]
        version = subprocess.run(command, check=True, capture_output=True, text=True).stdout.strip()
        accepted = subprocess.run(command + ["--tag", f"v{version}"], capture_output=True, text=True)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        rejected = subprocess.run(command + ["--tag", "v999.999.999"], capture_output=True, text=True)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn(f"must match Cargo.toml version v{version}", rejected.stderr)
        self.assertEqual(rejected.stdout, "")


if __name__ == "__main__":
    unittest.main()
