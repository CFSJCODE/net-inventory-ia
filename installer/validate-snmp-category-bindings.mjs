/** Evaluate the actual compiled SNMP callback with synthetic DB and transport stubs. */
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parse} from 'acorn';
import {collect} from './nest-monitoring-panel-lib.mjs';
const NEXT='installer/nest-update-0.2.23/dist/NetInventory/app/.next-installer';
let checks=0;
for(const file of ['server/app/equipment/page.js','server/app/equipment/[id]/page.js']) {
  const source=readFileSync(`${NEXT}/${file}`,'utf8'),ast=parse(source,{ecmaVersion:'latest'});
  const text=n=>source.slice(n.start,n.end);
  const one=nodes=>{if(nodes.length!==1)throw new Error('Estrutura inesperada');return nodes[0]};
  const rules=one(collect(ast,n=>n.type==='VariableDeclarator'&&n.id?.name==='__endpointRules'));
  const action=one(collect(ast,n=>n.type==='FunctionDeclaration'&&text(n).includes('devicesByMac:')));
  const wrapper=action.body.body[0].argument.callee.name;
  const permission=one(collect(action,n=>n.type==='CallExpression'&&n.arguments[0]?.value==='network.operate')).callee.expressions.at(-1);
  const find=one(collect(action,n=>n.type==='CallExpression'&&n.callee?.property?.name==='findUnique')).callee.object;
  const dbRoot=find.object.object.name;
  const dbNamespace=find.object.property.name;
  const row=one(collect(action,n=>n.type==='VariableDeclarator'&&n.init?.type==='CallExpression'&&n.init.arguments.length===1&&n.init.arguments[0]?.type==='Identifier'&&text(n).includes('(b)')));
  const merge=one(collect(action,n=>n.type==='CallExpression'&&n.arguments[0]?.type==='ObjectExpression'&&n.arguments[0].properties.some(p=>p.key?.name==='endpoints')&&n.arguments[1]?.type==='ArrowFunctionExpression'));
  const read=one(collect(action,n=>n.type==='CallExpression'&&n.arguments[1]?.type==='CallExpression'&&n.arguments[1].callee?.property?.name==='snmpEquipmentKind'));
  const community=one(collect(action,n=>n.type==='Property'&&n.key?.name==='community'&&n.value?.type==='CallExpression')).value.callee.name;
  const context={};
  context.__endpointRules=vm.runInNewContext(text(rules.init));
  context[wrapper]=async callback=>({ok:true,data:await callback()});
  context[permission.object.name]={[permission.property.name]:async()=>{}};
  let kind,observed;
  context[dbRoot]={[dbNamespace]:{equipment:{findUnique:async()=>({ip:'192.0.2.1',name:'Synthetic',kind,monitorMode:'snmp',community:'synthetic',snmpVersion:'2c'})}}};
  context[row.init.callee.name]=record=>({kind:record.kind,monitorMode:record.monitorMode,endpoints:[],endpointConfigurationError:null});
  context[merge.callee.name]=async(config,callback)=>await callback();
  context[community]=()=> 'synthetic';
  const readStub=async(config,type)=>{observed=type;return {ports:[]}};
  if(read.callee.type==='SequenceExpression'){
    const member=read.callee.expressions.at(-1);context[member.object.name]={[member.property.name]:readStub};
  }else context[read.callee.name]=readStub;
  vm.createContext(context);
  const fn=vm.runInContext(`(${text(action)})`,context);
  for(const [category,expected] of [['PRINTER','printer'],['SWITCH','network'],['IOT','auto'],['printer','printer']]){
    kind=category;const result=await fn('synthetic-id');
    if(!result.ok||observed!==expected)throw new Error('Tipo SNMP incorreto: '+category);
    checks++;
  }
}
console.log(JSON.stringify({ok:true,checks,syntheticOnly:true,realSnmpQueried:false}));
