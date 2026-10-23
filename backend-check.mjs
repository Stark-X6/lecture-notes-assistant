import assert from 'node:assert/strict';
import { TicketEngine } from './engine.mjs';
import { createServer } from './server.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function invariant(s){assert.equal(s.stock.total,s.stock.available+s.stock.held+s.stock.confirmed+s.stock.returned);assert.ok(s.stock.available>=0);const winners=s.actors.filter(p=>['held','confirmed'].includes(p.status));assert.equal(new Set(winners.map(p=>p.personId)).size,winners.length);assert.equal(winners.length,s.stock.held+s.stock.confirmed);}
const quiet={countdown:0,duration:4,stock:2,crowd:0,bots:0,networkMs:0,jitterMs:0,serviceMs:1,workers:2,holdSeconds:1,refundRate:0,paymentAbandonRate:0,paymentDelayMs:100};
const engine=new TicketEngine();
try {
  engine.start({...quiet,mode:'standby',paymentDelayMs:2000});const r=engine.round;
  engine.addAccount(r,'a1','person-a','device-a','bot');engine.addAccount(r,'a2','person-a','device-a','bot');engine.addAccount(r,'b','person-b','device-b','crowd');engine.addAccount(r,'c','person-c','device-c','crowd');
  await engine.submit('query');await engine.submit('claim');await engine.submit('confirm');
  await Promise.all([engine.submit('claim','a1'),engine.submit('claim','a2')]);
  let s=engine.snapshot();invariant(s);assert.equal(s.stock.held,1);assert.equal(s.groups.bot.participants,1);assert.equal(s.groups.bot.accounts,2);
  await engine.submit('waitlist','b');await engine.submit('waitlist','c');await engine.submit('waitlist','b');
  assert.deepEqual(engine.snapshot().waitlist.entries.map(e=>e.personId),['person-b','person-c']);
  await engine.submit('cancel','b');await engine.submit('waitlist','b');
  assert.deepEqual(engine.snapshot().waitlist.entries.map(e=>e.personId),['person-c','person-b']);
  await engine.submit('cancel','a1');assert.equal(r.people.get('person-c').status,'held');invariant(engine.snapshot());
  await engine.submit('refund');s=engine.snapshot();assert.equal(s.stock.returned,1);assert.equal(s.stock.available,0);invariant(s);
  await delay(1050);s=engine.snapshot();invariant(s);
  assert.ok(['held','confirmed'].includes(r.people.get('person-b').status));
  engine.reset();engine.start({...quiet,stock:1,resaleDelay:1,duration:4});
  await engine.submit('claim');await engine.submit('confirm');await engine.submit('refund');assert.equal(engine.snapshot().stock.returned,1);
  assert.equal(engine.snapshot().metrics.requestsPerConfirmed.value,null);
  assert.equal(engine.snapshot().metrics.requestsPerCompleted.value,1);
  await delay(1050);s=engine.snapshot();assert.equal(s.stock.returned,0);assert.equal(s.stock.available,1);invariant(s);
  engine.reset();engine.start({...quiet,serviceMs:60,workers:1});
  await Promise.all(Array.from({length:5},()=>engine.submit('query')));assert.ok(engine.snapshot().health.averageQueueMs>40);
  const pending=Array.from({length:8},()=>engine.submit('query'));engine.reset();await Promise.all(pending);
  // Finish retains the round but settles both queued and network-pending jobs.
  engine.start({...quiet,serviceMs:100,workers:1});await engine.submit('claim');await engine.submit('confirm');
  const finishing=Array.from({length:10},()=>engine.submit('query'));
  await delay(10);engine.finish(engine.round);await Promise.all(finishing);
  const final=engine.snapshot();assert.equal(final.status,'finished');assert.equal(final.health.activeWorkers,0);assert.equal(final.health.queueDepth,0);
  assert.equal(final.history[0].gain,null);
  await engine.submit('claim');await engine.submit('query');await delay(120);
  const after=engine.snapshot();assert.deepEqual(after.groups,final.groups);assert.deepEqual(after.health,final.health);assert.deepEqual(after.history[0].groups,after.groups);assert.deepEqual(after.history[0].metrics,after.metrics);assert.deepEqual(after.history[0].health,after.health);
  engine.reset();
  engine.start({...quiet,mode:'throttled',workers:4});await Promise.all(Array.from({length:15},()=>engine.submit('query')));
  assert.ok(engine.snapshot().metrics.interceptionRate.value>0);assert.ok(engine.snapshot().groups.manual.limited>0);
  for(const mode of ['fcfs','throttled','lottery','standby']){
    engine.reset();engine.start({...quiet,mode,stock:3,crowd:12,bots:8,botAccountsPerPerson:2,windowSeconds:.3,serviceMs:4});
    await engine.submit('claim');if(mode==='lottery')await delay(350);
    for(let i=0;i<10;i++){await delay(440);invariant(engine.snapshot());}
    s=engine.snapshot();assert.equal(s.status,'finished');assert.equal(s.stock.held,0);const count=s.stock.confirmed;
    assert.equal((await engine.submit('claim')).ok,false);assert.equal(engine.snapshot().stock.confirmed,count);
    console.log(`${mode}: inventory, shared identities, queue, lifecycle passed`);
  }
  engine.reset();const server=createServer({engine});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    const post=async(route,data={})=>(await fetch(`${base}/api/${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)})).json();
    await post('start',quiet);const result=await post('manual/query');assert.ok(result.ok);assert.equal(result.query.available,2);assert.equal(result.state.manual.query.available,2);
    const claims=Array.from({length:4},()=>post('manual/claim'));await post('reset');await Promise.all(claims);
    assert.equal((await (await fetch(`${base}/api/export`)).json()).stock.returned,0);
  } finally {engine.reset();await new Promise(resolve=>server.close(resolve));}
  console.log('standby FIFO, duplicate identities, refund batches, measured capacity, behavioral protection and HTTP reset passed');
} finally {engine.reset();}
