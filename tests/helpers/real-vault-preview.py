"""Disposable real-service regression fixture; never opens the project data/ vault."""
import argparse
import copy
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'samples/scripts'))
from demo import Client

PASSWORD = 'Audit-only-2026!pass'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--port', type=int, default=4189)
    parser.add_argument('--report-name', default='final-audit-e2e.json')
    args = parser.parse_args()
    if Path(args.report_name).name != args.report_name or not args.report_name.endswith('.json'):
        parser.error('report-name must be a JSON filename')
    scratch = ROOT / 'samples/.build'
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='ui-final-audit-', dir=scratch) as directory:
        folder = Path(directory)
        with (folder / 'server.log').open('w') as log:
            process = subprocess.Popen([str(ROOT / 'server/target/debug/securevault'), '--data-dir', str(folder / 'vault'), '--addr', f'127.0.0.1:{args.port}'], cwd=ROOT, stdout=log, stderr=log, stdin=subprocess.DEVNULL)
            try:
                client = Client(args.port)
                for _ in range(100):
                    try: client.request('/vault/status'); break
                    except Exception:
                        if process.poll() is not None: raise RuntimeError('Isolated service exited during startup')
                        time.sleep(.05)
                client.request('/vault/setup', {'password': PASSWORD})
                fields = [{'source_key': key, 'display_name': label, 'zone': zone, 'position': index, 'unique': key == 'code'} for index, (key, label, zone) in enumerate([
                    ('code', '编号', 'indexes'), ('name', '名称', 'display'), ('enabled', '启用', 'display'), ('memo', '备注', 'normal'), ('config', '配置', 'normal'), ('token', '凭据', 'secrets')])]
                rows = [{'code': f'A-{i:03}', 'name': f'回归服务 {i}', 'enabled': False if i == 0 else True, 'memo': '多行内容\n第二行' if i == 0 else '原备注', 'config': {'count': 0, 'enabled': False}, 'token': 'SYNTHETIC-ONLY-TOKEN'} for i in range(23)]
                created = client.request('/datasets', {'name': '回归账户', 'category_path': '回归/账户', 'environment_names': ['内部', '测试'], 'fields': fields, 'identity_fields': ['code'], 'sample_data': rows})
                a = created['dataset_id']
                catalog = client.request('/catalog')
                model = catalog['schemas'][0]
                definition = copy.deepcopy(model['definition'])
                definition['supplement_fields'] = [{'source_key': 'note', 'display_name': '附表备注', 'zone': 'normal', 'position': 0}]
                proposal = {'schema_id': model['id'], 'definition': definition}
                preview = client.request('/schemas/preview', proposal)
                client.request('/schemas/publish', {**proposal, 'confirmation_token': preview['confirmation_token']})
                b = client.request('/datasets', {'name': '外部账户', 'category_path': '回归/外部', 'environment_names': ['外部'], 'schema_id': model['id']})['dataset_id']
                records = client.search(dataset_id=a, limit=40)['records']
                first = next(row['id'] for row in records if row['indexes']['code'] == 'A-000')
                # Explicit null is different from removing the field. Keep the browser fixture intact.
                client.request(f'/records/{first}', {'values': {'memo': None}}, method='PATCH')
                null_detail = client.request(f'/records/{first}')
                assert 'memo' in null_detail['normal'] and null_detail['normal']['memo'] is None
                client.request(f'/records/{first}', {'values': {'memo': '多行内容\n第二行'}}, method='PATCH')
                occupied = next(row['id'] for row in records if row['indexes']['code'] == 'A-001')
                client.request(f'/datasets/{a}/supplement/records', {'main_record_id': occupied, 'values': {'note': '已占用'}})
                filters = {'q': 'enabled:=false', 'categories': ['回归'], 'labels': ['内部', '测试'], 'schema_id': model['id'], 'dataset_id': a, 'include_expired': False}
                saved = client.request('/saved-queries', {'name': '布尔值回归', 'filters': filters})
                assert client.request('/saved-queries')['queries'][0]['filters'] == filters
                client.request('/saved-queries/' + saved['id'], {'name': '布尔值回归（更新）', 'filters': filters}, method='PATCH')
                assert client.request('/saved-queries')['queries'][0]['name'].endswith('（更新）')
                client.request('/saved-queries/' + saved['id'], method='DELETE')
                assert client.request('/saved-queries')['queries'] == []
                query = client.request('/saved-queries', {'name': '浏览器回归查询', 'filters': filters})
                app = client.request('/apps', {'name': '回归检索应用', 'permission': 'search', 'datasets': [a], 'access_ttl_seconds': 1800})
                credentials = {'X-App-Id': app['id'], 'X-App-Key': app['key']}
                client.request('/saved-queries', headers=credentials, expected=403)
                client.request('/saved-queries', {'name': 'forbidden', 'filters': filters}, headers=credentials, expected=403)
                client.request('/saved-queries', {'name': 'forbidden', 'filters': filters}, headers={'Origin': 'https://invalid.example.test'}, expected=403)
                client.request(f'/records/{first}/secrets/reveal', {'field_name': 'token'}, headers=credentials, expected=403)
                before = client.request('/apps')['apps'][0]['access_expires_at']
                client.request('/apps/' + app['id'], {'datasets': [a, b], 'permission': 'search'}, method='PATCH')
                assert client.request('/apps')['apps'][0]['access_expires_at'] == before
                client.request('/apps/' + app['id'], {'datasets': [a], 'permission': 'search'}, method='PATCH')
                # Exercise real upload -> preview -> commit, only in the disposable vault.
                payload = json.dumps([{'code': 'IMPORT-1', 'name': '导入回归', 'enabled': False}]).encode()
                boundary = 'AuditUploadBoundary'
                content = f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audit.json"\r\nContent-Type: application/json\r\n\r\n'.encode() + payload + f'\r\n--{boundary}--\r\n'.encode()
                request = urllib.request.Request(client.base + '/imports/upload', data=content, headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
                with client.opener.open(request) as response: upload = json.load(response)
                import_body = {'dataset_id': b, 'batch_id': upload['batch_id'], 'mappings': [{'source_key': key, 'target_key': key} for key in ['code', 'name', 'enabled']]}
                prediction = client.request('/records/import/preview', import_body)
                result = client.request('/records/import', import_body)
                assert prediction['imported'] == result['imported'] == 1
                assert client.search(dataset_id=b)['total'] == 1
                client.request('/vault/seal', {})
                client.request('/saved-queries', expected=423)
                client.request('/vault/unlock', {'password': PASSWORD})
                assert client.request('/saved-queries')['queries'][0]['id'] == query['id']
                info = {'url': f'http://127.0.0.1:{args.port}', 'dataset': a, 'other_dataset': b, 'record': first, 'schema': model['id'], 'checks': ['real shared-schema preview/publish', 'explicit null roundtrip preserves field presence', 'typed query CRUD and persistence', 'owner/app/CSRF boundaries', 'unchanged authorization expiry', 'real upload/preview/commit', 'seal/reunlock'], 'passed': True}
                (ROOT / 'docs/ui-design/implementation').mkdir(parents=True, exist_ok=True)
                (ROOT / 'docs/ui-design/implementation' / args.report_name).write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n')
                (folder / 'audit.json').write_bytes(payload)
                print(json.dumps({**info, 'upload_fixture': str(folder / 'audit.json')}, ensure_ascii=False), flush=True)
                if args.serve:
                    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
                    while True: time.sleep(1)
            finally:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill(); process.wait()

if __name__ == '__main__':
    try: main()
    except KeyboardInterrupt: pass
