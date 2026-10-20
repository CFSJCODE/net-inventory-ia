/** Packages the complete installed application plus the validated Nest/dashboard changes. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync,cpSync,existsSync,mkdirSync,openSync,readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const BASE='C:/Program Files/NetInventory';
const VERSION='0.2.23';
const WORK=path.join(ROOT,'installer/nest-update-'+VERSION);
const STAGE=path.join(WORK,'dist/NetInventory');
const PREVIEW=path.join(ROOT,'installer/nest-monitoring-panel');
const OUTPUT=path.join(ROOT,'installer/output');
// r2: same package, installer that also stops and restarts NetInventoryDotNetHost.
const SETUP_NAME=`NetInventory-Setup-${VERSION}-r2`;
const SETUP=path.join(OUTPUT,`${SETUP_NAME}.exe`);
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const files=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);
const forbidden=file=>/^\.env(?:$|\.)/.test(path.basename(file))||/\.(?:db|sqlite|sqlite3)(?:-(?:journal|wal|shm))?$/i.test(file);
const prep=JSON.parse(readFileSync(path.join(PREVIEW,'preparation.json'),'utf8'));
const validation=JSON.parse(readFileSync(path.join(PREVIEW,'validation.json'),'utf8'));
// The installed base only matters while the stage is being built; a verified stage is reused afterwards.
if(!existsSync(path.join(WORK,'provenance.json'))&&(JSON.parse(readFileSync(path.join(BASE,'app/package.json'),'utf8')).version!==prep.baseVersion||prep.baseVersion!=='0.2.22'))throw new Error('Base diferente da validada');
if(!validation.ok||validation.checks<32)throw new Error('Prévia sem validação');
if(existsSync(SETUP))throw new Error('Não sobrescrever instalador anterior');
if(!existsSync(path.join(WORK,'provenance.json'))) {
  const roots=['app','node','prisma','launcher.cjs','NetInventory.exe','NetInventory.xml','logo.png','netinventory.ico'];
  if(existsSync(STAGE)){
    const stageVersion=JSON.parse(readFileSync(path.join(STAGE,'app/package.json'),'utf8')).version;
    if(process.env.NETINVENTORY_RESUME_STAGE!=='1'||![prep.baseVersion,VERSION].includes(stageVersion))throw new Error('Stage incompleto; retomada explícita necessária');
  }else{
    mkdirSync(STAGE,{recursive:true});
    for(const name of roots)cpSync(path.join(BASE,name),path.join(STAGE,name),{recursive:true,filter:file=>!forbidden(file)});
  }
  const expected=roots.flatMap(name=>statSync(path.join(BASE,name)).isDirectory()?files(path.join(BASE,name)):[path.join(BASE,name)]).filter(file=>!forbidden(file));
  const copied=expected.map(file=>path.join(STAGE,path.relative(BASE,file)));
  if(copied.some(file=>!existsSync(file)))throw new Error('Stage incompleto');
  const allowedNew=new Set(prep.changed.filter(c=>c.baseFile).map(c=>path.join('app/.next-installer',c.file)));
  if(files(STAGE).some(file=>!existsSync(path.join(BASE,path.relative(STAGE,file)))&&!allowedNew.has(path.relative(STAGE,file))))throw new Error('Arquivo inesperado no stage');
  const changes=[];
  for(const item of prep.changed){
    const original=path.join(BASE,'app/.next-installer',item.baseFile??item.file);
    const prepared=path.join(PREVIEW,'qa/app/.next-installer',item.file);
    if(hash(original)!==item.before||hash(prepared)!==item.after)throw new Error('Base ou prévia mudou: '+item.file);
    const dest=path.join(STAGE,'app/.next-installer',item.file);
    cpSync(prepared,dest);
    changes.push({file:path.relative(STAGE,dest),before:item.baseFile?null:item.before,after:item.after});
  }
  for(const file of files(STAGE)){
    if(!/\.(js|json)$/.test(file)||file.includes(`${path.sep}node_modules${path.sep}`))continue;
    const text=readFileSync(file,'utf8');
    const updated=text.replace(/(["'])0\.2\.22\1/g,`$1${VERSION}$1`);
    if(updated!==text){const before=hash(file);writeFileSync(file,updated);changes.push({file:path.relative(STAGE,file),before,after:hash(file),versionOnly:true});}
  }
  if(files(STAGE).some(forbidden))throw new Error('Dados privados no pacote');
  // Every file not deliberately changed must retain the exact content of the full baseline.
  const changedNames=new Set(changes.map(c=>c.file));
  let preserved=0;
  for(const file of copied){
    const rel=path.relative(STAGE,file);if(changedNames.has(rel))continue;
    const original=path.join(BASE,rel);
    if(rel.includes(`${path.sep}node_modules${path.sep}`)){
      if(statSync(file).size!==statSync(original).size)throw new Error('Dependência incompleta: '+rel);
    }else if(hash(file)!==hash(original)){
      if(!/\.(js|json)$/.test(file)||readFileSync(file,'utf8')!==readFileSync(original,'utf8').replace(/(["'])0\.2\.22\1/g,`$1${VERSION}$1`))throw new Error('Paridade: '+rel);
      changes.push({file:rel,before:hash(original),after:hash(file),versionOnly:true});changedNames.add(rel);continue;
    }
    preserved++;
  }
  const manifest=files(STAGE).map(file=>({file:path.relative(STAGE,file),sha256:file.includes(`${path.sep}node_modules${path.sep}`)?null:hash(file),bytes:statSync(file).size}));
  const finalChanges=[...new Map(changes.map(change=>[change.file,{...change,after:hash(path.join(STAGE,change.file))}])).values()];
  writeFileSync(path.join(WORK,'provenance.json'),JSON.stringify({date:'2026-10-12',baseVersion:prep.baseVersion,version:VERSION,method:'Recompilação seletiva sobre o aplicativo completo instalado; checkout antigo não usado como build integral',dependenciesVerification:'Cópia integral, caminhos e tamanhos; aplicação, migrações, binários e arquivos alterados verificados por SHA-256',preservedFiles:preserved,changes:finalChanges,manifest},null,2));
  console.log(JSON.stringify({version:VERSION,preservedFiles:preserved,changedFiles:changedNames.size,stage:STAGE}));
} else {
  const provenance=JSON.parse(readFileSync(path.join(WORK,'provenance.json'),'utf8'));
  for(const item of provenance.manifest){
    const file=path.join(STAGE,item.file);
    if(!existsSync(file)||statSync(file).size!==item.bytes)throw new Error('Stage incompleto: '+item.file);
    if(!item.file.includes(`${path.sep}node_modules${path.sep}`)&&hash(file)!==item.sha256)throw new Error('Stage alterado: '+item.file);
  }
  console.log('Stage íntegro reutilizado');
}
if(process.env.NETINVENTORY_STAGE_ONLY==='1')process.exit(0);
// The repository script already stops and restarts the unified .NET host, which runs this folder's engine.
let rules=readFileSync(path.join(ROOT,'installer/netinventory.iss'),'utf8');
if(rules.includes('taskkill')||!rules.includes('NetInventoryDotNetHost'))throw new Error('Instalador inseguro');
rules=rules.replace('Compression=lzma2/max','Compression=lzma2/fast');
writeFileSync(path.join(WORK,'netinventory.iss'),rules);
cpSync(path.join(STAGE,'netinventory.ico'),path.join(WORK,'dist/netinventory.ico'));
const iscc=[process.env.ISCC,path.join(process.env.LOCALAPPDATA||'','Programs/Inno Setup 6/ISCC.exe'),'C:/Program Files (x86)/Inno Setup 6/ISCC.exe'].find(f=>f&&existsSync(f));
if(!iscc)throw new Error('Inno Setup não encontrado');
mkdirSync(OUTPUT,{recursive:true});
const compilerLog=openSync(path.join(WORK,'compiler.log'),'w');
try{execFileSync(iscc,['/Qp',`/DAppVersion=${VERSION}`,`/O${OUTPUT}`,`/F${SETUP_NAME}`,path.join(WORK,'netinventory.iss')],{stdio:['ignore',compilerLog,compilerLog],cwd:ROOT});}finally{closeSync(compilerLog);}
writeFileSync(SETUP+'.sha256',`${hash(SETUP)}  ${path.basename(SETUP)}\n`,'ascii');
console.log(JSON.stringify({installer:SETUP,bytes:statSync(SETUP).size,sha256:hash(SETUP)}));
