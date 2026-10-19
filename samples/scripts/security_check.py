#!/usr/bin/env python3
"""Run security regression checks on a new, isolated demo database."""
import argparse
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
    environment = os.environ.copy()
    for name in ('SECUREVAULT_PASSWORD','SECUREVAULT_DATA_DIR','SECUREVAULT_ADDR','SECUREVAULT_PUBLIC_ORIGIN'):
        environment.pop(name, None)
    with tempfile.TemporaryDirectory(prefix='security-', dir=scratch) as test_directory:
        process = subprocess.Popen([str((root / args.binary).resolve()), '--data-dir', test_directory, '--port', str(port)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environment)
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
                                      ('/vault/seal','POST',{}),('/vault/password','POST',{}),('/apps/x','PATCH',{}),
                                      ('/records/x/expired','POST',{})]:
                owner.request(path, data, method=method, headers=app, expected=403)
            session = owner.request('/vault/status')
            assert session['max_session_seconds'] == 21600
            activity = {'session_id': session['session_id'], 'idle_ms': 0}
            anonymous.request('/vault/activity', activity, expected=401)
            owner.request('/vault/activity', activity, headers=app, expected=403)
            owner.request('/vault/activity', dict(activity, session_id='old-session'), expected=409)
            owner.request('/vault/activity', dict(activity, idle_ms=1800000), expected=400)
            renewed = owner.request('/vault/activity', activity)
            assert renewed['idle_seconds_remaining'] == 1800
            time.sleep(1.1)
            owner.request('/records/search', headers=app)
            owner.request('/vault/summary')
            unchanged = owner.request('/vault/status')
            assert unchanged['idle_seconds_remaining'] <= 1799, 'API traffic must not renew browser idle time'
            assert unchanged['ttl_seconds_remaining'] <= renewed['ttl_seconds_remaining']
            assert owner.request('/vault/activity', activity)['idle_seconds_remaining'] == 1800
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
            app_baseline = second.request('/records/search',headers=app)['total']
            baseline = second.request('/datasets/'+payment+'/export?include_secrets=true')
            new_password = secrets.token_urlsafe(32)
            rotation = dict(current_password=password, new_password=new_password, confirm_password=new_password)
            anonymous.request('/vault/password',rotation,expected=401)
            second.request('/vault/password',rotation,headers=app,expected=403)
            second.request('/vault/password',dict(rotation,confirm_password='mismatch'),expected=400)
            second.request('/vault/password',dict(rotation,current_password='incorrect-password-123'),expected=401)
            second.request('/vault/password',rotation,expected=429)
            time.sleep(2.1)
            db_path = Path(test_directory)/'vault/securevault.db'
            # Assert the actual encrypted payloads and HMAC identities stay unchanged.
            # Export is the public API check; crypto unit tests compare all three keys.
            result = second.request('/vault/password',rotation)
            assert result['sealed'] and result['password_changed'] and not result['durability_warning']
            assert db_path.exists()
            second.request('/records/search',expected=423)
            second.request('/vault/unlock',{'password':password},expected=401)
            time.sleep(2.1)
            second.request('/vault/unlock',{'password':new_password})
            assert second.request('/datasets/'+payment+'/export?include_secrets=true') == baseline
            assert second.request('/records/search',headers=app)['total'] == app_baseline
            process.terminate()
            process.wait(timeout=10)
            process = subprocess.Popen([str((root / args.binary).resolve()), '--data-dir', test_directory, '--port', str(port), '--password-stdin'],
                                       stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environment)
            process.stdin.write((new_password+'\n').encode())
            process.stdin.close()
            for _ in range(100):
                try:
                    Client(port).request('/vault/status')
                    break
                except OSError:
                    time.sleep(.1)
            restarted = Client(port)
            assert restarted.request('/vault/status')['persistent']
            restarted.request('/datasets',expected=401)
            assert restarted.request('/records/search',headers=app)['total'] == app_baseline
            restarted.request('/vault/unlock',{'password':new_password})
            assert restarted.request('/datasets/'+payment+'/export?include_secrets=true') == baseline
            second.request('/records/search',expected=401)
            restarted.request('/vault/seal',{})
            restarted.request('/records/search',expected=423)
            meta = json.loads((Path(test_directory)/'vault/vault.meta.json').read_text())
            assert meta['header']['format'] == 1 and meta['header']['generation'] == 2
            assert meta['header']['memory_kib'] == 65536 and 'verifier' not in meta
            print('通过：主密码轮换、重启恢复、原数据及应用授权保持，18组演示检查及匿名访问、权限隔离、会话轮换、Origin/Host、注入、导出、限速安全回归。')
        finally:
            process.terminate()
            process.wait(timeout=10)


if __name__ == '__main__':
    main()
