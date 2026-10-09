#!/usr/bin/env python3
"""Read-only permission checks and a demo-secret reveal; no real credentials involved."""
import argparse
import json
from demo import Client, RUNTIME


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=4180)
    args=parser.parse_args()
    client=Client(args.port)
    manifest=json.loads((RUNTIME/'manifest.json').read_text(encoding='utf-8'))
    read_only,signer,disabled,expired=manifest['apps']
    def headers(app):
        return {'X-App-Id':app['id'],'X-App-Key':app['key']}
    result=client.request('/records/search?include_expired=true&limit=100',headers=headers(read_only))
    print(f"只读应用：可见 {result['total']} 条记录，仅限正式游戏和运行手册。")
    game=manifest['record_ids']['games_prod'][0]
    client.request('/records/'+game+'/secrets/reveal',{'field_name':'app_secret'},headers=headers(read_only),expected=403)
    print('只读应用解密：403，符合预期。')
    cloud=manifest['record_ids']['cloud'][0]
    client.request('/records/'+cloud,headers=headers(read_only),expected=403)
    print('跨数据集访问：403，符合预期。')
    payment=manifest['record_ids']['payments'][0]
    value=client.request('/records/'+payment+'/secrets/reveal',{'field_name':'api_key'},headers=headers(signer))
    print(f"支付应用按需解密：{value['value']}（虚构演示值，{value['expires_in_seconds']} 秒）。")
    for app in (disabled,expired):
        client.request('/records/search',headers=headers(app),expected=403)
        print(f"{app['name']}：403，符合预期。")


if __name__=='__main__':
    main()
