"""Create a whitelisted delivery ZIP and verify every member before publishing."""
from pathlib import Path
import hashlib, json, zipfile, datetime

root = Path(__file__).resolve().parents[1]
package = json.loads((root / 'package.json').read_text(encoding='utf-8-sig'))
version = package['version']
release = package['build']['directories']['output']
out = root / 'deliverables'
out.mkdir(exist_ok=True)
name = f'听课笔记助手_v{version}_Windows交付包'
target = out / (name + '.zip')
if target.exists():
    target = out / (name + '_' + datetime.datetime.now().strftime('%Y%m%d_%H%M%S') + '.zip')
entries = []
for folder in ['src', 'electron', 'tests', 'docs', 'scripts', 'build']:
    for file in sorted((root / folder).rglob('*')):
        if file.is_file() and file.suffix in ['.tsx','.ts','.css','.cjs','.mjs','.js','.html','.md','.py','.plist']:
            if file.is_symlink(): raise RuntimeError('Unexpected symbolic link')
            entries.append((file, file.relative_to(root).as_posix()))
for filename in ['.gitignore','index.html','package.json','package-lock.json','tsconfig.json','vite.config.mjs','README.md']:
    entries.append((root / filename, filename))
installer = root / release / f'LectureNotes-Setup-{version}.exe'
if installer.is_file(): entries.append((installer, installer.relative_to(root).as_posix()))
for file in sorted((root / release / 'win-unpacked').rglob('*')):
    if file.is_file():
        if file.is_symlink(): raise RuntimeError('Unexpected symbolic link')
        entries.append((file, file.relative_to(root).as_posix()))
assert (root / release / 'win-unpacked/听课笔记助手.exe').is_file()
intro = f'''听课笔记助手 v{version} Windows 交付包

请先完整解压 ZIP，不要在压缩包内直接运行程序。

一、安装使用
若包中有安装器，运行 {release}\\LectureNotes-Setup-{version}.exe；否则使用免安装版。

二、免安装使用
运行 {release}\\win-unpacked\\听课笔记助手.exe。
必须保留整个 win-unpacked 目录，不能只复制 exe。

三、源码与文档
src、electron、tests、scripts 及根目录配置为项目源码。
README.md：操作、API 配置与开发启动说明。
docs\\implementation.md：设计细化与接口说明。
docs\\acceptance.md：已验证内容和未完成验收项。
安装开发环境后执行 npm ci，再按 README 启动。

四、版本说明
这是桌面试用版，安装包未签名。已完成 46 项回归测试与桌面流程验证。
实际供应商 API、真实麦克风、90 分钟课堂及性能目标尚需验收。
服务商、模型和密钥由使用者在设置页填写；专有语音协议需额外适配。
本地ASR模型需在设置中另行下载。此包不包含个人课程数据库、录音、API 密钥、开发依赖、缓存或测试数据。
win-unpacked 中的运行时文件属于软件必需部分，不能删除。

五、完整性
交付清单.json 记录所有交付文件的 SHA-256 和大小。
ZIP 同目录的 .sha256 文件用于校验整个压缩包。
'''.encode('utf-8-sig')
manifest=[]
temp=target.with_suffix('.zip.partial')
with zipfile.ZipFile(temp,'w',zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as z:
    for index,(file,rel) in enumerate(entries):
        digest=hashlib.sha256()
        with file.open('rb') as source,z.open(name+'/'+rel,'w',force_zip64=True) as dest:
            while chunk:=source.read(1024*1024):
                digest.update(chunk);dest.write(chunk)
        manifest.append({'path':rel,'bytes':file.stat().st_size,'sha256':digest.hexdigest()})
        if index%40==0: print(f'打包 {index+1}/{len(entries)}',flush=True)
    z.writestr(name+'/交付说明.txt',intro)
    manifest.append({'path':'交付说明.txt','bytes':len(intro),'sha256':hashlib.sha256(intro).hexdigest()})
    z.writestr(name+'/交付清单.json',json.dumps({'version':version,'files':manifest},ensure_ascii=False,indent=2))
print('正在验证压缩包内全部文件…',flush=True)
with zipfile.ZipFile(temp) as z:
    assert len(z.namelist())==len(manifest)+1
    for entry in manifest:
        digest=hashlib.sha256()
        with z.open(name+'/'+entry['path']) as source:
            while chunk:=source.read(1024*1024):digest.update(chunk)
        assert digest.hexdigest()==entry['sha256'],entry['path']
temp.rename(target)
digest=hashlib.sha256()
with target.open('rb') as source:
    while chunk:=source.read(1024*1024):digest.update(chunk)
target.with_suffix('.zip.sha256').write_text(digest.hexdigest()+'  '+target.name+'\n',encoding='utf-8')
print(json.dumps({'zip':str(target),'bytes':target.stat().st_size,'files':len(manifest)+1,'sha256':digest.hexdigest()},ensure_ascii=False),flush=True)
