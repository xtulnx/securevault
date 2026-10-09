#!/usr/bin/env python3
"""Test full logical backups and independent age/gzip interoperability in isolation."""
import argparse
import gzip
import json
import os
from pathlib import Path
import pty
import secrets
import select
import shutil
import socket
import subprocess
import tempfile
import termios
import time
from demo import Client, initialize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', default='server/target/release/securevault')
    parser.add_argument('--age', default='age', help='Independent age executable (required)')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    binary = str((root / args.binary).resolve())
    age = shutil.which(args.age)
    if not age:
        parser.error('Install standard age CLI to verify interoperability')
    scratch = root/'samples/.build'
    scratch.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    for name in ('SECUREVAULT_PASSWORD','SECUREVAULT_DATA_DIR','SECUREVAULT_ADDR','SECUREVAULT_PUBLIC_ORIGIN'):
        environment.pop(name,None)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0))
        port=sock.getsockname()[1]

    def start(directory):
        process=subprocess.Popen([binary,'-d',str(directory),'-p',str(port)], stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=environment)
        for _ in range(100):
            try:
                Client(port).request('/vault/status')
                return process
            except OSError:
                time.sleep(.1)
        process.terminate();process.wait()
        raise RuntimeError('server failed to start')

    def stop(process):
        process.terminate();process.wait(timeout=10)

    def age_command(command,password,prompts):
        child,fd=pty.fork()
        if child==0:
            os.umask(0o077)
            os.execvpe(command[0],command,environment)
        captured=bytearray()
        try:
            for prompt in prompts:
                deadline=time.monotonic()+20
                while prompt.encode() not in captured or termios.tcgetattr(fd)[3]&termios.ECHO:
                    assert time.monotonic()<deadline,'age prompt timed out'
                    if select.select([fd],[],[],.1)[0]:
                        captured.extend(os.read(fd,4096))
                os.write(fd,password.encode()+b'\n')
            deadline=time.monotonic()+60
            while True:
                assert time.monotonic()<deadline,'age command timed out'
                if select.select([fd],[],[],.2)[0]:
                    try:
                        data=os.read(fd,4096)
                        if not data:break
                        captured.extend(data)
                    except OSError:break
            _,status=os.waitpid(child,0)
            assert os.waitstatus_to_exitcode(status)==0, captured.decode(errors='replace')
            assert password.encode() not in captured
        finally:
            os.close(fd)

    with tempfile.TemporaryDirectory(prefix='backup-',dir=scratch) as temporary:
        directory=Path(temporary)
        source,restored=directory/'source',directory/'restored'
        archive=directory/'backup.jsonl.gz.age'
        master,backup_password,new_master=[secrets.token_urlsafe(32) for _ in range(3)]
        process=start(source)
        try:
            owner=Client(port)
            manifest,report=initialize(owner,master)
            datasets=owner.request('/datasets')['datasets']
            baseline={d['id']:owner.request('/datasets/'+d['id']+'/export?include_secrets=true') for d in datasets}
            before_records=owner.search(include_expired='true',limit=100)['records']
            templates={d['id']:owner.request('/datasets/'+d['id']+'/templates') for d in datasets}
            backup_data=dict(master_password=master,backup_password=backup_password,confirm_password=backup_password)
            backup_command=[binary,'backup','-d',str(source),'-o',str(archive),'-s']
            restore_data=dict(master_password=new_master,backup_password=backup_password,confirm_password=new_master)
            restore_command=[binary,'restore','-i',str(archive),'-o',str(restored),'-s']
            def run(command,data,success=True):
                result=subprocess.run(command,input=json.dumps(data).encode(),capture_output=True,env=environment,timeout=120)
                assert (result.returncode==0)==success,result.stderr.decode()
                return result
            invalid=list(backup_command[:-1]);invalid[3]=str(source/'vault')
            for command,message in [(invalid,'多传了一层'),(backup_command[:-1]+['--data-dir',str(source)],'参数 --data-dir 重复'),(backup_command[:-1],'正在被使用')]:
                result=subprocess.run(command,stdin=subprocess.DEVNULL,capture_output=True,text=True,env=environment,timeout=10)
                assert result.returncode!=0 and message in result.stderr
                assert '当前主密码' not in result.stdout+result.stderr
            run(backup_command,backup_data,False)
            assert not archive.exists()
            stop(process);process=None
            original_db=(source/'vault/securevault.db').read_bytes()
            original_meta=(source/'vault/vault.meta.json').read_bytes()
            run(backup_command,dict(backup_data,master_password='wrong-password'),False)
            run(backup_command,backup_data)
            run(backup_command,backup_data,False)
            assert (source/'vault/securevault.db').read_bytes()==original_db
            assert (source/'vault/vault.meta.json').read_bytes()==original_meta
            assert archive.read_bytes().startswith(b'age-encryption.org/v1\n')
            assert b'DEMO_ONLY_' not in archive.read_bytes()
            # Independent standard tool decrypts, and standard gzip exposes documented JSONL.
            compressed=directory/'independent.jsonl.gz'
            age_command([age,'-d','-o',str(compressed),str(archive)],backup_password,['Enter passphrase:'])
            plaintext=gzip.decompress(compressed.read_bytes())
            independent=subprocess.run(["gzip","-dc",str(compressed)],capture_output=True,check=True)
            assert independent.stdout==plaintext
            items=[json.loads(line) for line in plaintext.splitlines()]
            assert items[0]['version']==1 and items[-1]['type']=='end'
            assert items[-1]['counts']['datasets']==8 and items[-1]['counts']['records']==98
            assert b'DEMO_ONLY_' in plaintext
            for secret in [master,backup_password,original_meta.decode(),* [a['key'] for a in manifest['apps']]]:
                assert secret.encode() not in plaintext
            assert b'wrapped_keys' not in plaintext and b'key_hash' not in plaintext
            assert b'identity_hash' not in plaintext and b'ciphertext' not in plaintext
            run(restore_command,dict(restore_data,backup_password='wrong-backup-password'),False)
            assert not restored.exists()
            damaged=directory/'damaged.age'
            data=bytearray(archive.read_bytes());data[-1]^=1;damaged.write_bytes(data)
            command=list(restore_command);command[3]=str(damaged)
            run(command,restore_data,False);assert not restored.exists()
            truncated=directory/'truncated.age';truncated.write_bytes(archive.read_bytes()[:-16])
            command[3]=str(truncated);run(command,restore_data,False);assert not restored.exists()
            run(restore_command,restore_data)
            run(restore_command,restore_data,False)
            process=start(restored)
            owner=Client(port);owner.request('/vault/unlock',{'password':new_master})
            after=owner.request('/datasets')['datasets']
            assert after==datasets
            actual={d['id']:owner.request('/datasets/'+d['id']+'/export?include_secrets=true') for d in after}
            assert actual==baseline
            after_records=owner.search(include_expired='true',limit=100)['records']
            before_by_id={r['id']:r for r in before_records}
            after_by_id={r['id']:r for r in after_records}
            assert set(before_by_id)==set(after_by_id)
            differences={key: [field for field in before_by_id[key] if before_by_id[key][field]!=after_by_id[key][field]] for key in before_by_id if before_by_id[key]!=after_by_id[key]}
            assert not differences, differences
            assert {d['id']:owner.request('/datasets/'+d['id']+'/templates') for d in after}==templates
            assert all(a['disabled'] for a in owner.request('/apps')['apps'])
            for app in manifest['apps']:
                owner.request('/records/search',headers={'X-App-Id':app['id'],'X-App-Key':app['key']},expected=401)
            stop(process);process=None
            # Standard age also creates an archive that SecureVault restores successfully.
            standard=directory/'standard.age'
            age_command([age,'-p','-o',str(standard),str(compressed)],backup_password,['Enter passphrase','Confirm passphrase'])
            command=list(restore_command);command[3]=str(standard);command[5]=str(directory/'standard-restored')
            run(command,restore_data)
            # Authenticated but unsupported logical format must fail without publication.
            items[0]['version']=999
            future=directory/'future.gz';future.write_bytes(gzip.compress(b'\n'.join(json.dumps(x).encode() for x in items)+b'\n'))
            future_age=directory/'future.age'
            age_command([age,'-p','-o',str(future_age),str(future)],backup_password,['Enter passphrase','Confirm passphrase'])
            command[3]=str(future_age);command[5]=str(directory/'future-restored')
            run(command,restore_data,False);assert not (directory/'future-restored').exists()
            assert not any(p.name.startswith(('.vault-restore-','.backup-')) for p in directory.iterdir())
            print('全量备份恢复通过：8 数据集/98 记录/308 加密字段、配置与模板保持；源文件不变；旧应用凭据撤销；错误密码、损坏、截断、未来格式和覆盖被拒绝；标准 age/gzip 双向兼容。')
        finally:
            if process:stop(process)


if __name__=='__main__':
    main()
