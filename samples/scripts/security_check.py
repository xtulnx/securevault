#!/usr/bin/env python3
"""Run security regression checks on a new, isolated demo database."""
import argparse
import json
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from demo import Client, initialize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', default='server/target/release/securevault')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    scratch = root / 'samples/.build'
    scratch.mkdir(parents=True, exist_ok=True)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix='security-', dir=scratch) as test_directory:
        process = subprocess.Popen([str((root / args.binary).resolve()), '--data-dir', test_directory, '--port', str(port)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            owner, anonymous = Client(port), Client(port)
            for _ in range(100):
                try:
                    anonymous.request('/vault/status')
                    break
                except OSError:
                    time.sleep(.1)
            else:
                raise RuntimeError('server failed to start')
            password = secrets.token_urlsafe(32)
            manifest, report = initialize(owner, password)
            assert len(report['checks']) == 18
            for path in ['/records/search', '/apps', '/datasets', '/vault/summary',
                         '/datasets/'+manifest['datasets']['games_prod']+'/export?include_secrets=true']:
                anonymous.request(path, expected=401)
                anonymous.request(path, headers={'X-Vault-Owner': '1'}, expected=401)
            signer = manifest['apps'][1]
            payment = manifest['datasets']['payments']
            sensitive_app = {'X-App-Id':signer['id'],'X-App-Key':signer['key']}
            downloaded = owner.request('/datasets/'+payment+'/export?include_secrets=true', headers=sensitive_app)
            assert downloaded and all('certificate' not in row for row in downloaded)
            assert any('api_key' in row for row in downloaded)
            downloaded = owner.request('/datasets/'+payment+'/export?include_secrets=true')
            assert any('certificate' in row for row in downloaded)
            readonly = manifest['apps'][0]
            app = {'X-App-Id': readonly['id'], 'X-App-Key': readonly['key']}
            for path, method, data in [('/apps','GET',None),('/datasets','GET',None),
                                      ('/datasets','POST',{}),('/imports/upload','POST',{}),
                                      ('/vault/seal','POST',{}),('/apps/x','PATCH',{}),
                                      ('/records/x/expired','POST',{})]:
                owner.request(path, data, method=method, headers=app, expected=403)
            owner.request('/records/search', headers={'X-App-Id':'invalid','X-App-Key':'invalid'}, expected=401)
            for headers in [{'Origin':'https://evil.example'}, {'Host':'evil.example'}, {'Sec-Fetch-Site':'cross-site'}]:
                owner.request('/records/search', headers=headers, expected=403)
            ds = dict(category_path='安全测试', fields=[dict(source_key='title',zone='display')],
                      identity_fields=['<img src=x onerror=alert(1)>'])
            owner.request('/datasets', ds, expected=400)
            ds['identity_fields'] = []
            ds['list_fields'] = [dict(source_key='title',format='\" onmouseover=alert(1)')]
            owner.request('/datasets', ds, expected=400)
            ds['list_fields'] = []
            ds['sample_data'] = [{'title':'=HYPERLINK("https://example.test")'}]
            added = owner.request('/datasets',ds)['dataset_id']
            with owner.opener.open(owner.base+'/datasets/'+added+'/export?format=csv') as response:
                assert response.headers['Cache-Control'] == 'no-store'
                assert b"'=HYPERLINK" in response.read()
                assert response.headers['Content-Security-Policy']
            owner.request('/vault/unlock', {'password':'wrong-password-123'}, expected=401)
            owner.request('/vault/unlock', {'password':'wrong-password-123'}, expected=429)
            time.sleep(2.1)
            second = Client(port)
            second.request('/vault/unlock', {'password':password})
            owner.request('/records/search', expected=401)
            second.request('/vault/seal',{})
            second.request('/records/search',expected=423)
            meta = json.loads((Path(test_directory)/'vault.meta.json').read_text())
            assert meta['kdf_version'] == 2
            print('通过：18组演示检查及匿名访问、权限隔离、会话轮换、Origin/Host、注入、导出、限速安全回归。')
        finally:
            process.terminate()
            process.wait(timeout=10)


if __name__ == '__main__':
    main()
