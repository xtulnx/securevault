#!/usr/bin/env python3
"""Exercise shared schemas through HTTP using an isolated, fictional vault."""
import argparse
import http.cookiejar
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]

def run(binary):
    build = ROOT / 'samples' / '.build'
    build.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='catalog-check-', dir=build) as directory:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        base = f'http://127.0.0.1:{port}'
        with open(Path(directory) / 'server.log', 'w') as log:
            process = subprocess.Popen([str(binary), '-d', str(Path(directory) / 'vault-data'), '-p', str(port)], cwd=ROOT, stdout=log, stderr=log)
            try:
                owner = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
                checks = []
                def api(path, method='GET', data=None, expected=200, app=None):
                    headers = {'Content-Type': 'application/json', 'Origin': base}
                    if app:
                        headers.update({'X-App-Id': app['id'], 'X-App-Key': app['key']})
                    request = urllib.request.Request(base + '/api' + path, data=None if data is None else json.dumps(data).encode(), headers=headers, method=method)
                    try:
                        with owner.open(request, timeout=20) as response:
                            status, result = response.status, json.load(response)
                    except urllib.error.HTTPError as error:
                        status, result = error.code, json.load(error)
                    assert status == expected, (path, status, result.get('error'))
                    return result
                for _ in range(100):
                    try:
                        api('/vault/status')
                        break
                    except (urllib.error.URLError, ConnectionError):
                        if process.poll() is not None:
                            raise RuntimeError('test server exited')
                        time.sleep(.1)
                else:
                    raise RuntimeError('test server did not start')
                api('/vault/setup', 'POST', {'password': 'DEMO_ONLY_catalog_check_password'})
                customers = [api('/catalog/environments', 'POST', {'name': name}) for name in ['客户A', '客户B']]
                environments = [api('/catalog/environments', 'POST', {'name': name}) for name in ['测试', '生产']]
                definition = {'fields': [{'source_key': 'id', 'zone': 'indexes'}, {'source_key': 'token', 'zone': 'secrets'}, {'source_key': 'note', 'zone': 'normal'}], 'identity_fields': ['id'], 'list_fields': [], 'display_config': {'density': 'summary', 'identifier_fields': ['id']}, 'supplement_fields': [{'source_key': 'memo', 'zone': 'normal'}, {'source_key': 'secret', 'zone': 'secrets'}]}
                def publish(request):
                    preview = api('/schemas/preview', 'POST', request)
                    return api('/schemas/publish', 'POST', {**request, 'confirmation_token': preview['confirmation_token']})
                model_note = '## 提取方法\n\n```sql\nSELECT id, token FROM demo_merchants;\n```\n'
                schema = publish({'name': '商户数据模型', 'description': model_note, 'definition': definition})['schema_id']
                datasets = [api('/datasets', 'POST', {'name': '  商户凭据  ', 'category_path': '支付/商户', 'schema_id': schema, 'environment_ids': [customer['id'], env['id']], 'sample_data': [{'id': '00123', 'token': 'DEMO_ONLY_catalog_token', 'note': '原始说明'}]}) for customer in customers for env in environments]
                ids = [d['dataset_id'] for d in datasets]
                assert len(set(ids)) == 4
                assert all(d['name'] == '商户凭据' for d in datasets)
                assert api('/records/search?schema_id=' + schema)['total'] == 4
                assert api('/records/search?environment_id=' + customers[0]['id'])['total'] == 2
                assert api('/records/search?environment_tags=' + urllib.parse.quote(json.dumps(['客户A', '生产'])))['total'] == 1
                assert api('/records/search?environment_tags=' + urllib.parse.quote(json.dumps(['测试', '生产'])))['total'] == 0
                checks.append('shared creation and multi-label customer/environment filters')
                app = api('/apps', 'POST', {'name': '只访问A测试', 'permission': 'secrets', 'datasets': [ids[0]]})
                assert api('/client/datasets', app=app)['datasets'][0]['environments'] == ['客户A', '测试']
                assert len(api('/client/datasets', app=app)['datasets']) == 1
                assert 'schema_description' not in api('/client/datasets', app=app)['datasets'][0]
                api('/catalog', expected=403, app=app)
                api('/schemas/preview', 'POST', {'schema_id': schema}, expected=403, app=app)
                checks.append('app scope remains at instance level')
                readonly = api('/apps', 'POST', {'name': '只读A测试', 'permission': 'search', 'datasets': [ids[0]]})
                disabled = api('/apps', 'POST', {'name': '已停用应用', 'permission': 'secrets', 'datasets': [ids[1]]})
                api('/apps/' + disabled['id'], 'PATCH', {'disabled': True})
                record_ids = [api('/records/search?dataset_id=' + dataset)['records'][0]['id'] for dataset in ids]
                other_supplement = api('/datasets/' + ids[1] + '/supplement/records', 'POST', {'main_record_id': record_ids[1], 'values': {'memo': '生产附表', 'secret': 'DEMO_ONLY_production'}})['id']
                def assert_app_boundaries(check_own_secret=False):
                    result = api('/records/search?schema_id=' + schema, app=app)
                    assert result['total'] == 1 and result['records'][0]['dataset_id'] == ids[0]
                    assert api('/records/search?dataset_id=' + ids[1], app=app)['total'] == 0
                    for target in ids[1:]:
                        api('/datasets/' + target + '/export?format=json', expected=403, app=app)
                    api('/records/' + record_ids[1], expected=403, app=app)
                    api('/records/' + record_ids[1] + '/secrets/reveal', 'POST', {'field_name': 'token'}, expected=403, app=app)
                    api('/supplement/' + other_supplement + '/secrets/reveal', 'POST', {'field_name': 'secret'}, expected=403, app=app)
                    api('/records/' + record_ids[0] + '/secrets/reveal', 'POST', {'field_name': 'token'}, expected=403, app=readonly)
                    api('/records/search', expected=403, app=disabled)
                    if check_own_secret:
                        assert api('/records/' + record_ids[0] + '/secrets/reveal', 'POST', {'field_name': 'token'}, app=app)['value'] == 'DEMO_ONLY_catalog_token'
                assert_app_boundaries(True)
                app_states = {row['id']: row for row in api('/apps')['apps']}
                checks.append('direct detail, export, main/supplement secrets and disabled/readonly permissions stay bounded')
                api('/datasets/' + ids[0], 'PATCH', {'name': '客户A测试凭据', 'category_path': '支付/商户', 'environment_names': ['客户A', '测试']})
                assert api('/client/datasets', app=app)['datasets'][0]['name'] == '客户A测试凭据'
                api('/datasets/' + ids[0], 'PATCH', {'name': 'x' * 121}, expected=400)
                api('/datasets/' + ids[0], 'PATCH', {})
                current = {d['id']: d for d in api('/datasets')['datasets']}
                assert current[ids[0]]['name'] == '客户A测试凭据' and current[ids[1]]['name'] == '商户凭据'
                assert api('/records/search?dataset_id=' + ids[0])['records'][0]['id'] == record_ids[0]
                assert {row['id']: row for row in api('/apps')['apps']} == app_states
                assert_app_boundaries(True)
                checks.append('optional instance names round trip without changing records, other instances or grants')
                independent = api('/datasets', 'POST', {'name': '旧商户凭据', 'category_path': '旧目录/商户', 'environment': '测试', 'fields': definition['fields'], 'identity_fields': definition['identity_fields'], 'sample_data': [{'id': '00123', 'token': 'DEMO_ONLY_old', 'note': '保留原值'}]})
                old_id = independent['dataset_id']
                publish({'schema_id': schema, 'dataset_ids': [old_id]})
                assert api('/records/search?dataset_id=' + old_id)['total'] == 1
                assert len(api('/client/datasets', app=app)['datasets']) == 1
                assert next(d for d in api('/datasets')['datasets'] if d['id'] == old_id)['name'] == '旧商户凭据'
                checks.append('manual merge preserves records and existing app credentials')
                assert {row['id']: row for row in api('/apps')['apps']} == app_states
                assert_app_boundaries(True)
                record = api('/records/search?dataset_id=' + ids[0])['records'][0]
                operation = {'schema_id': schema, 'definition': definition, 'name': '商户统一模型'}
                preview = api('/schemas/preview', 'POST', operation)
                api('/records/' + record['id'], 'PATCH', {'values': {'note': '仅更新A测试'}})
                api('/schemas/publish', 'POST', {**operation, 'confirmation_token': preview['confirmation_token']}, expected=409)
                assert api('/records/' + api('/records/search?dataset_id=' + ids[1])['records'][0]['id'])['normal']['note'] == '原始说明'
                checks.append('stale previews rejected; instance writes stay isolated')
                # Real JSON file import: identical business ids and full-batch deletion
                # must remain scoped to one customer/environment, including templates.
                for target in ids[:2]:
                    api('/datasets/' + target + '/records', 'POST', {'values': {'id': '00999', 'note': '保留其他环境'}})
                boundary = 'catalog-isolated-upload'
                records_json = json.dumps([{'id': '00123', 'token': 'DEMO_ONLY_catalog_token', 'note': '批量只更新A测试'}])
                multipart = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="merchants.json"\r\nContent-Type: application/json\r\n\r\n{records_json}\r\n--{boundary}--\r\n').encode()
                upload = urllib.request.Request(base + '/api/imports/upload', data=multipart, headers={'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Origin': base}, method='POST')
                with owner.open(upload, timeout=20) as response:
                    batch = json.load(response)
                import_request = {'dataset_id': ids[0], 'batch_id': batch['batch_id'], 'delete_missing': True, 'template_name': '商户同步模板'}
                api('/records/import', 'POST', import_request)
                assert api('/records/search?dataset_id=' + ids[0])['total'] == 1
                assert api('/records/search?dataset_id=' + ids[1])['total'] == 2
                with owner.open(upload, timeout=20) as response:
                    second_batch = json.load(response)
                conflict = api('/records/import', 'POST', {**import_request, 'dataset_id': ids[1], 'batch_id': second_batch['batch_id']}, expected=400)
                assert '模板' in conflict['error']
                assert api('/records/search?dataset_id=' + ids[1])['total'] == 2
                other = api('/records/' + record_ids[1])
                assert other['normal']['note'] == '原始说明'
                assert_app_boundaries(True)
                checks.append('same business id, full-batch deletion and template-name conflicts never overwrite another instance')
                updated = json.loads(json.dumps(definition))
                updated['fields'][1].update(source_key='credential', previous_source_key='token', zone='hidden')
                publish({'schema_id': schema, 'definition': updated})
                all_datasets = api('/datasets')['datasets']
                for dataset in all_datasets:
                    assert dataset['schema_id'] == schema
                    assert any(f['source_key'] == 'credential' and f['zone'] == 'hidden' for f in dataset['fields'])
                checks.append('shared field rename and encryption-zone migration reach every instance')
                api('/catalog/environments/' + environments[0]['id'], 'PATCH', {'name': '预发布'})
                assert api('/records/search?environment=' + urllib.parse.quote('预发布'))['total'] == 3
                api('/catalog/environments/' + customers[0]['id'], 'DELETE', expected=400)
                api('/schemas/' + schema, 'DELETE', expected=400)
                checks.append('dimension rename updates filters; referenced items cannot be deleted')
                package = api('/datasets/' + ids[0] + '/export?content=schema&format=json')
                assert package['schema']['environments'] == ['客户A', '预发布']
                assert package['schema']['schema_description'] == model_note
                assert package['schema']['name'] == '客户A测试凭据'
                request = {'package': package, 'category_path': '迁移/商户', 'environments': package['schema']['environments']}
                preview = api('/datasets/transfer/preview', 'POST', request)
                transferred = api('/datasets/transfer/import', 'POST', {**request, 'confirmation_token': preview['confirmation_token'], 'confirm_changes': True})
                imported = next(d for d in api('/datasets')['datasets'] if d['id'] == transferred['dataset_id'])
                assert imported['environments'] == ['客户A', '预发布']
                assert imported['schema_id'] != schema
                assert imported['name'] == '客户A测试凭据'
                assert next(item for item in api('/catalog')['schemas'] if item['id'] == imported['schema_id'])['description'] == model_note
                checks.append('native schema interchange preserves all labels and creates an independent definition')
                api('/vault/seal', 'POST', {})
                api('/vault/unlock', 'POST', {'password': 'DEMO_ONLY_catalog_check_password'})
                assert len(api('/client/datasets', app=app)['datasets']) == 1
                assert_app_boundaries()
                assert {row['id']: row for row in api('/apps')['apps']} == app_states
                assert api('/client/datasets', app=app)['datasets'][0]['name'] == '客户A测试凭据'
                checks.append('repeated runtime upgrade preserves associations and app credentials')
                print(json.dumps({'passed': len(checks), 'checks': checks}, ensure_ascii=False, indent=2))
            finally:
                process.terminate()
                process.wait(timeout=10)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=ROOT / 'server/target/debug/securevault')
    run(parser.parse_args().binary.resolve())
