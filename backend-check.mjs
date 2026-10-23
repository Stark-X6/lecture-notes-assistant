import assert from 'node:assert/strict';
import { createServer } from './server.mjs';

const server=createServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(route,config){const response=await fetch(`${base}/api/${route}`,config===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(config)});assert.equal(response.status,200);return response.json();}
function invariant(s){assert.equal(s.stock.available+s.stock.held+s.stock.confirmed,s.stock.total);assert.ok(s.stock.available>=0);assert.ok(s.stock.confirmed<=s.stock.total);const winners=s.actors.filter(a=>a.status==='held'||a.status==='confirmed');assert.equal(new Set(winners.map(a=>a.id)).size,winners.length);assert.equal(winners.length,s.stock.held+s.stock.confirmed);}
const cfg={countdown:0,duration:4,networkMs:0,jitterMs:0,stock:3,crowd:16,bots:4,windowSeconds:0.3,holdSeconds:1,seed:42};
try {
  for(const mode of ['fcfs','throttled','lottery']){
    await api('reset',{});await api('start',{...cfg,mode});
    const response=await api('manual/claim',{});assert.ok(response.ok);invariant(response.state);
    if(mode==='lottery')await pause(380);
    let state=await api('state');invariant(state);
    if(state.manual.status==='held')assert.ok((await api('manual/confirm',{})).ok);
    for(let i=0;i<9;i++){await pause(480);state=await api('state');invariant(state);}
    assert.equal(state.status,'finished');assert.equal(state.stock.held,0);
    const count=state.stock.confirmed;assert.equal((await api('manual/claim',{})).ok,false);await pause(50);assert.equal((await api('state')).stock.confirmed,count);
    console.log(`${mode}: inventory conserved, unique identities, lifecycle completed`);
  }
  await api('reset',{});await api('start',{...cfg,stock:1,crowd:0,bots:0,mode:'fcfs',holdSeconds:1});
  assert.ok((await api('manual/claim',{})).ok);assert.ok((await api('manual/confirm',{})).ok);
  assert.ok((await api('manual/claim',{})).ok);let state=await api('state');assert.equal(state.stock.confirmed,1);invariant(state);
  await api('reset',{});await api('start',{...cfg,stock:1,crowd:0,bots:0,mode:'fcfs'});await api('manual/claim',{});await pause(1100);state=await api('state');assert.equal(state.manual.status,'expired');assert.equal(state.stock.available,1);
  await api('reset',{});await api('start',{...cfg,stock:1,crowd:0,bots:1,mode:'lottery',windowSeconds:0.2,holdSeconds:1});await api('manual/claim',{});await pause(240);state=await api('state');invariant(state);const initial=state.actors.find(a=>a.status==='held');assert.ok(initial);
  if(initial.id==='manual'){await pause(1050);state=await api('state');assert.equal(state.manual.status,'expired');assert.ok(state.groups.bot.held+state.groups.bot.confirmed===1);}
  else {assert.equal(state.manual.status,'waiting');await api('manual/cancel',{});state=await api('state');assert.equal(state.manual.status,'failed');}
  invariant(state);console.log('manual confirmation, identity idempotence, expiry release and lottery waitlist validated');
} finally {await api('reset',{});await new Promise(resolve=>server.close(resolve));}
