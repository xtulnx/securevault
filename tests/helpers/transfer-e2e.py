"""Real HTTP regression for file/text interchange; uses only a disposable project-local vault."""
import argparse
import json
import io
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'samples/scripts'))
from demo import Client

PASSWORD = 'Transfer-regression-only-2026!'


def run(serve=False):
    scratch = ROOT / 'samples/.build'
    scratch.mkdir(exist_ok=True)
    checks = []
    with tempfile.TemporaryDirectory(prefix='transfer-e2e-', dir=scratch) as folder:
        folder = Path(folder)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        with (folder / 'server.log').open('w') as log:
            process = subprocess.Popen([str(ROOT / 'server/target/debug/securevault'), '--data-dir', str(folder / 'vault'), '--addr', f'127.0.0.1:{port}'], cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            try:
                client = Client(port)
                for _ in range(100):
                    try:
                        client.request('/vault/status')
                        break
                    except Exception:
                        if process.poll() is not None:
                            raise RuntimeError('isolated service exited')
                        time.sleep(.05)
                client.request('/vault/setup', {'password': PASSWORD})

                def raw(path, data=None, headers=None, expected=200, actor=client):
                    request = urllib.request.Request(actor.base + path, data=data, headers=headers or {})
                    try:
                        with actor.opener.open(request, timeout=30) as response:
                            status, body, result_headers = response.status, response.read(), response.headers
                    except urllib.error.HTTPError as error:
                        status, body, result_headers = error.code, error.read(), error.headers
                    assert status == expected, (path, status, expected, body[:500])
                    assert result_headers.get('Cache-Control') == 'no-store'
                    return body, result_headers

                def upload(body, filename, expected=200, **options):
                    boundary = 'TransferE2EBoundary'
                    multipart = f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + body + b'\r\n'
                    for key, value in options.items():
                        multipart += f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
                    multipart += f'--{boundary}--\r\n'.encode()
                    return json.loads(raw('/imports/upload', multipart, {'Content-Type': f'multipart/form-data; boundary={boundary}'}, expected)[0])

                fields = [{'source_key': key, 'display_name': key, 'zone': zone, 'position': i} for i, (key, zone) in enumerate([
                    ('code', 'indexes'), ('name', 'display'), ('count', 'display'), ('enabled', 'display'), ('long_id', 'normal'), ('memo', 'normal'), ('token', 'secrets')])]
                rows = [dict(code='001', name='服务 A', count=0, enabled=False, long_id=9007199254740993, memo='第一行\n第二行', token='TEST-SECRET-A'), dict(code='002', name='服务 B', count=2, enabled=True, long_id=9007199254740995, memo='other', token='TEST-SECRET-B')]

                def dataset(name, sample=None):
                    return client.request('/datasets', dict(name=name, category_path='交换回归/' + name, fields=fields, identity_fields=['code'], **({'sample_data': sample} if sample else {})))['dataset_id']

                def values(ds, secrets=True):
                    return sorted(json.loads(raw(f'/datasets/{ds}/export?format=json&include_secrets={str(secrets).lower()}')[0]), key=lambda row: row['code'])

                def commit(ds, batch, expected_rows):
                    request = dict(dataset_id=ds, batch_id=batch['batch_id'], mappings=[dict(source_key=key, target_key=key) for key in batch['source_fields']])
                    before = values(ds)
                    preview = client.request('/records/import/preview', request)
                    assert preview['valid'] and preview['imported'] == len(expected_rows), preview
                    assert values(ds) == before, 'preview wrote records'
                    result = client.request('/records/import', request)
                    assert result['imported'] == len(expected_rows), result
                    assert values(ds) == expected_rows, (values(ds), expected_rows)
                    skipped = client.request('/records/import', {**request, 'skip_existing': True})
                    assert skipped['skipped'] == len(expected_rows)
                    updated = client.request('/records/import', request)
                    assert updated['updated'] == len(expected_rows)
                    return request

                source = dataset('来源', rows)
                search = client.search(dataset_id=source)['records']
                expired_id = next(row['id'] for row in search if row['indexes']['code'] == '002')
                client.request(f'/records/{expired_id}/expired', {'expired': True})
                for fmt in ['json', 'jsonl', 'csv', 'xlsx', 'yaml', 'yml', 'toml']:
                    for secrets in [False, True]:
                        expected_rows = [dict(row) for row in rows]
                        if not secrets:
                            for row in expected_rows:
                                del row['token']
                        query = urllib.parse.urlencode(dict(format=fmt, include_secrets=str(secrets).lower(), include_expired='true'))
                        body, headers = raw(f'/datasets/{source}/export?{query}')
                        assert f'.{fmt}"' in headers['Content-Disposition']
                        batch = upload(body, f'RECORDS.{fmt.upper()}')
                        target = dataset(f'文件-{fmt}-{secrets}')
                        commit(target, batch, expected_rows)
                        checks.append(f'{fmt} file export/upload/preview/commit/update/skip; secrets={secrets}')
                        if fmt != 'xlsx':
                            for mode in [fmt, 'auto']:
                                parsed = client.request('/imports/text', dict(text=body.decode(), format=mode))
                                assert parsed['format'] in ([fmt] if mode != 'auto' else [fmt, 'yaml', 'json'])
                                target = dataset(f'文本-{fmt}-{mode}-{secrets}')
                                commit(target, parsed, expected_rows)
                                checks.append(f'{fmt} text {mode} parse/preview/commit/update/skip; secrets={secrets}')
                    active, _ = raw(f'/datasets/{source}/export?format={fmt}&include_expired=false')
                    assert upload(active, f'active.{fmt}')['record_count'] == 1

                nested_toml = '\n'.join(['[[private_key.keys]]', 'id="KEY-TEST"', '#invalid=true', 'issuer_id="issuer-test"', 'artistName="示例"', 'bundle_ids=["com.example.one", "com.example.two"]', 'private_key="""-----BEGIN PRIVATE KEY-----', 'TEST-ONLY', '-----END PRIVATE KEY-----', '"""'])
                key_fields = [dict(source_key=key, display_name=key, zone=zone, position=i) for i, (key, zone) in enumerate([('id', 'indexes'), ('bundle_ids', 'indexes'), ('artistName', 'display'), ('issuer_id', 'normal'), ('private_key', 'secrets')])]
                def keys_dataset(name):
                    return client.request('/datasets', dict(name=name, category_path='交换回归/' + name, fields=key_fields, identity_fields=['id']))['dataset_id']
                key_target = keys_dataset('数组索引')
                for mode in ['auto', 'toml']:
                    batch = client.request('/imports/text', dict(text=nested_toml, format=mode, node_path='private_key.keys'))
                    request = dict(dataset_id=key_target, batch_id=batch['batch_id'])
                    assert batch['record_count'] == 1 and 'bundle_ids' in batch['source_fields']
                    assert client.request('/records/import/preview', request)['valid']
                    client.request('/records/import', request)
                result = json.loads(raw(f'/datasets/{key_target}/export?format=json&include_secrets=true')[0])
                assert result[0]['bundle_ids'] == ['com.example.one', 'com.example.two']
                assert result[0]['private_key'] == '-----BEGIN PRIVATE KEY-----\nTEST-ONLY\n-----END PRIVATE KEY-----\n'
                assert 'invalid' not in result[0]
                assert 'private_key' not in json.loads(raw(f'/datasets/{key_target}/export?format=json')[0])[0]
                for query in ['bundle_ids:=com.example.one', 'bundle_ids:^com.example', 'bundle_ids:$two', r'bundle_ids:~^com\.example\.two$', 'bundle_ids:=com.example.one bundle_ids:=com.example.two']:
                    hits = client.search(query, dataset_id=key_target)
                    assert hits['total'] == 1, (query, hits)
                    assert hits['records'][0]['match_info']['bundle_ids']['ranges']
                for query in ['bundle_ids:=com.example', 'bundle_ids:=missing']:
                    assert client.search(query, dataset_id=key_target)['total'] == 0
                for fmt in ['yaml', 'toml']:
                    body = raw(f'/datasets/{key_target}/export?format={fmt}&include_secrets=true')[0]
                    if fmt == 'yaml':
                        body = ('private_key:\n  keys:\n' + ''.join('    ' + line + '\n' for line in body.decode().splitlines())).encode()
                        batch = upload(body, 'nested.yaml', node_path='/private_key/keys')
                    else:
                        batch = upload(nested_toml.encode(), 'nested.toml', node_path='private_key.keys')
                    target = keys_dataset('节点文件-' + fmt)
                    request = dict(dataset_id=target, batch_id=batch['batch_id'])
                    assert client.request('/records/import/preview', request)['valid']
                    client.request('/records/import', request)
                    assert json.loads(raw(f'/datasets/{target}/export?format=json&include_secrets=true')[0]) == result
                for path in ['missing', 'private_key.keys.0.id', 'private_key..keys']:
                    upload(nested_toml.encode(), 'nested.toml', 400, node_path=path)
                    client.request('/imports/text', dict(text=nested_toml, format='toml', node_path=path), expected=400)
                checks.append('nested TOML/YAML file and text selection; array indexes/search/highlights and multiline secrets roundtrip')

                # Real workbook: an empty first sheet and records in the second.
                xlsx = raw(f'/datasets/{source}/export?format=xlsx&include_secrets=true')[0]
                with zipfile.ZipFile(io.BytesIO(xlsx)) as archive:
                    parts = {name: archive.read(name) for name in archive.namelist()}
                ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
                rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
                ET.register_namespace('', ns)
                ET.register_namespace('r', rel)
                wb = ET.fromstring(parts['xl/workbook.xml']); sheets = wb.find('{' + ns + '}sheets')
                sheets[0].set('name', '说明')
                ET.SubElement(sheets, '{' + ns + '}sheet', {'name': '数据 & 二', 'sheetId': '2', '{' + rel + '}id': 'rIdReview'})
                parts['xl/workbook.xml'] = ET.tostring(wb, encoding='utf-8', xml_declaration=True)
                relationships = ET.fromstring(parts['xl/_rels/workbook.xml.rels'])
                ET.SubElement(relationships, '{http://schemas.openxmlformats.org/package/2006/relationships}Relationship', {'Id': 'rIdReview', 'Type': rel + '/worksheet', 'Target': 'worksheets/sheet2.xml'})
                ET.register_namespace('', 'http://schemas.openxmlformats.org/package/2006/relationships')
                parts['xl/_rels/workbook.xml.rels'] = ET.tostring(relationships, encoding='utf-8', xml_declaration=True)
                parts['xl/worksheets/sheet2.xml'] = parts['xl/worksheets/sheet1.xml']
                parts['xl/worksheets/sheet1.xml'] = f'<worksheet xmlns="{ns}"><sheetData/></worksheet>'.encode()
                types = ET.fromstring(parts['[Content_Types].xml'])
                ET.SubElement(types, '{http://schemas.openxmlformats.org/package/2006/content-types}Override', {'PartName': '/xl/worksheets/sheet2.xml', 'ContentType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'})
                ET.register_namespace('', 'http://schemas.openxmlformats.org/package/2006/content-types')
                parts['[Content_Types].xml'] = ET.tostring(types, encoding='utf-8', xml_declaration=True)
                output = io.BytesIO()
                with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
                    for name, body in parts.items(): archive.writestr(name, body)
                multi_xlsx = output.getvalue()
                choice = upload(multi_xlsx, 'multi.xlsx')
                assert choice['selection_required'] and choice['sheets'] == ['说明', '数据 & 二'] and 'batch_id' not in choice
                for sheet in ['说明', '不存在']: upload(multi_xlsx, 'multi.xlsx', 400, sheet=sheet)
                batch = upload(multi_xlsx, 'multi.xlsx', sheet='数据 & 二')
                assert batch['sheet'] == '数据 & 二'
                commit(dataset('多工作表'), batch, rows)
                checks.append('multi-sheet XLSX discovery/selection, empty/missing sheet rejection, preview/commit/roundtrip')

                # Malformed files must never create a usable batch or partially write rows.
                for filename, body in [('bad.csv', b'code,code\n1,2'), ('bad.csv', b'code,name\n1,A,extra'), ('bad.jsonl', b'{"code":1}\nnot-json'), ('bad.yaml', b'code: 1\ncode: 2'), ('bad.toml', b'code=nan'), ('empty.json', b'[]'), ('empty.toml', b'records=[]'), ('empty.csv', b'code,name\n')]:
                    assert 'error' in upload(body, filename, 400)
                for text, fmt in [('a: b,c\nx: y,z', 'auto'), ('code\n001', 'auto'), ('{bad', 'json'), ('- code: 1', 'toml'), ('x' * (1024 * 1024 + 1), 'yaml')]:
                    client.request('/imports/text', dict(text=text, format=fmt), expected=400)
                assert client.request('/imports/text', dict(text='code\n001', format='csv'))['record_count'] == 1
                raw('/imports/text', b'{"text":' + b' ' * (8 * 1024 * 1024) + b'"x"}', {'Content-Type': 'application/json'}, 413)
                checks.append('malformed/empty/ambiguous/oversize inputs reject with no write')

                invalid_target = dataset('无效记录')
                invalid = client.request('/imports/text', {'text': '- name: invalid', 'format': 'yaml'})
                request = dict(dataset_id=invalid_target, batch_id=invalid['batch_id'], delete_missing=True)
                assert not client.request('/records/import/preview', request)['valid']
                client.request('/records/import', request, expected=400)
                assert values(invalid_target) == []
                checks.append('invalid identity preflight and atomic commit rejection')

                # Native package text stays raw until the native API parses it.
                for content in ['schema', 'package']:
                    body, _ = raw(f'/datasets/{source}/export?content={content}&format=json&include_secrets=true')
                    request = dict(package=body.decode(), category_path=f'交换回归/原生-{content}')
                    prediction = client.request('/datasets/transfer/preview', request)
                    result = client.request('/datasets/transfer/import', {**request, 'confirmation_token': prediction['confirmation_token'], 'confirm_changes': True})
                    assert values(result['dataset_id']) == ([] if content == 'schema' else rows)
                    assert '9007199254740993' in body.decode() or content == 'schema'
                checks.append('native schema/package preview and raw-text roundtrip')

                null_target = dataset('空值', [{**rows[0], 'memo': None}])
                raw(f'/datasets/{null_target}/export?format=toml', expected=400)
                big_target = dataset('超范围整数', [{**rows[0], 'long_id': 18446744073709551615}])
                raw(f'/datasets/{big_target}/export?format=toml', expected=400)
                checks.append('TOML null and out-of-range integers reject without data loss')

                anonymous = Client(port)
                anonymous.request('/imports/text', {'text': '- code: 1'}, expected=401)
                app = client.request('/apps', {'name': '导出权限回归', 'permission': 'search', 'datasets': [source]})
                credentials = {'X-App-Id': app['id'], 'X-App-Key': app['key']}
                for fmt in ['jsonl', 'yaml', 'yml', 'toml']:
                    raw(f'/datasets/{source}/export?format={fmt}', headers=credentials, actor=anonymous)
                    raw(f'/datasets/{source}/export?format={fmt}&include_secrets=true', headers=credentials, expected=403, actor=anonymous)
                    raw(f'/datasets/{invalid_target}/export?format={fmt}', headers=credentials, expected=403, actor=anonymous)
                anonymous.request('/imports/text', {'text': '- code: 1'}, headers=credentials, expected=403)
                client.request('/imports/text', {'text': '- code: 1'}, headers={'Origin': 'https://invalid.example.test'}, expected=403)
                saved_batch = client.request('/imports/text', {'text': '- code: "later"'})
                client.request('/vault/seal', {})
                client.request('/imports/text', {'text': '- code: 1'}, expected=423)
                client.request('/vault/unlock', {'password': PASSWORD})
                client.request('/records/import/preview', dict(dataset_id=source, batch_id=saved_batch['batch_id']), expected=404)
                checks.append('anonymous/app/CSRF/scope/seal/session batch boundaries')
                info = dict(passed=True, checks=checks, count=len(checks))
                (scratch / 'transfer-e2e-report.json').write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n')
                print(json.dumps(info, ensure_ascii=False), flush=True)
                if serve:
                    browser_target = dataset('浏览器验证')
                    fixture = folder / 'browser-records.yaml'
                    (folder / 'nested-keys.toml').write_text(nested_toml)
                    (folder / 'multi.xlsx').write_bytes(multi_xlsx)
                    fixture.write_text('- code: "UI-FILE"\n  name: "文件录入"\n  enabled: false\n')
                    print(json.dumps(dict(url=f'http://127.0.0.1:{port}', password=PASSWORD, dataset=browser_target, upload=str(fixture)), ensure_ascii=False), flush=True)
                    while True:
                        time.sleep(1)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--serve', action='store_true')
    args = parser.parse_args()
    try:
        run(args.serve)
    except KeyboardInterrupt:
        pass
