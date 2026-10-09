#!/usr/bin/env python3
"""Generate deterministic fictional import fixtures; Python standard library only."""
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / 'raw'


def save(name, value):
    (RAW / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def fields(spec):
    return [dict(source_key=key, display_name=label, zone=zone, unique=unique, position=i)
            for i, (key, label, zone, unique) in enumerate(spec)]


def dataset(key, category, environment, filename, spec, identity, mappings=None):
    definitions = fields(spec)
    return dict(key=key, file=filename, mappings=mappings or [], category_path=category,
                environment=environment, fields=definitions, identity_fields=identity,
                list_fields=[dict(source_key=f['source_key'], display_name=f['display_name'],
                                 position=i, visible=f['source_key'] != 'internal_note',
                                 format='multiline' if f['source_key'] in ('description', 'runbook') else
                                 'json' if f['source_key'] == 'tags' else 'single_line')
                             for i, f in enumerate(definitions) if f['zone'] in ('indexes', 'display')])


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    definitions = []
    game_spec = [
        ('alias', '产品名称', 'indexes', False), ('gid', '游戏 ID', 'indexes', True),
        ('platform', '平台', 'indexes', True), ('product_id', '产品编号', 'indexes', False),
        ('owner', '负责团队', 'indexes', False), ('region', '发行区域', 'indexes', False),
        ('version', 'SDK 版本', 'display', False), ('status', '接入状态', 'display', False),
        ('pay_callback', '支付回调', 'display', False), ('refund_callback', '退款回调', 'display', False),
        ('description', '接入说明', 'display', False), ('tags', '标签', 'display', False),
        ('internal_note', '内部备注（列表隐藏）', 'display', False),
        ('app_secret', '应用密钥', 'secrets', False), ('product_key', '产品密钥', 'secrets', False),
        ('sign_key', '签名密钥', 'secrets', False), ('private_config', '私有配置', 'hidden', False)]
    names = ['星海远征', '风之旅团', '雾境侦探', '像素农场', '机甲黎明', '云端棋局', '深蓝航线', '山海纪行', '纸飞机计划', '月光小镇', '北境回响', '轨道先锋']
    platforms = ['Android', 'iOS', 'PC', 'Harmony']
    for key, environment, count in [('games_prod', '正式', 48), ('games_test', '测试', 8), ('games_staging', '预发布', 8)]:
        rows = []
        for i in range(count):
            gid, platform = 2001 + i // 4, platforms[i % 4]
            rows.append(dict(alias=f'{names[i // 4]}（{platform}）', gid=gid, platform=platform,
                             product_id=f'GAME-{gid}-{platform.upper()}', owner=['极光工作室', '青禾工作室', '飞鸟工作室'][i % 3],
                             region=['中国大陆', '东南亚', '欧洲'][i % 3], version='3.2.0', status='已上线' if key == 'games_prod' else '联调中',
                             pay_callback=f'https://gateway.example.test/{key}/pay/{gid}/{platform.lower()}',
                             refund_callback=f'https://gateway.example.test/{key}/refund/{gid}/{platform.lower()}',
                             description='支付验签使用 HMAC-SHA256。\n回调须在 5 秒内返回成功；失败最多重试 3 次。',
                             tags=['角色扮演' if i % 2 else '休闲', '跨平台', environment], internal_note='演示列表可隐藏普通展示字段，详情仍可见。',
                             app_secret=f'DEMO_ONLY_APP_{key}_{gid}_{platform}', product_key=f'DEMO_ONLY_PRODUCT_{gid}_{platform}',
                             sign_key=f'DEMO_ONLY_SIGN_{key}_{gid}_{platform}', private_config=json.dumps(dict(debug=i % 2 == 0, allow_hosts=['127.0.0.1']))))
        filename=f'{key}.json'; save(filename, rows)
        definitions.append(dataset(key, '游戏业务/SDK/产品', environment, filename, game_spec, ['gid', 'platform']))
        if key == 'games_prod':
            changed = dict(rows[0], version='3.3.1', description='已通过唯一 KEY 更新到 SDK 3.3.1。\n重导入不会新增重复记录。')
            save('games_update.json', [changed])
            save('games_skip_existing.json', [dict(changed, version='0.0.0-不应覆盖')])

    payment_spec = [('alias','商户名称','indexes',False), ('merchant_id','商户编号','indexes',True),
                    ('channel','支付渠道','indexes',False), ('region','区域','indexes',False),
                    ('callback','通知地址','display',False), ('currency','币种','display',False),
                    ('settlement','结算周期','display',False), ('description','接入备注','display',False),
                    ('api_key','API 密钥','secrets',False), ('certificate','私有证书','hidden',False)]
    columns=['商户名称','商户编号','支付渠道','区域','通知地址','币种','结算周期','接入备注','API密钥','私有证书']
    with (RAW/'merchants.csv').open('w',newline='',encoding='utf-8') as stream:
        writer=csv.writer(stream, lineterminator='\n'); writer.writerow(columns)
        for i in range(12):
            writer.writerow([f'{names[i]}旗舰店', f'MCH-{3001+i}', ['微信支付','支付宝','银联'][i%3], ['上海','杭州','深圳'][i%3],
                             f'https://pay.example.test/notify/MCH-{3001+i}', 'CNY','T+1', '支持退款、对账；CSV 字段名映射演示',
                             f'DEMO_ONLY_PAY_{3001+i}', f'DEMO_ONLY_CERT_{3001+i}'])
    mappings=[dict(source_key=col,target_key=spec[0]) for col,spec in zip(columns,payment_spec)]
    definitions.append(dataset('payments','支付业务/商户','正式','merchants.csv',payment_spec,['merchant_id'],mappings))

    cloud_spec=[('alias','服务名称','indexes',False),('service_id','服务编号','indexes',True),('region','部署区域','indexes',True),
                ('provider','云服务商','indexes',False),('endpoint','访问地址','display',False),('replicas','副本数','display',False),
                ('runbook','维护说明','display',False),('access_key','访问密钥','secrets',False),('secret_key','签名密钥','secrets',False)]
    clouds=[dict(alias=name,service_id=f'SVC-{4001+i}',region=['cn-shanghai','cn-hangzhou','ap-singapore'][i%3],provider=['阿里云','腾讯云'][i%2],
                 endpoint=f'https://{slug}.infra.example.test',replicas=[0,2,3][i%3],runbook='每周检查容量。\n变更前先做快照，保留最近 7 天。',
                 access_key=f'DEMO_ONLY_AK_{4001+i}',secret_key=f'DEMO_ONLY_SK_{4001+i}')
            for i,(name,slug) in enumerate([('订单数据库','orders-db'),('账单对象存储','billing-oss'),('消息队列','event-mq'),('日志检索','logs'),('CDN 分发','cdn'),('监控中心','monitor'),('缓存服务','redis'),('容器集群','k8s')])]
    save('cloud_services_source.json',clouds)
    definitions.append(dataset('cloud','基础设施/云服务','正式','cloud_services.xlsx',cloud_spec,['service_id','region']))

    hook_spec=[('alias','集成名称','indexes',False),('hook_id','Webhook 编号','indexes',True),('event','订阅事件','indexes',False),
               ('endpoint','回调地址','display',False),('retry_limit','最大重试','display',False),('description','使用说明','display',False),
               ('signing_secret','验签密钥','secrets',False),('headers.Authorization','私有请求头','hidden',False)]
    hooks=[dict(name=name,id=f'HOOK-{i+1:03}',event=event,config=json.dumps(dict(endpoint=f'https://hooks.example.test/{i+1}',retry=dict(limit=3),
              signing_secret=f'DEMO_ONLY_HOOK_{i+1}',headers=dict(Authorization=f'DEMO_ONLY_BEARER_{i+1}')),ensure_ascii=False),notes='源字段 config 是 JSON 字符串，导入时按路径抽取配置。')
           for i,(name,event) in enumerate([('订单同步','order.created'),('退款通知','refund.completed'),('玩家注册','player.created'),('支付成功','payment.completed'),('运维告警','alert.created'),('发布通知','release.completed')])]
    save('webhooks.json',hooks)
    hook_mappings=[dict(source_key=a,target_key=b) for a,b in [('name','alias'),('id','hook_id'),('event','event'),('notes','description')]]
    hook_mappings += [dict(source_key='config',target_key=key,json_path=path) for key,path in [('endpoint','endpoint'),('retry_limit','retry.limit'),('signing_secret','signing_secret'),('headers','headers')]]
    definitions.append(dataset('hooks','系统集成/Webhook', '测试','webhooks.json',hook_spec,['hook_id'],hook_mappings))

    doc_spec=[('alias','文档标题','indexes',False),('doc_id','文档编号','indexes',True),('owner','负责团队','indexes',False),
              ('description','正文','display',False),('url','文档地址','display',False),('tags','标签','display',False)]
    save('knowledge.json',[dict(alias=title,doc_id=f'DOC-{i+1:03}',owner='平台运营组',description=text,url=f'https://docs.example.test/{i+1}',tags=['运行手册','演示'])
         for i,(title,text) in enumerate([('支付回调排查','检查请求签名、重试次数与返回码。\n跨团队协作时复制完整回调地址。'),('SDK 接入流程','先在测试环境联调，再切到预发布，验收后上线。'),('密钥轮换清单','生成新密钥、双写过渡、确认调用、禁用旧密钥。'),('数据导入规范','定义索引、展示、隐藏和敏感字段，设置逻辑唯一 KEY。'),('故障通知模板','影响范围：待填写。\n负责人：待填写。\n预计恢复：待填写。'),('零值与空字段','副本数为 0 是有效信息；没有环境标签和敏感字段也能展示。')])])
    definitions.append(dataset('knowledge','团队协作/运行手册',None,'knowledge.json',doc_spec,['doc_id']))

    inventory_spec=[('alias','配置名称','indexes',False),('config_id','配置编号','indexes',True),('enabled','启用','display',False),('description','用途','display',False)]
    configs=[dict(alias=name,config_id=f'CFG-{i+1:03}',enabled=i!=2,description='演示全量同步与 Schema 演进。') for i,name in enumerate(['支付限流','登录频控','旧渠道开关'])]
    save('inventory_initial.json',configs)
    save('inventory_sync.json',[dict(row,region='cn-shanghai') for row in configs[:2]])
    definitions.append(dataset('inventory','平台配置/同步示例','测试','inventory_initial.json',inventory_spec,['config_id']))
    save('datasets.json',definitions)
    print('Generated 8 dataset definitions and JSON/CSV fixtures.')


if __name__ == '__main__':
    main()
