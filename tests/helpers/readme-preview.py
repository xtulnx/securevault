"""Disposable README screenshot service with actual APIs and fictional sample data."""
import argparse
import copy
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'samples/scripts'))
from demo import Client, initialize

# Public, disposable fixture password. Never reuse for an actual vault.
PASSWORD = 'README-demo-only-2026!'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=4189)
    args = parser.parse_args()
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', args.port))  # Refuse to touch an already running service.
    scratch = ROOT / 'samples/.build'
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='readme-preview-', dir=scratch) as directory:
        folder = Path(directory)
        environment = os.environ.copy()
        for key in ('SECUREVAULT_PASSWORD', 'SECUREVAULT_DATA_DIR', 'SECUREVAULT_ADDR', 'SECUREVAULT_PUBLIC_ORIGIN'):
            environment.pop(key, None)
        with (folder / 'server.log').open('w') as log:
            process = subprocess.Popen([str(ROOT / 'server/target/debug/securevault'), '--data-dir', str(folder / 'vault'), '--addr', f'127.0.0.1:{args.port}'], cwd=ROOT, env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            try:
                client = Client(args.port)
                for _ in range(100):
                    if process.poll() is not None:
                        raise RuntimeError('Disposable screenshot service exited')
                    try:
                        client.request('/vault/status')
                        break
                    except OSError:
                        time.sleep(.05)
                else:
                    raise RuntimeError('Disposable screenshot service did not start')
                manifest, report = initialize(client, PASSWORD)
                names = dict(games_prod='游戏产品 · 正式', games_test='游戏产品 · 测试', games_staging='游戏产品 · 预发布', payments='支付商户', cloud='云服务账户', hooks='Webhook 接入', knowledge='运行手册', inventory='平台同步配置')
                for key, dataset in manifest['datasets'].items():
                    description = '正式环境的产品接入信息；敏感凭据按需查看，导入以游戏 ID 与平台组合更新。' if key == 'games_prod' else '用于演示字段检索、授权范围与数据维护的虚构数据。'
                    client.request('/datasets/' + dataset, {'name': names[key], 'description': description}, method='PATCH')
                game_id = manifest['datasets']['games_prod']
                game = next(dataset for dataset in client.request('/datasets')['datasets'] if dataset['id'] == game_id)
                model = next(model for model in client.request('/catalog')['schemas'] if model['id'] == game['schema_id'])
                definition = copy.deepcopy(model['definition'])
                definition['supplement_fields'] = [dict(source_key='contact', display_name='对接人', zone='normal', position=0), dict(source_key='release_note', display_name='接入备注', zone='normal', position=1)]
                proposal = {'schema_id': model['id'], 'name': 'SDK 产品模型', 'description': '用于游戏产品接入与 SDK 配置管理。\n\n```sql\nSELECT gid, platform, product_id, version FROM demo_products WHERE enabled = 1;\n```', 'definition': definition}
                preview = client.request('/schemas/preview', proposal)
                client.request('/schemas/publish', {**proposal, 'confirmation_token': preview['confirmation_token']})
                record = manifest['record_ids']['games_prod'][0]
                client.request(f'/datasets/{game_id}/supplement/records', {'main_record_id': record, 'values': {'contact': '示例接入组', 'release_note': 'SDK 3.3.1 已验收；下次导入保留附表维护信息。'}})
                client.request('/saved-queries', {'name': '同一产品跨环境核对', 'filters': {'q': 'category:=游戏业务 gid:=2001 platform:=Android', 'categories': [], 'labels': [], 'schema_id': None, 'dataset_id': None, 'include_expired': False}})
                client.request('/saved-queries', {'name': '正式环境 SDK 版本检查', 'filters': {'q': 'version:=3.3.1', 'categories': ['游戏业务'], 'labels': ['正式'], 'schema_id': None, 'dataset_id': game_id, 'include_expired': False}})
                # Trigger actual authorization events using only this fixture's app keys.
                reader, _, disabled, expired = manifest['apps']
                credentials = lambda app: {'X-App-Id': app['id'], 'X-App-Key': app['key']}
                def authorization_events(*_):
                    client.request('/records/' + record + '/secrets/reveal', {'field_name': 'app_secret'}, headers=credentials(reader), expected=403)
                    client.request('/records/' + manifest['record_ids']['cloud'][0], headers=credentials(reader), expected=403)
                    for app in (disabled, expired):
                        client.request('/records/search', headers=credentials(app), expected=403)
                signal.signal(signal.SIGUSR1, authorization_events)
                # Authenticate in the browser separately; no cookies or real vault data are copied.
                metadata = {'pid': os.getpid(), 'url': f'http://127.0.0.1:{args.port}/', 'datasets': manifest['datasets'], 'record': record, 'checks': len(report['checks']), 'summary': report['summary'], 'raw_upload': str(ROOT / 'samples/raw/webhooks.json')}
                (scratch / 'readme-preview.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
                print(json.dumps({'url': metadata['url'], 'summary': report['summary'], 'checks': len(report['checks']), 'metadata': 'samples/.build/readme-preview.json'}, ensure_ascii=False), flush=True)
                signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
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
    try:
        main()
    except KeyboardInterrupt:
        pass
