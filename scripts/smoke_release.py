#!/usr/bin/env python3
"""Exercise an actual release binary with isolated data on every supported OS."""

import argparse
from contextlib import contextmanager
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

from release import ROOT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve()
    scratch = ROOT / "samples/.build"
    scratch.mkdir(parents=True, exist_ok=True)
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith("SECUREVAULT_")}
    with tempfile.TemporaryDirectory(prefix="release-smoke-", dir=scratch) as temporary:
        directory = Path(temporary)
        source = directory / "source data"
        rotated = directory / "rotated data"
        restored = directory / "restored data"
        archive = directory / "backup.age"

        @contextmanager
        def server(data):
            with socket.socket() as available:
                available.bind(("127.0.0.1", 0))
                port = available.getsockname()[1]
            opener = urllib.request.build_opener(
                urllib.request.ProxyHandler({}),
                urllib.request.HTTPCookieProcessor(CookieJar()),
            )

            def request(path, payload=None):
                body = json.dumps(payload).encode() if payload is not None else None
                headers = {"Content-Type": "application/json"} if body is not None else {}
                query = urllib.request.Request(f"http://127.0.0.1:{port}{path}", body, headers)
                with opener.open(query, timeout=30) as response:
                    raw = response.read()
                    return json.loads(raw) if path.startswith("/api/") else raw

            # A working directory without web/ verifies embedded release assets.
            with (directory / "server.log").open("wb") as log:
                process = subprocess.Popen(
                    [str(binary), "-d", str(data), "-p", str(port)],
                    cwd=directory, env=environment, stdin=subprocess.DEVNULL,
                    stdout=log, stderr=log,
                )
                try:
                    deadline = time.monotonic() + 30
                    while True:
                        if process.poll() is not None:
                            raise RuntimeError("release server exited before becoming ready")
                        try:
                            request("/api/vault/status")
                            break
                        except urllib.error.URLError:
                            if time.monotonic() >= deadline:
                                raise RuntimeError("release server did not become ready")
                            time.sleep(0.1)
                    yield request
                finally:
                    if process.poll() is None:
                        process.terminate()
                    process.wait(timeout=15)

        def cli(*arguments, passwords):
            result = subprocess.run(
                [str(binary), *map(str, arguments), "-s"],
                input=json.dumps(passwords).encode(), capture_output=True,
                cwd=directory, env=environment, timeout=180,
            )
            if result.returncode:
                raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))

        master, replacement, backup_password, rotated_password = [secrets.token_urlsafe(32) for _ in range(4)]
        with server(source) as request:
            assert b"<html" in request("/").lower(), "embedded frontend missing"
            request("/api/vault/setup", {"password": master})
            dataset = request("/api/datasets", {
                "category_path": "Release smoke",
                "fields": [{"source_key": "name", "zone": "indexes"},
                           {"source_key": "token", "zone": "secrets"}],
                "sample_data": [{"name": "release-check", "token": "smoke-secret"}],
            })["dataset_id"]
            export = f"/api/datasets/{dataset}/export?include_secrets=true"
            baseline = request(export)
            assert baseline and baseline[0]["token"] == "smoke-secret"
            request("/api/vault/password", {
                "current_password": master, "new_password": replacement,
                "confirm_password": replacement,
            })
            request("/api/vault/unlock", {"password": replacement})
            assert request(export) == baseline, "password change lost data"

        cli("backup", "-d", source, "-o", archive, passwords={
            "master_password": replacement, "backup_password": backup_password,
            "confirm_password": backup_password,
        })
        cli("restore", "-i", archive, "-o", restored, passwords={
            "master_password": master, "backup_password": backup_password,
            "confirm_password": master,
        })
        cli("rotate-keys", "-d", source, "-o", rotated, passwords={
            "current_password": replacement, "new_password": rotated_password,
            "confirm_password": rotated_password,
        })
        for data, password in [(restored, master), (rotated, rotated_password), (source, replacement)]:
            with server(data) as request:
                request("/api/vault/unlock", {"password": password})
                assert request(export) == baseline, f"data changed after reopening {data.name}"
        print("Release smoke passed: embedded web, SQLCipher, password change, backup, restore, key rotation.")


if __name__ == "__main__":
    main()
