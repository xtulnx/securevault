#!/usr/bin/env python3
"""Verify extension metadata, multi-label filters and httpyac reads on a disposable vault."""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from demo import Client


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', default='server/target/debug/securevault')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    scratch = root / 'samples/.build'
    scratch.mkdir(parents=True, exist_ok=True)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    environment = os.environ.copy()
    for name in ('SECUREVAULT_PASSWORD', 'SECUREVAULT_DATA_DIR', 'SECUREVAULT_ADDR', 'SECUREVAULT_PUBLIC_ORIGIN'):
        environment.pop(name, None)
    with tempfile.TemporaryDirectory(prefix='raycast-', dir=scratch) as directory:
        process = subprocess.Popen([str((root / args.binary).resolve()), '-d', directory, '-p', str(port)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environment)
        try:
            owner, app_client = Client(port), Client(port)
            for _ in range(100):
                try:
                    app_client.request('/vault/status')
                    break
                except OSError:
                    time.sleep(.1)
            else:
                raise RuntimeError('server failed to start')
            with app_client.opener.open(f'http://127.0.0.1:{port}/workbench.js') as response:
                assert b'async function openLinkedRecord()' in response.read()
            password = secrets.token_urlsafe(32)
            owner.request('/vault/setup', {'password': password})
            schema = dict(name='商户凭据', category_path='业务/支付', environment_names=['客户A', '生产', '一区,二区 / 主站;备站'], description='查询用途说明',
                          fields=[dict(source_key=key, display_name=label, zone=zone, position=index)
                                  for index, (key, label, zone) in enumerate([
                                      ('code', '编号', 'indexes'), ('enabled', '启用', 'display'),
                                      ('notes', '说明', 'normal'), ('secret', '密钥', 'secrets'),
                                      ('hidden', '隐藏', 'hidden'), ('ignored', '忽略', 'ignore')])],
                          identity_fields=['code'], display_config={'identifier_fields': ['code', 'enabled']},
                          list_fields=[dict(source_key='enabled', display_name='启用', position=0, visible=True),
                                       dict(source_key='hidden', position=1, visible=False)],
                          sample_data=[dict(code=0, enabled=False, notes='普通说明', secret='MAIN_SECRET',
                                            hidden='HIDDEN_VALUE', ignored='IGNORED_VALUE')])
            allowed = owner.request('/datasets', schema)['dataset_id']
            model_id = next(item for item in owner.request('/datasets')['datasets'] if item['id'] == allowed)['schema_id']
            model_request = {'schema_id': model_id, 'description': 'DEMO_ONLY_OWNER_MODEL_NOTES'}
            model_preview = owner.request('/schemas/preview', model_request)
            owner.request('/schemas/publish', {**model_request, 'confirmation_token': model_preview['confirmation_token']})
            record = owner.search(dataset_id=allowed)['records'][0]['id']
            owner.request('/datasets/' + allowed + '/supplement', {
                'fields': [dict(source_key='alias', display_name='别名', zone='indexes', position=0),
                           dict(source_key='memo', display_name='备注', zone='normal', position=1),
                           dict(source_key='secret', display_name='附表密钥', zone='secrets', position=2)]}, method='PATCH')
            denied = owner.request('/datasets', {'name': '商户凭据', 'category_path': '业务/支付',
                'schema_id': model_id, 'environment_names': ['客户B', '生产'], 'sample_data': schema['sample_data']})['dataset_id']
            denied_record = owner.search(dataset_id=denied)['records'][0]['id']
            supplement = owner.request('/datasets/' + allowed + '/supplement/records', {
                'main_record_id': record, 'values': {'alias': '华东渠道', 'memo': '手工备注', 'secret': 'ADDON_SECRET'}})['id']
            app = owner.request('/apps', {'name': 'Raycast 测试', 'permission': 'search', 'datasets': [allowed]})
            headers = {'X-App-Id': app['id'], 'X-App-Key': app['key']}
            app_client.request('/client/datasets', expected=401)
            app_client.request('/client/datasets', headers={'X-Vault-Owner': '1'}, expected=401)
            app_client.request('/client/datasets', headers={**headers, 'X-App-Key': 'invalid'}, expected=401)
            metadata = app_client.request('/client/datasets', headers=headers)['datasets']
            assert [dataset['id'] for dataset in metadata] == [allowed]
            public = metadata[0]
            assert [field['source_key'] for field in public['fields']] == ['code', 'enabled', 'notes']
            assert [field['source_key'] for field in public['supplement_fields']] == ['alias', 'memo']
            assert [field['source_key'] for field in public['list_fields']] == ['enabled']
            assert public['display_config']['identifier_fields'] == ['code', 'enabled']
            assert public['description'] == '查询用途说明'
            assert public['name'] == '商户凭据'
            assert public['environments'] == ['客户A', '生产', '一区,二区 / 主站;备站']
            assert public['schema_id'] == model_id and public['schema_name']
            assert public['schema_version'] == 3  # Description publish plus supplement definition update.
            assert 'schema_description' not in public and 'DEMO_ONLY_OWNER_MODEL_NOTES' not in json.dumps(public)
            for tags, total in [(['客户A'], 1), (['客户A', '生产'], 1), (['客户A', '测试'], 0), (['客户B', '生产'], 0), (['客户A', '一区,二区 / 主站;备站'], 1), (['一区', '二区'], 0)]:
                query = urllib.parse.urlencode({'environment_tags': json.dumps(tags), 'schema_id': model_id})
                assert app_client.request('/records/search?' + query, headers=headers)['total'] == total
            app_client.request('/catalog', headers=headers, expected=403)
            # Execute the actual httpyac module against this same scoped application.
            extension_env = environment.copy()
            extension_env.update(SECUREVAULT_URL=f'http://127.0.0.1:{port}', SECUREVAULT_APP_ID=app['id'],
                SECUREVAULT_APP_KEY=app['key'], SECUREVAULT_MODULE=(root / 'extensions/httpyac/securevault.mjs').as_uri(),
                SECUREVAULT_MODEL=model_id, SECUREVAULT_DENIED_RECORD=denied_record)
            subprocess.run(['node', '--input-type=module'], input='''
import assert from 'node:assert/strict';
const { loadFields } = await import(process.env.SECUREVAULT_MODULE);
const fields = { code: 'code', enabled: 'enabled', memo: 'supplement.memo' };
const result = await loadFields({ datasetName: '商户凭据', schemaId: process.env.SECUREVAULT_MODEL,
  tags: ['客户A', '生产', '一区,二区 / 主站;备站'], query: 'code:=0', fields });
assert.deepEqual({ ...result }, { code: 0, enabled: false, memo: '手工备注' });
await assert.rejects(loadFields({ datasetName: '商户凭据', tags: ['客户B', '生产'], fields }), /授权范围内未找到/);
await assert.rejects(loadFields({ tags: ['客户A', '测试'], fields }), /未找到/);
await assert.rejects(loadFields({ datasetName: '商户凭据', environment: '生产', fields: ['secrets.secret'] }), /HTTP 403/);
await assert.rejects(loadFields({ recordId: process.env.SECUREVAULT_DENIED_RECORD, fields }), /HTTP 403/);
''', text=True, env=extension_env, check=True, cwd=root)
            assert not any(key in public for key in ['conflict_strategy', 'record_count'])
            request = urllib.request.Request(app_client.base + '/client/datasets', headers=headers)
            with app_client.opener.open(request) as response:
                assert response.headers['Cache-Control'] == 'no-store'
            result = app_client.request('/records/search?' + urllib.parse.urlencode({'q': 'code:=0 附表.alias:=华东渠道'}), headers=headers)
            assert result['total'] == 1
            assert result['records'][0]['id'] == record
            assert 'supplement.alias' in result['records'][0]['matched_fields']
            detail = app_client.request('/records/' + record, headers=headers)
            assert detail['indexes']['code'] == 0 and detail['display']['enabled'] is False
            assert detail['normal']['notes'] == '普通说明'
            assert detail['supplement_records'][0]['values']['memo'] == '手工备注'
            for marker in ['MAIN_SECRET', 'ADDON_SECRET', 'HIDDEN_VALUE', 'IGNORED_VALUE']:
                assert marker not in json.dumps([public, result, detail])
            app_client.request('/records/' + denied_record, headers=headers, expected=403)
            for path in ['/datasets', '/datasets/tree', '/apps', '/vault/summary']:
                app_client.request(path, headers=headers, expected=403)
            app_client.request('/client/datasets', {}, headers=headers, expected=403)
            app_client.request('/records/' + record + '/secrets/reveal', {'field_name': 'secret'}, headers=headers, expected=403)
            app_client.request('/supplement/' + supplement + '/secrets/reveal', {'field_name': 'secret'}, headers=headers, expected=403)
            assert len(owner.request('/datasets')['datasets']) == 2
            assert len(owner.request('/client/datasets', headers=headers)['datasets']) == 1
            definition = next(model for model in owner.request('/catalog')['schemas'] if model['id'] == model_id)['definition']
            definition['identity_fields'] = ['code', 'secret']
            update_model = {'schema_id': model_id, 'definition': definition}
            preview_model = owner.request('/schemas/preview', update_model)
            owner.request('/schemas/publish', {**update_model, 'confirmation_token': preview_model['confirmation_token']})
            assert app_client.request('/client/datasets', headers=headers)['datasets'][0]['identity_fields'] == []
            owner.request('/apps/' + app['id'], {'datasets': []}, method='PATCH')
            assert app_client.request('/client/datasets', headers=headers)['datasets'] == []
            assert app_client.request('/records/search', headers=headers)['total'] == 0
            owner.request('/apps/' + app['id'], {'datasets': [allowed], 'disabled': True}, method='PATCH')
            app_client.request('/client/datasets', headers=headers, expected=403)
            owner.request('/apps/' + app['id'], {'disabled': False, 'access_ttl_seconds': 1}, method='PATCH')
            time.sleep(1.1)
            app_client.request('/client/datasets', headers=headers, expected=403)
            owner.request('/apps/' + app['id'], {'access_ttl_seconds': 0}, method='PATCH')
            rotated = owner.request('/apps/' + app['id'] + '/rotate', {})
            app_client.request('/client/datasets', headers=headers, expected=401)
            headers['X-App-Key'] = rotated['key']
            assert len(app_client.request('/client/datasets', headers=headers)['datasets']) == 1
            owner.request('/vault/seal', {})
            app_client.request('/client/datasets', headers=headers, expected=423)
            owner.request('/vault/unlock', {'password': password})
            assert len(app_client.request('/client/datasets', headers=headers)['datasets']) == 1
            print('通过：名称、共享模型和多标签、httpyac 实际取值、授权实例隔离、主附表联合搜索、敏感值隔离、撤销/停用/过期/轮换、封印与解锁。')
        finally:
            process.terminate()
            process.wait(timeout=10)


if __name__ == '__main__':
    main()
