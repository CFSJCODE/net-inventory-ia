/** Compare protected databases without outputting rows, credentials, IDs or configuration. */
const {DatabaseSync}=require('node:sqlite');
const {createHash}=require('node:crypto');
const before=new DatabaseSync(process.argv[2],{readOnly:true});
const after=new DatabaseSync(process.argv[3],{readOnly:true});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  if(Object.values(after.prepare('PRAGMA integrity_check').get())[0]!=='ok')throw new Error('Integridade do banco inválida');
  for(const table of ['User','Equipment']) {
    const clean=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['updatedAt','lastLoginAt','lastReadAt'].includes(key)));
    const oldRows=before.prepare(`SELECT * FROM "${table}" ORDER BY id`).all().map(clean);
    const newRows=after.prepare(`SELECT * FROM "${table}" ORDER BY id`).all().map(clean);
    if(digest(oldRows)!==digest(newRows))throw new Error(`Registros de ${table} diferem do backup`);
  }
  const oldIds=before.prepare('SELECT id FROM Device').all().map(row=>row.id);
  const newIds=new Set(after.prepare('SELECT id FROM Device').all().map(row=>row.id));
  if(oldIds.some(id=>!newIds.has(id)))throw new Error('Dispositivos anteriores ausentes');
  console.log(JSON.stringify({ok:true,integrity:'ok',usersPreserved:true,equipmentPreserved:true,previousDevicesPreserved:true}));
}finally{before.close();after.close();}
