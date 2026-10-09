#!/usr/bin/env python3
"""Initialize or serve an isolated demo vault using the public HTTP API."""
import http.cookiejar
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SAMPLE = ROOT / 'samples'
RAW = SAMPLE / 'raw'
RUNTIME = SAMPLE / '.runtime'


def private_json(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


class Client:
    def __init__(self, port):
        self.base = f'http://127.0.0.1:{port}/api'
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, path, data=None, method=None, headers=None, expected=200):
        request = urllib.request.Request(self.base + path,
            data=None if data is None else json.dumps(data, ensure_ascii=False).encode(),
            headers={'Content-Type': 'application/json', **(headers or {})},
            method=method or ('POST' if data is not None else 'GET'))
        try:
            with self.opener.open(request, timeout=30) as response:
                status, body = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, body = error.code, error.read()
        if status != expected:
            raise RuntimeError(f'{request.method} {path}: expected {expected}, got {status}: {body.decode()}')
        return json.loads(body)

    def search(self, query='', **kwargs):
        return self.request('/records/search?' + urllib.parse.urlencode({'q': query, **kwargs}))

    def upload(self, filename):
        boundary = 'SecureVaultSample' + secrets.token_hex(12)
        content = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                   'Content-Type: application/octet-stream\r\n\r\n').encode()
        content += (RAW / filename).read_bytes() + f'\r\n--{boundary}--\r\n'.encode()
        request = urllib.request.Request(self.base+'/imports/upload', data=content,
            headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
        with self.opener.open(request, timeout=30) as response:
            return json.load(response)

    def import_file(self, dataset_id, filename, **options):
        batch = self.upload(filename)
        return self.request('/records/import', dict(dataset_id=dataset_id, batch_id=batch['batch_id'], **options))


def initialize(client, password):
    checks, imports, datasets, record_ids = [], [], {}, {}
    client.request('/vault/setup', {'password': password})
    for definition in json.loads((RAW/'datasets.json').read_text(encoding='utf-8')):
        definition = dict(definition)
        key, filename, mappings = (definition.pop(name) for name in ('key', 'file', 'mappings'))
        dataset = client.request('/datasets', definition)
        dataset_id = datasets[key] = dataset['dataset_id']
        result = client.import_file(dataset_id, filename, mappings=mappings, template_name=f'演示导入模板-{key}')
        record_ids[key] = result['record_ids']
        imports.append(dict(dataset=key, source=filename, result=result))

    update = client.import_file(datasets['games_prod'], 'games_update.json', template_name='游戏唯一KEY更新')
    assert update['updated'] == 1 and update['imported'] == 0
    skipped = client.import_file(datasets['games_prod'], 'games_skip_existing.json', skip_existing=True)
    assert skipped['skipped'] == 1 and skipped['updated'] == 0
    checks += ['JSON/CSV/XLSX 上传与导入', '中文源字段映射', 'JSON 字符串路径抽取', '复合 KEY 更新与跳过重复']
    sync = client.import_file(datasets['inventory'], 'inventory_sync.json', delete_missing=True,
        evolved_fields=[dict(source_key='region', display_name='区域', zone='indexes', position=4)],
        evolved_identity_fields=['config_id'], template_name='配置全量同步')
    assert sync['updated'] == 2 and sync['deleted_missing'] == 1
    client.request('/datasets/'+datasets['inventory'], {'list_fields': [
        dict(source_key=key,display_name=label,position=i,format='single_line',visible=True)
        for i,(key,label) in enumerate([('alias','配置名称'),('config_id','配置编号'),('enabled','启用'),('region','区域'),('description','用途')])]}, method='PATCH')
    checks += ['全量同步删除缺失项（仅演示配置）', 'Schema 新增字段与列表配置']

    for key,index in [('games_prod',47),('games_test',7),('payments',11),('cloud',7)]:
        client.request('/records/'+record_ids[key][index]+'/expired', {'expired': True})
    assert client.search(include_expired='true')['total'] == 98
    assert client.search()['total'] == 94
    assert client.search(category='游戏业务',include_expired='true')['total'] == 64
    assert client.search(category='游戏业务',environment='正式',include_expired='true')['total'] == 48
    assert client.search('category:=游戏业务 gid:=2001 platform:=Android')['total'] == 3
    assert client.search('product_id:^GAME-2001')['total'] == 12
    assert client.search('product_id:$HARMONY')['total'] == 14
    assert client.search('merchant_id:~^MCH-300[1-3]$')['total'] == 3
    assert client.search('version:=3.3.1')['total'] == 1
    assert client.search('version:=0.0.0-不应覆盖')['total'] == 0
    page1 = client.search(limit=40, page=1)
    page2 = client.search(limit=40, page=2)
    assert len(page1['records']) == len(page2['records']) == 40
    assert not ({r['id'] for r in page1['records']} & {r['id'] for r in page2['records']})
    checks += ['AND/精确/前缀/后缀/正则搜索', '目录后代与环境筛选', '过期记录默认隐藏', '分页不重叠']

    sample_record = record_ids['games_prod'][0]
    detail = client.request('/records/'+sample_record)
    assert 'private_config' not in detail['indexes'] and 'private_config' not in detail['display']
    assert any(field['zone']=='hidden' for field in detail['protected_fields'])
    revealed = client.request('/records/'+sample_record+'/secrets/reveal', {'field_name':'app_secret'})
    assert revealed['expires_in_seconds'] == 30 and revealed['value'].startswith('DEMO_ONLY_')
    assert 'DEMO_ONLY_' not in json.dumps(client.search(include_expired='true',limit=100),ensure_ascii=False)
    client.request('/records/'+sample_record+'/secrets/reveal', {'field_name':'private_config'}, expected=404)
    checks += ['敏感字段掩码、按需解密与30秒有效期', '隐藏字段不参与公开展示或解密入口']

    apps = []
    for name,permission,scope,ttl,disabled in [
        ('演示只读检索机器人','search',['games_prod','knowledge'],None,False),
        ('演示支付验签服务','secrets',['payments'],None,False),
        ('演示已停用应用','search',['cloud'],None,True),
        ('演示授权已过期应用','search',['hooks'],1,False)]:
        payload=dict(name=name,permission=permission,datasets=[datasets[key] for key in scope])
        if ttl: payload['access_ttl_seconds']=ttl
        app=client.request('/apps',payload)
        if disabled:
            client.request('/apps/'+app['id'],{'disabled':True},method='PATCH')
            app['disabled']=True
        apps.append(app)
    headers=lambda app:{'X-App-Id':app['id'],'X-App-Key':app['key']}
    allowed=client.request('/records/search?include_expired=true&limit=100',headers=headers(apps[0]))
    assert allowed['total']==54
    assert {r['dataset_id'] for r in allowed['records']} <= set(apps[0]['datasets'])
    client.request('/records/'+sample_record+'/secrets/reveal',{'field_name':'app_secret'},headers=headers(apps[0]),expected=403)
    client.request('/records/'+record_ids['cloud'][0],headers=headers(apps[0]),expected=403)
    pay_secret=client.request('/records/'+record_ids['payments'][0]+'/secrets/reveal',{'field_name':'api_key'},headers=headers(apps[1]))
    assert pay_secret['value'].startswith('DEMO_ONLY_PAY_')
    client.request('/records/search',headers=headers(apps[2]),expected=403)
    time.sleep(1.1)
    client.request('/records/search',headers=headers(apps[3]),expected=403)
    checks += ['应用数据集授权范围', '只读权限禁止解密', '敏感权限允许指定数据集解密', '停用与过期应用拒绝访问']

    for key in ('games_prod','payments','cloud'):
        for format_name in ('json','csv'):
            url=client.base+'/datasets/'+datasets[key]+'/export?format='+format_name
            with client.opener.open(url,timeout=30) as response:
                body=response.read()
                assert body and b'DEMO_ONLY_' not in body
    client.request('/vault/seal',{})
    client.request('/records/search',expected=423)
    client.request('/vault/unlock',{'password':'incorrect-demo-password'},expected=401)
    time.sleep(2.1)
    client.request('/vault/unlock',{'password':password})
    assert not client.request('/vault/status')['persistent']
    checks += ['公开JSON/CSV导出不泄露密钥', '封印拒绝读取与正确密码解锁']
    summary=client.request('/vault/summary')
    assert summary['datasets']==8 and summary['records']==98
    return dict(datasets=datasets,apps=apps,record_ids=record_ids), dict(summary=summary,checks=checks,
        imports=imports,update=update,skip_existing=skipped,full_sync=sync,expired_records=4,active_records=94)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=4180)
    parser.add_argument('--binary',type=Path,default=ROOT/'server/target/release/securevault')
    parser.add_argument('--serve',action='store_true',help='Restart the existing demo, sealed until unlocked')
    args=parser.parse_args()
    if not args.binary.is_file(): parser.error('Build first: cargo build --locked --release --manifest-path server/Cargo.toml')
    if not args.serve and RUNTIME.exists(): parser.error('Demo runtime already exists; use --serve or move samples/.runtime aside to create a new demo.')
    if args.serve and not (RUNTIME/'data/vault.meta.json').exists(): parser.error('Initialize the demo first.')
    # Refuse occupied ports before starting so an unrelated vault cannot be modified.
    try:
        with socket.socket() as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(('127.0.0.1',args.port))
    except OSError:
        parser.error(f'Port {args.port} is occupied; stop the existing demo or choose another --port.')
    RUNTIME.mkdir(mode=0o700,parents=True,exist_ok=True)
    if not args.serve: (RUNTIME/'data').mkdir(mode=0o700)
    client=Client(args.port)
    environment=os.environ.copy()
    for name in ('SECUREVAULT_PASSWORD','SECUREVAULT_DATA_DIR','SECUREVAULT_ADDR'):
        environment.pop(name,None)
    with (RUNTIME/'server.log').open('ab') as log:
        process=subprocess.Popen([str(args.binary.resolve()),'--data-dir',str(RUNTIME/'data'),'--addr',f'127.0.0.1:{args.port}'],
            cwd=ROOT,env=environment,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    (RUNTIME/'server.pid').write_text(str(process.pid)+'\n')
    try:
        for attempt in range(100):
            if process.poll() is not None: raise RuntimeError('Demo server exited; inspect samples/.runtime/server.log')
            try:
                status=client.request('/vault/status')
                break
            except urllib.error.URLError:
                time.sleep(.05)
        else: raise RuntimeError('Demo server did not start')
        if not args.serve:
            assert not status['initialized'] and status['sealed']
            password=secrets.token_urlsafe(24)
            private_json(RUNTIME/'credentials.json',dict(url=f'http://127.0.0.1:{args.port}',password=password))
            manifest,report=initialize(client,password)
            private_json(RUNTIME/'manifest.json',manifest)
            private_json(RUNTIME/'validation.json',report)
            print(f"Initialized: {report['summary']['datasets']} datasets, {report['summary']['records']} records, {len(report['checks'])} verified feature checks.")
        print(f'Demo running: http://127.0.0.1:{args.port}/ (PID {process.pid})')
        print('Password: samples/.runtime/credentials.json; API app keys: samples/.runtime/manifest.json')
    except BaseException:
        process.terminate()
        process.wait(timeout=10)
        raise


if __name__ == '__main__':
    main()
