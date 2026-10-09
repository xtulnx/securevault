#!/usr/bin/env python3
"""Exercise offline full-key rotation using all sample datasets in isolated directories."""
import argparse
import json
import os
import pty
import select
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import termios
import time
from demo import Client, initialize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', default='server/target/release/securevault')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    binary = str((root / args.binary).resolve())
    scratch = root / 'samples/.build'
    scratch.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    for name in ('SECUREVAULT_PASSWORD', 'SECUREVAULT_DATA_DIR', 'SECUREVAULT_ADDR', 'SECUREVAULT_PUBLIC_ORIGIN'):
        environment.pop(name, None)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]

    def start(directory, password=None):
        command = [binary, '--data-dir', str(directory), '--port', str(port)]
        if password:
            command.append('--password-stdin')
        process = subprocess.Popen(command, stdin=subprocess.PIPE if password else subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environment)
        if password:
            process.stdin.write(password.encode())
            process.stdin.close()
        for _ in range(100):
            try:
                Client(port).request('/vault/status')
                return process
            except OSError:
                time.sleep(.1)
        process.terminate()
        process.wait()
        raise RuntimeError('server failed to start')

    def stop(process):
        process.terminate()
        process.wait(timeout=10)

    def check_hidden_prompts(command, current, new, cancel=False):
        child, descriptor = pty.fork()
        if child == 0:
            os.execvpe(command[0], command, environment)
        captured = bytearray()
        try:
            for prompt, value in [('当前主密码：', current), ('新的主密码：', new), ('确认新密码：', new)]:
                deadline = time.monotonic() + 15
                while prompt.encode() not in captured:
                    assert time.monotonic() < deadline, 'terminal prompt timed out'
                    readable, _, _ = select.select([descriptor], [], [], .2)
                    if readable:
                        captured.extend(os.read(descriptor, 4096))
                if cancel:
                    os.write(descriptor, b'\x03')
                    break
                os.write(descriptor, value.encode()+b'\n')
            while True:
                try:
                    chunk = os.read(descriptor, 4096)
                    if not chunk:
                        break
                    captured.extend(chunk)
                except OSError:
                    break
            _, status = os.waitpid(child, 0)
            assert os.waitstatus_to_exitcode(status) != 0  # Deliberately wrong current password.
            assert current.encode() not in captured and new.encode() not in captured
            assert termios.tcgetattr(descriptor)[3] & termios.ECHO, 'terminal echo was not restored'
        finally:
            os.close(descriptor)

    with tempfile.TemporaryDirectory(prefix='rotation-', dir=scratch) as temporary:
        source, destination = Path(temporary)/'source', Path(temporary)/'rotated'
        password, replacement = secrets.token_urlsafe(32), '新的密钥-'+secrets.token_urlsafe(32)
        process = start(source)
        try:
            owner = Client(port)
            manifest, report = initialize(owner, password)
            assert len(report['checks']) == 18
            datasets = owner.request('/datasets')['datasets']
            baseline = {item['id']: owner.request('/datasets/'+item['id']+'/export?include_secrets=true') for item in datasets}
            assert sum(len(rows) for rows in baseline.values()) == 98
            metadata = (source/'vault/vault.meta.json').read_bytes()
            payload = json.dumps(dict(current_password=password, new_password=replacement, confirm_password=replacement)).encode()
            command = [binary, 'rotate-keys', '-d', str(source), '-o', str(destination), '-s']
            def rotate(data=payload):
                return subprocess.run(command, input=data, capture_output=True, env=environment, timeout=90)
            assert rotate().returncode != 0  # Shared exclusive lock rejects online rotation.
            assert not destination.exists()
            stop(process)
            process = None
            original_db = (source/'vault/securevault.db').read_bytes()
            wrong = json.dumps(dict(current_password='wrong-password', new_password=replacement, confirm_password=replacement)).encode()
            assert rotate(wrong).returncode != 0
            check_hidden_prompts(command[:-1], "wrong-terminal-password", replacement)
            check_hidden_prompts(command[:-1], "wrong-terminal-password", replacement, cancel=True)
            assert not destination.exists()
            result = rotate()
            assert result.returncode == 0, result.stderr.decode()
            assert (source/'vault/vault.meta.json').read_bytes() == metadata
            assert (source/'vault/securevault.db').read_bytes() == original_db
            assert rotate().returncode != 0  # Refuse overwriting an existing result.
            process = start(destination, replacement)
            new_owner = Client(port)
            new_owner.request('/vault/unlock', {'password':replacement})
            actual = {item['id']: new_owner.request('/datasets/'+item['id']+'/export?include_secrets=true') for item in new_owner.request('/datasets')['datasets']}
            assert actual == baseline
            apps = new_owner.request('/apps')['apps']
            assert apps and all(app['disabled'] for app in apps)
            for app in manifest['apps']:
                new_owner.request('/records/search', headers={'X-App-Id':app['id'], 'X-App-Key':app['key']}, expected=401)
            new_owner.request('/vault/unlock', {'password':password}, expected=401)
            print('完整密钥轮换检查通过：18 项演示验证、8 个数据集/98 条记录及敏感内容完整保留；在线轮换/错误密码/覆盖输出均被拒绝；旧凭据失效，新库重启成功，原库未修改。')
        finally:
            if process:
                stop(process)


if __name__ == '__main__':
    main()
