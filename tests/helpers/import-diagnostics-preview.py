"""Real HTTP import regression in a disposable project-local vault; never reads data/."""
import argparse
import csv
import io
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

def upload(client, rows, filename='paths.json'):
    payload = json.dumps(rows).encode()
    boundary = 'ImportDiagnosticsBoundary'
    content = f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: application/json\r\n\r\n'.encode() + payload + f'\r\n--{boundary}--\r\n'.encode()
    request = urllib.request.Request(client.base + '/imports/upload', data=content, headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
    with client.opener.open(request) as response: return json.load(response)

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--serve', action='store_true'); parser.add_argument('--port', type=int, default=4190); args=parser.parse_args()
    scratch=ROOT/'samples/.build'; scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='import-diagnostics-',dir=scratch) as directory:
        folder=Path(directory)
        with (folder/'server.log').open('w') as log:
            process=subprocess.Popen([str(ROOT/'server/target/debug/securevault'),'--data-dir',str(folder/'vault'),'--addr',f'127.0.0.1:{args.port}'],cwd=ROOT,stdout=log,stderr=log,stdin=subprocess.DEVNULL)
            try:
                client=Client(args.port)
                for _ in range(100):
                    try: client.request('/vault/status'); break
                    except Exception:
                        if process.poll() is not None: raise RuntimeError('Isolated service exited')
                        time.sleep(.05)
                client.request('/vault/setup',{'password':PASSWORD})
                fields=[{'source_key':key,'zone':zone,'display_name':label} for key,zone,label in [('code','indexes','编号'),('payload','normal','提取值')]]
                dataset=client.request('/datasets',{'name':'路径与报告回归','category_path':'导入/回归','fields':fields,'identity_fields':['code'],'sample_data':[{'code':'EXISTING','payload':'原始值'}]})['dataset_id']
                rows=[{'code':'C-000','payload':json.dumps({'items':[{'id':0}]})},{'code':'C-001','payload':'{"items":[{"id":false}]}'},{'code':'C-002','payload':'SYNTHETIC-INVALID-SECRET'},{'code':'C-003','payload':json.dumps({'items':[{'id':None}]})},{'code':'C-004','payload':'{}'},{'code':'C-005','later_only':'later','payload':'SECOND-SYNTHETIC-INVALID'}]
                batch=upload(client,rows); assert 'later_only' in batch['source_fields']
                body={'dataset_id':dataset,'batch_id':batch['batch_id'],'mappings':[{'source_key':'code','target_key':'code'},{'source_key':'payload','target_key':'payload','json_path':'items.0.id'}]}
                sample_path=f"/imports/{batch['batch_id']}/samples"
                masked=client.request(sample_path,{'source_key':'payload','json_path':'items.0.id'})
                assert 'SYNTHETIC' not in json.dumps(masked) and all('text' not in row['before'] for row in masked['rows'])
                visible=client.request(sample_path,{'source_key':'payload','json_path':'items.0.id','reveal':True})
                assert visible['rows'][0]['after'].get('text')=='0' and visible['rows'][1]['after'].get('text')=='false', visible
                assert visible['rows'][2]['status']=='invalid_json'
                preview=client.request('/records/import/preview',body); report=preview['diagnostics']
                assert preview['valid'] is False and report['error_count']==2 and report['warning_count']==2
                assert [x['row'] for x in report['issues'] if x['severity']=='error']==[3,6]
                assert 'SYNTHETIC' not in json.dumps(report)
                client.request('/records/import',body,expected=400)
                assert client.search(dataset_id=dataset)['total']==1
                request=urllib.request.Request(client.base+'/records/import/report?format=csv',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
                with client.opener.open(request) as response:
                    assert response.headers['Cache-Control']=='no-store'
                    text=response.read().decode('utf-8-sig'); assert 'SYNTHETIC' not in text
                    parsed=list(csv.DictReader(io.StringIO(text))); assert len(parsed)==5 and parsed[-1]['scope']=='summary'
                app=client.request('/apps',{'name':'诊断权限回归','permission':'search','datasets':[dataset],'access_ttl_seconds':1800})
                creds={'X-App-Id':app['id'],'X-App-Key':app['key']}
                for path,request_body in [(sample_path,{'source_key':'payload','reveal':True}),('/records/import/report',body),('/datasets/transfer/report',{})]:
                    client.request(path,request_body,headers=creds,expected=403)
                client.request(sample_path,{'source_key':'payload'},headers={'Origin':'https://invalid.example.test'},expected=403)
                client.request('/imports/unknown/samples',{'source_key':'payload'},expected=404)
                good=upload(client,rows[:2]); good_body={**body,'batch_id':good['batch_id']}
                expected=client.request('/records/import/preview',good_body); assert expected['imported']==2 and client.search(dataset_id=dataset)['total']==1
                assert client.request('/records/import',good_body)['imported']==2
                records=client.search(dataset_id=dataset)['records']; assert len(records)==3
                # Native package report scans both rows; neither preview nor rejected import creates a dataset.
                native={'package':{'format':'securevault-dataset','version':1,'mode':'package','schema':{'category_path':'原生/回归','fields':[{'source_key':'code','zone':'indexes'}]},'records':[{'source_id':'same','values':{'unknown':'SYNTHETIC-NATIVE'}},{'source_id':'same','values':{'bad':'SYNTHETIC-NATIVE'}}]},'category_path':'原生/回归'}
                native_result=client.request('/datasets/transfer/preview',native); assert native_result['valid'] is False and native_result['diagnostics']['error_count']==3
                native_report=client.request('/datasets/transfer/report',native); assert native_report['error_count']==3 and 'SYNTHETIC' not in json.dumps(native_report)
                client.request('/datasets/transfer/import',native,expected=409)
                assert len(client.request('/datasets')['datasets'])==1
                client.request('/vault/seal',{})
                client.request(sample_path,{'source_key':'payload'},expected=423)
                client.request('/records/import/report',body,expected=423)
                client.request('/vault/unlock',{'password':PASSWORD})
                client.request('/records/import/report',body,expected=404)
                # Browser receives its own new batch through the file picker.
                fixture=folder/'paths.json'; fixture.write_text(json.dumps(rows,ensure_ascii=False),encoding='utf-8')
                info={'url':f'http://127.0.0.1:{args.port}','dataset':dataset,'upload_fixture':str(fixture),'checks':['source field union','masked samples','0/false extraction','all-row errors and warnings','atomic rejected import','read-only preview','CSV no-store and no raw values','app and CSRF rejection','native multi-row diagnostics','seal clears batches'],'passed':True}
                output={k:v for k,v in info.items() if k!='upload_fixture'}
                (ROOT / 'docs/ui-design/implementation').mkdir(parents=True, exist_ok=True)
                (ROOT/'docs/ui-design/implementation/import-diagnostics-e2e.json').write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n')
                print(json.dumps(info,ensure_ascii=False),flush=True)
                if args.serve:
                    signal.signal(signal.SIGTERM,lambda *_:sys.exit(0))
                    while True: time.sleep(1)
            finally:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill();process.wait()
if __name__=='__main__':
    try: main()
    except KeyboardInterrupt: pass
