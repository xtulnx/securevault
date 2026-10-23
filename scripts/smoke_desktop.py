#!/usr/bin/env python3
"""Check the desktop service protocol and optionally a real debug WebView, using disposable data."""
import argparse
import errno
from contextlib import contextmanager
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import queue
import secrets
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


@contextmanager
def default_port_conflict():
    # If another local process already owns 4173, leave it entirely untouched.
    with socket.socket() as listener:
        try:
            listener.bind(('127.0.0.1', 4173))
            listener.listen()
        except OSError as error:
            if error.errno != errno.EADDRINUSE: raise
        yield


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--desktop', type=Path, help='Debug desktop executable: runs the real WebView check')
    parser.add_argument('--packaged-desktop', type=Path, help='Release executable inside the app: checks the bundled service and crash cleanup')
    args = parser.parse_args()
    binary = args.binary.resolve()
    scratch = ROOT / 'samples/.build'
    scratch.mkdir(parents=True, exist_ok=True)
    environment = {key: value for key, value in os.environ.items() if not key.startswith('SECUREVAULT_')}
    with tempfile.TemporaryDirectory(prefix='desktop-smoke-', dir=scratch) as temporary:
        root = Path(temporary)
        data = root / 'vault data'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(CookieJar()))

        @contextmanager
        def server(directory=data, port=0, auto_port=False):
            process = subprocess.Popen([str(binary), '--desktop-stdio', '-p', str(port), '-d', str(directory)] + (['--desktop-auto-port'] if auto_port else []),
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, cwd=root)
            try:
                ready = queue.Queue()
                threading.Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
                line = ready.get(timeout=30)
                if not line: raise AssertionError(process.stderr.read().decode())
                info = json.loads(line)
                assert info['event'] == 'ready' and info['protocol'] == 1
                url = info['url']
                assert url.startswith('http://127.0.0.1:') and not url.endswith(':0')
                yield process, url
            finally:
                if process.stdin: process.stdin.close()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(); raise
                process.stdout.close(); process.stderr.close()

        def request(url, path, payload=None, headers=None, client=opener):
            headers = dict(headers or {})
            if payload is not None: headers['Content-Type'] = 'application/json'
            query = urllib.request.Request(url + path, json.dumps(payload).encode() if payload is not None else None, headers)
            with client.open(query, timeout=20) as response:
                body = response.read()
                return json.loads(body) if path.startswith('/api/') else body, response.headers

        password = secrets.token_urlsafe(32)
        with server() as (process, url):
            html, headers = request(url, '/')
            assert b'workbench.js' in html and 'ipc:' in headers['Content-Security-Policy']
            status, _ = request(url, '/api/vault/status')
            assert status['sealed'] and not status['initialized']
            _, headers = request(url, '/api/vault/setup', {'password': password})
            assert 'HttpOnly' in headers['Set-Cookie'] and 'SameSite=Strict' in headers['Set-Cookie']
            status, _ = request(url, '/api/vault/status')
            assert not status['sealed'] and not status['persistent']
            request(url, '/api/datasets')
            try: request(url, '/api/vault/seal', {}, {'Origin': 'http://untrusted.example'})
            except urllib.error.HTTPError as error: assert error.code == 403
            else: raise AssertionError('cross-origin management was accepted')
            # Same directory must remain exclusive even when a different port is available.
            duplicate = subprocess.run([str(binary), '--desktop-stdio', '-p', '0', '-d', str(data)],
                                       input=b'', capture_output=True, env=environment, timeout=15)
            assert duplicate.returncode != 0
            process.stdin.close(); process.wait(timeout=10)
            assert process.returncode == 0
        with server() as (_, url):
            # Neither old cookies nor a reopened process retain unlocked state.
            status, _ = request(url, '/api/vault/status')
            assert status['sealed'] and status['initialized']
            request(url, '/api/vault/unlock', {'password': password})
            request(url, '/api/vault/seal', {})
        with socket.socket() as occupied:
            occupied.bind(('127.0.0.1', 0)); occupied.listen()
            collision = subprocess.run([str(binary), '--desktop-stdio', '-p', str(occupied.getsockname()[1]), '-d', str(root / 'collision')],
                                       input=b'', capture_output=True, env=environment, timeout=15)
            assert collision.returncode != 0 and b'"event":"ready"' not in collision.stdout
            with server(root / 'fallback', occupied.getsockname()[1], True) as (_, fallback_url):
                assert urllib.parse.urlparse(fallback_url).port != occupied.getsockname()[1]
                status, _ = request(fallback_url, '/api/vault/status')
                assert status['sealed'] and not status['initialized']
        internal_only = subprocess.run([str(binary), '--desktop-auto-port', '-d', str(root / 'invalid-fallback')],
                                       input=b'', capture_output=True, env=environment, timeout=15)
        assert internal_only.returncode != 0 and not (root / 'invalid-fallback').exists()
        rejected = subprocess.run([str(binary), '--desktop-stdio', '--password-stdin', '-d', str(root / 'rejected')],
                                  input=b'not-a-real-password', capture_output=True, env=environment, timeout=15)
        assert rejected.returncode != 0 and not (root / 'rejected').exists()
        print('Desktop service protocol: readiness, embedded UI, cookies, origin protection, directory lock, EOF shutdown, restart lock, port conflict and password rejection passed.')
        if args.desktop:
            with default_port_conflict():
                result = subprocess.run([str(args.desktop.resolve()), '--smoke-test', '--data-dir', str(root / 'webview')],
                                        capture_output=True, text=True, env=environment, cwd=root, timeout=90)
            if result.returncode or 'DESKTOP_SMOKE_OK' not in result.stdout:
                raise AssertionError(result.stdout + result.stderr or
                                     'Desktop exited without running the smoke check. Another instance may be running; build with the isolated org.nx.securevault.smoke identifier described in docs/DESKTOP.md.')
            service_url = next(line.split('=', 1)[1] for line in result.stdout.splitlines() if line.startswith('DESKTOP_SERVICE_URL='))
            assert urllib.parse.urlparse(service_url).port != 4173
            # The parent exited normally; its bundled service must also have released the directory.
            with server(root / 'webview') as (_, url):
                status, _ = request(url, '/api/vault/status')
                assert status['sealed'] and status['initialized']
            settings = json.loads((root / 'desktop-settings.json').read_text())
            assert Path(settings['data_dir']) == (root / 'webview').resolve()
            with server(root / 'smoke-second-vault') as (_, url):
                request(url, '/api/vault/unlock', {'password': 'SECOND_DESKTOP_SMOKE_ONLY_PASSWORD'})
            print('Native WebView: default port conflict fallback, initialization, cookie session, unlock, protected APIs, dirty state, directory round trip, retained vault data, saved selection, seal and exit cleanup passed.')
        if args.packaged_desktop:
            # No test-only entrypoint is required in release builds. Launch the actual
            # packaged executable, then simulate the desktop parent crashing.
            packaged_environment = {**environment, 'SECUREVAULT_DATA_DIR': str(root / 'packaged')}
            process = subprocess.Popen([str(args.packaged_desktop.resolve()), '--port', '0'],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=packaged_environment, cwd=root)
            try:
                ready = queue.Queue()
                threading.Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
                line = ready.get(timeout=30).decode()
                assert line.startswith('DESKTOP_SERVICE_URL='), line
                url = line.strip().split('=', 1)[1].rstrip('/')
                for attempt in range(100):
                    try:
                        html, _ = request(url, '/')
                        break
                    except urllib.error.URLError:
                        if attempt == 99: raise
                        time.sleep(.1)
                assert b'workbench.js' in html
                request(url, '/api/vault/setup', {'password': password})
                # A second launch must focus the existing app, not open another vault.
                second = subprocess.run([str(args.packaged_desktop.resolve()), '--data-dir', str(root / 'must-not-open'), '--port', '0'],
                                        capture_output=True, text=True, env=environment, cwd=root, timeout=15)
                assert second.returncode == 0 and not (root / 'must-not-open').exists(), second.stderr
            finally:
                process.kill(); process.wait(timeout=10)
                process.stdout.close(); process.stderr.close()
            for attempt in range(100):
                try: request(url, '/api/vault/status')
                except urllib.error.URLError: break
                if attempt == 99: raise AssertionError('bundled service survived desktop parent crash')
                time.sleep(.1)
            with server(root / 'packaged') as (_, url):
                status, _ = request(url, '/api/vault/status')
                assert status['sealed'] and status['initialized']
            print('Packaged app: environment directory, bundled assets, initialization, single instance, parent crash cleanup and directory lock release passed.')


if __name__ == '__main__':
    main()
