import { performance } from 'node:perf_hooks';

export const defaults = {
  mode:'fcfs', stock:30, crowd:120, bots:12, countdown:8, duration:25,
  windowSeconds:3, botInterval:150, networkMs:60, jitterMs:40, seed:42,
  holdSeconds:6, botAccountsPerPerson:2, serviceMs:15, workers:4,
  refundRate:10, resaleDelay:3, paymentDelayMs:850, paymentAbandonRate:4,
};
const modes=new Set(['fcfs','throttled','lottery','standby']);
const groupNames=['crowd','bot','manual'];
const bounds={stock:[1,200],crowd:[0,1000],bots:[0,100],countdown:[0,30],duration:[4,120],windowSeconds:[.2,20],botInterval:[40,3000],networkMs:[0,400],jitterMs:[0,400],seed:[0,4294967295],holdSeconds:[1,10],botAccountsPerPerson:[1,5],serviceMs:[1,200],workers:[1,16],refundRate:[0,50],resaleDelay:[1,20],paymentDelayMs:[100,10000],paymentAbandonRate:[0,50]};
const integerFields=new Set(['stock','crowd','bots','seed','botAccountsPerPerson','workers']);
export function normalizeConfig(input={}) {
  const c={mode:modes.has(input.mode)?input.mode:defaults.mode};
  for(const [key,[min,max]] of Object.entries(bounds)) {
    const n=input[key]===undefined?defaults[key]:Number(input[key]);
    c[key]=Number.isFinite(n)?Math.max(min,Math.min(max,n)):defaults[key];
    if(integerFields.has(key))c[key]=Math.floor(c[key]);
  }
  c.windowSeconds=Math.min(c.windowSeconds,c.duration-.1);
  return c;
}
function rng(seed){let a=seed>>>0;return()=>{a+=0x6D2B79F5;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
function measure(numerator,denominator,definition){return {value:denominator?numerator/denominator:null,numerator,denominator,definition};}

export class TicketEngine {
  constructor(){this.round=null;this.history=[];this.sequence=0;this.eventSequence=0;}
  schedule(r,fn,delay){if(r.closed||r.status==='finished')return null;const timer=setTimeout(()=>{r.timers.delete(timer);if(this.round===r&&!r.closed&&r.status!=='finished')fn();},Math.max(0,delay));r.timers.add(timer);return timer;}
  event(r,type,group,message){r.events.push({id:++this.eventSequence,time:Date.now(),type,group,message});if(r.events.length>160)r.events.shift();}
  addAccount(r,accountId,personId,deviceId,group){
    const account={accountId,personId,deviceId,group,attempts:0,query:null};r.accounts.set(accountId,account);
    let person=r.people.get(personId);
    if(!person){person={id:personId,personId,group,accountIds:[],status:'idle',message:'等待开售',owner:null,orderId:null,expiresAt:null,rank:null,entry:false,eligible:false,refunded:false};r.people.set(personId,person);}
    person.accountIds.push(accountId);return account;
  }
  stock(r){let held=0,confirmed=0;for(const p of r.people.values()){held+=p.status==='held';confirmed+=p.status==='confirmed';}return {total:r.config.stock,available:r.config.stock-held-confirmed-r.returned,held,confirmed,returned:r.returned};}
  groupStats(r){return Object.fromEntries(groupNames.map(group=>{const people=[...r.people.values()].filter(p=>p.group===group);return [group,{participants:people.length,accounts:[...r.accounts.values()].filter(a=>a.group===group).length,...r.stats[group],held:people.filter(p=>p.status==='held').length,confirmed:people.filter(p=>p.status==='confirmed').length}];}));}
  metrics(r){
    const active=[...r.activePeople],protectedPeople=[...r.protectedPeople];
    const bots=active.filter(id=>r.people.get(id).group==='bot'),crowd=active.filter(id=>r.people.get(id).group==='crowd');
    const intercepted=ids=>ids.filter(id=>r.protectedPeople.has(id)).length;
    const claims=groupNames.reduce((n,g)=>n+r.stats[g].requests,0);
    return {
      requestsPerConfirmed:measure(claims,this.stock(r).confirmed,'claim 请求次数 / 当前有效已确认票数；退票后不计入分母，无有效确认票时为 null'),
      requestsPerCompleted:measure(claims,r.confirmations,'claim 请求次数 / 累计确认订单次数（含后来退票订单）；无累计确认时为 null'),
      interceptionRate:measure(protectedPeople.length,active.length,'至少一次被简化保护规则延迟或拒绝的独立购票人 / 发起有效查询、提交或候补请求的独立购票人；是保护处置暴露比例，并非检测准确率'),
      botInterceptionRate:measure(intercepted(bots),bots.length,'事后按 bot 分组统计的保护处置暴露比例；分组不参与保护决策'),
      falsePositiveRate:measure(intercepted(crowd),crowd.length,'事后按 crowd 分组统计的保护处置暴露比例（群众误伤代理指标），不代表真实平台误报率'),
      paymentTimeoutRate:measure(r.timeouts,r.holds,'未支付占位超时次数 / 累计占位次数；结束时清理未支付占位不计超时'),
    };
  }
  health(r){const q=[...r.queueSamples].sort((a,b)=>a-b);return {queueDepth:r.queue.length,inFlight:r.networkPending,activeWorkers:r.activeWorkers,processed:r.completed,totalOperations:r.completed,startedOperations:r.started,totalQueueMs:r.queueMs,totalProcessingMs:r.processingMs,totalLatencyMs:r.latencyMs,averageProcessingMs:r.completed?r.processingMs/r.completed:0,averageQueueMs:r.started?r.queueMs/r.started:0,p95QueueMs:q.length?q[Math.ceil(q.length*.95)-1]:0,averageLatencyMs:r.completed?r.latencyMs/r.completed:0,simulatedServiceMs:r.config.serviceMs,workers:r.config.workers,peakQueue:r.peakQueue,simulation:'in-process',networkModel:'提交前采样单程网络延迟；有限并发队列产生排队延迟；serviceMs 是模拟服务耗时，averageProcessingMs 是实测业务处理耗时。',protectionModel:'简化实验规则：账号/购票人/设备一秒请求窗口；慢速和拒绝仅用于 throttled，绝不读取分组。',queueSampleCount:q.length};}
  sample(r){const g=this.groupStats(r);r.timeline.push({t:Math.round((Date.now()-r.saleAt)/100)/10,crowd:g.crowd.confirmed,bot:g.bot.confirmed,manual:g.manual.confirmed,requests:groupNames.reduce((n,k)=>n+g[k].requests,0)});if(r.timeline.length>300)r.timeline.shift();}
  snapshot(){
    const r=this.round;
    if(!r)return {status:'idle',roundId:null,mode:defaults.mode,config:{...defaults},serverTime:Date.now(),saleAt:null,endsAt:null,windowEndsAt:null,stock:{total:defaults.stock,available:defaults.stock,held:0,confirmed:0,returned:0},groups:Object.fromEntries(groupNames.map(g=>[g,{participants:g==='manual'?1:0,accounts:g==='manual'?1:0,queries:0,requests:0,accepted:0,limited:0,rejected:0,held:0,confirmed:0}])),manual:{status:'idle',message:'开始实验后，可亲自参与抢票。',orderId:null,expiresAt:null,rank:null,query:null,personId:'manual-person',accountId:'manual',deviceId:'manual-device',waitlistRank:null},waitlist:{size:0,entries:[],policy:'server-registration-order'},events:[],timeline:[],history:this.history,actors:[],metrics:null,health:{queueDepth:0,processed:0,averageProcessingMs:0,averageQueueMs:0,p95QueueMs:0,averageLatencyMs:0,simulatedServiceMs:defaults.serviceMs,workers:defaults.workers,totalOperations:0,startedOperations:0,totalQueueMs:0,totalProcessingMs:0,totalLatencyMs:0,peakQueue:0,simulation:'in-process'}};
    const p=r.people.get('manual-person'),a=r.accounts.get('manual');
    const entries=r.waitlist.filter(id=>r.people.get(id)?.status==='waiting'&&r.people.get(id)?.eligible).map((id,i)=>({personId:id,rank:i+1,registeredAt:r.people.get(id).registeredAt}));
    return {status:r.status,roundId:r.id,mode:r.config.mode,config:r.config,serverTime:Date.now(),saleAt:r.saleAt,endsAt:r.endsAt,windowEndsAt:r.windowEndsAt,stock:this.stock(r),groups:this.groupStats(r),manual:{status:p.status,message:p.message,orderId:p.orderId,expiresAt:p.expiresAt,rank:p.rank,query:a.query,personId:a.personId,accountId:a.accountId,deviceId:a.deviceId,waitlistRank:entries.find(e=>e.personId===p.id)?.rank??null},waitlist:{size:entries.length,entries,policy:r.config.mode==='lottery'?'uniform-person-lottery':'server-registration-order'},events:r.events,timeline:r.timeline,history:this.history,actors:[...r.people.values()].map(p=>({id:p.id,personId:p.id,group:p.group,status:p.status,accountId:p.owner?.accountId??p.accountIds[0],deviceId:p.owner?.deviceId??r.accounts.get(p.accountIds[0]).deviceId,accountIds:p.accountIds})),metrics:this.metrics(r),health:this.health(r)};
  }
  summary(r){const groups=this.groupStats(r),crowdRate=groups.crowd.participants?groups.crowd.confirmed/groups.crowd.participants:0,botRate=groups.bot.participants?groups.bot.confirmed/groups.bot.participants:0;return {roundId:r.id,mode:r.config.mode,stock:this.stock(r),crowdRate,botRate,gain:groups.bot.participants&&crowdRate?botRate/crowdRate:null,requests:groupNames.reduce((n,k)=>n+groups[k].requests,0),groups,config:r.config,metrics:this.metrics(r),health:this.health(r),finishedAt:Date.now()};}
  finish(r){if(r.status==='finished')return;r.status='finished';this.stopJobs(r,'本轮已结束，尚未完成的请求已结清。');for(const p of r.people.values()){if(p.status==='held'){p.status='expired';p.message='本轮结束，未支付占位已释放。';p.expiresAt=null;}else if(p.status==='waiting'){p.status='failed';p.message='本轮结束，未获得票。';}p.eligible=false;}this.event(r,'finish',null,'本轮结束，停止分配；待二次开售库存继续保留。');this.sample(r);this.history.unshift(this.summary(r));this.history=this.history.slice(0,10);}
  live(r){if(Date.now()>=r.endsAt){this.finish(r);return false;}return r.status==='live';}
  stopJobs(r,message){for(const t of r.timers)clearTimeout(t);r.timers.clear();for(const job of r.jobs)job.resolve({ok:false,message});r.jobs.clear();r.queue=[];r.networkPending=0;r.activeWorkers=0;}
  close(r){if(!r)return;r.closed=true;this.stopJobs(r,'轮次已重置或关闭。');}
  reset(){this.close(this.round);this.round=null;return {ok:true,message:'实验已重置，历史保留。'};}
  start(input={}){
    if(this.round&&['countdown','live'].includes(this.round.status))return {ok:false,message:'本轮仍在运行，请先重置。'};
    this.close(this.round);const config=normalizeConfig(input),now=Date.now();
    const r={id:`R${++this.sequence}`,config,status:config.countdown?'countdown':'live',saleAt:now+config.countdown*1000,endsAt:now+(config.countdown+config.duration)*1000,windowEndsAt:now+(config.countdown+config.windowSeconds)*1000,random:rng(config.seed),accounts:new Map(),people:new Map(),stats:Object.fromEntries(groupNames.map(g=>[g,{queries:0,requests:0,accepted:0,limited:0,rejected:0,refunds:0}])),events:[],timeline:[],waitlist:[],lotteryClosed:false,orders:0,returned:0,resaleScheduled:false,holds:0,confirmations:0,timeouts:0,timers:new Set(),jobs:new Set(),queue:[],networkPending:0,activeWorkers:0,completed:0,started:0,queueMs:0,processingMs:0,latencyMs:0,queueSamples:[],peakQueue:0,activePeople:new Set(),protectedPeople:new Set(),behavior:new Map(),closed:false};
    this.round=r;this.addAccount(r,'manual','manual-person','manual-device','manual');
    for(let i=1;i<=config.crowd;i++)this.addAccount(r,`crowd-${i}`,`crowd-person-${i}`,`crowd-device-${i}`,'crowd');
    for(let i=1;i<=config.bots;i++){const n=Math.ceil(i/config.botAccountsPerPerson);this.addAccount(r,`bot-${i}`,`bot-person-${n}`,`bot-device-${n}`,'bot');}
    this.event(r,'start',null,`统一库存 ${config.stock} 张；${r.accounts.size} 个账号，${r.people.size} 位独立购票人。`);
    this.schedule(r,()=>{r.status='live';this.event(r,'sale',null,'开售：查询结果是快照，提交时重新检查真实库存。');},config.countdown*1000);
    this.schedule(r,()=>this.finish(r),(config.countdown+config.duration)*1000);
    if(config.mode==='lottery')this.schedule(r,()=>this.draw(r),(config.countdown+config.windowSeconds)*1000);
    for(const a of r.accounts.values()){
      if(a.accountId==='manual')continue;
      const first=a.group==='bot'?r.random()*65:300+r.random()*2200+(r.random()<.16?r.random()*Math.min(8000,config.duration*600):0);
      this.schedule(r,()=>this.simulate(r,a),config.countdown*1000+first);
    }
    const tick=()=>{this.sample(r);if(r.status!=='finished')this.schedule(r,tick,500);};tick();
    return {ok:true,message:'实验已开始。'};
  }
  // Every operation, including the real operator's actions, uses this scheduler.
  submit(operation,accountId='manual',r=this.round){
    if(!r||r.closed||this.round!==r)return Promise.resolve({ok:false,message:'请先开始实验。'});
    if(r.status==='finished'||Date.now()>=r.endsAt){this.finish(r);return Promise.resolve({ok:false,message:'本轮已结束。'});}
    const account=r.accounts.get(accountId);if(!account)return Promise.resolve({ok:false,message:'未知账号。'});
    return new Promise(resolve=>{
      const job={operation,account,r,resolve,createdAt:performance.now()};r.jobs.add(job);r.networkPending++;
      const network=Math.max(0,r.config.networkMs+(r.random()*2-1)*r.config.jitterMs);
      this.schedule(r,()=>{r.networkPending--;job.enqueuedAt=performance.now();r.queue.push(job);r.peakQueue=Math.max(r.peakQueue,r.queue.length);this.pump(r);},network);
    });
  }
  protect(r,a,operation){
    if(!['query','claim','waitlist'].includes(operation)||Date.now()<r.saleAt||!this.live(r))return {extra:0,reject:false};
    r.activePeople.add(a.personId);const now=Date.now();
    const counts=[`a:${a.accountId}`,`p:${a.personId}`,`d:${a.deviceId}`].map(key=>{const samples=(r.behavior.get(key)||[]).filter(t=>t>now-1000);samples.push(now);r.behavior.set(key,samples);return samples.length;});
    if(r.config.mode!=='throttled')return {extra:0,reject:false};
    const reject=counts[0]>8||counts[1]>10||counts[2]>14;
    const slow=!reject&&(counts[0]>4||counts[1]>6||counts[2]>8);
    if(reject||slow){r.protectedPeople.add(a.personId);r.stats[a.group].limited++;this.event(r,reject?'risk-reject':'risk-slow',a.group,`${a.accountId} 触发简化频率规则：${reject?'拒绝本次请求':'增加有限服务延迟'}。`);}
    return {extra:slow?Math.min(100,r.config.serviceMs*2):0,reject};
  }
  pump(r){
    if(r.closed||this.round!==r||r.status==='finished')return;
    while(r.activeWorkers<r.config.workers&&r.queue.length){
      const job=r.queue.shift();r.activeWorkers++;r.started++;
      const queueMs=performance.now()-job.enqueuedAt;r.queueMs+=queueMs;r.queueSamples.push(queueMs);if(r.queueSamples.length>10000)r.queueSamples.shift();
      const protection=this.protect(r,job.account,job.operation);
      if(r.status==='finished')return;
      this.schedule(r,()=>{
        if(!this.live(r)&&r.status==='finished')return;
        const begin=performance.now();let result;
        if(protection.reject){this.countOperation(r,job.account,job.operation);r.stats[job.account.group].rejected++;result={ok:false,message:'简化保护规则：账号、购票人或设备请求过密，请稍后重试。'};}
        else result=this.process(r,job.account,job.operation);
        if(r.status==='finished')return;
        r.processingMs+=performance.now()-begin;r.completed++;r.latencyMs+=performance.now()-job.createdAt;r.activeWorkers--;r.jobs.delete(job);job.resolve(result);this.pump(r);
      },r.config.serviceMs+protection.extra);
    }
  }
  countOperation(r,a,op){if(op==='query')r.stats[a.group].queries++;else if(op==='claim'){r.stats[a.group].requests++;a.attempts++;}}
  process(r,a,op){
    const p=r.people.get(a.personId),now=Date.now();
    if(r.status==='finished'||now>=r.endsAt){this.finish(r);return {ok:false,message:'本轮已结束。'};}
    this.countOperation(r,a,op);
    if(now<r.saleAt){p.message='尚未开售，请等待倒计时结束。';return {ok:false,message:p.message};}
    if(!this.live(r))return {ok:false,message:'本轮已结束。'};
    if(op==='query'){a.query={available:this.stock(r).available,queriedAt:now};return {ok:true,message:`查询快照：${a.query.available} 张；提交时会重新检查库存。`,query:a.query};}
    if(op==='confirm')return this.confirm(r,p);
    if(op==='cancel')return this.release(r,p,'cancelled');
    if(op==='refund')return this.refund(r,p);
    if(op==='waitlist')return this.register(r,a);
    if(op!=='claim')return {ok:false,message:'未知操作。'};
    if(p.status==='held'||p.status==='confirmed')return {ok:true,message:p.status==='held'?'该购票人已有占位，请及时确认。':'该购票人已经购票成功。'};
    if(p.refunded)return {ok:false,message:'该购票人已退票，本轮不可再次购票。'};
    if(r.config.mode==='lottery')return this.register(r,a);
    if(r.config.mode==='standby')this.promote(r);
    if(this.hold(r,p,a))return {ok:true,message:p.message};
    r.stats[a.group].rejected++;p.message=r.config.mode==='standby'?'当前无余票，可登记候补；候补顺序以服务器登记生效时间为准。':'提交时已无余票，查询快照不代表保留库存。';
    if(p.status!=='waiting')p.status='failed';return {ok:false,message:p.message};
  }
  hold(r,p,a){
    if(!this.live(r)||this.stock(r).available<=0||p.status==='held'||p.status==='confirmed'||p.refunded)return false;
    p.status='held';p.owner=a;p.orderId=`${r.id}-${++r.orders}`;p.expiresAt=Date.now()+r.config.holdSeconds*1000;p.eligible=false;p.message='已获得占位，请及时确认付款。';r.holds++;r.stats[p.group].accepted++;
    const order=p.orderId;this.event(r,'held',p.group,`${p.id} 通过 ${a.accountId} 获得唯一占位。`);
    this.schedule(r,()=>{if(p.status==='held'&&p.orderId===order)this.release(r,p,'expired');},r.config.holdSeconds*1000);
    if(a.accountId!=='manual'&&r.random()*100>=r.config.paymentAbandonRate){
      this.schedule(r,()=>{if(p.status==='held'&&p.orderId===order)this.submit('confirm',a.accountId,r);},Math.max(50,r.config.paymentDelayMs+(r.random()*2-1)*250));
    }
    return true;
  }
  confirm(r,p){
    if(p.status==='confirmed')return {ok:true,message:'订单已确认，每位购票人最多一张。'};
    if(p.status!=='held')return {ok:false,message:'当前没有可确认的占位。'};
    if(Date.now()>=p.expiresAt){this.release(r,p,'expired');return {ok:false,message:'占位已到期。'};}
    p.status='confirmed';p.expiresAt=null;p.message='支付成功，订单已确认。';r.confirmations++;this.event(r,'confirmed',p.group,`${p.id} 确认订单。`);
    if(p.owner.accountId!=='manual'&&r.random()*100<r.config.refundRate){const order=p.orderId;this.schedule(r,()=>{if(p.status==='confirmed'&&p.orderId===order)this.submit('refund',p.owner.accountId,r);},800+r.random()*1600);}
    return {ok:true,message:p.message};
  }
  release(r,p,reason){
    if(!['held','waiting'].includes(p.status))return {ok:false,message:'当前没有占位或候补登记。'};
    const wasHeld=p.status==='held';p.status=reason==='expired'?'expired':'failed';p.eligible=false;p.expiresAt=null;p.message=reason==='expired'?'未支付占位超时，库存即时释放。':'已取消占位或候补登记。';
    if(reason==='expired'&&wasHeld)r.timeouts++;
    this.event(r,reason,p.group,`${p.id}：${p.message}`);this.promote(r);return {ok:true,message:p.message};
  }
  refund(r,p){
    if(p.refunded)return {ok:false,message:'该订单已经退票，不能重复退票。'};
    if(p.status!=='confirmed')return {ok:false,message:'仅已支付订单可以退票。'};
    p.status='refunded';p.refunded=true;p.message='已退票，票进入待二次开售池。';r.returned++;r.stats[p.group].refunds++;
    this.event(r,'refund',p.group,`${p.id} 已支付退票，库存进入待二次开售池。`);
    if(!r.resaleScheduled){r.resaleScheduled=true;this.schedule(r,()=>{r.resaleScheduled=false;if(!this.live(r))return;const count=r.returned;r.returned=0;this.event(r,'resale',null,`${count} 张退票结束批次等待，进入可售库存。`);this.promote(r);},r.config.resaleDelay*1000);}
    return {ok:true,message:p.message};
  }
  register(r,a){
    const p=r.people.get(a.personId);
    if(!['lottery','standby'].includes(r.config.mode))return {ok:false,message:'当前模式不支持登记候补。'};
    if(p.status==='held'||p.status==='confirmed')return {ok:true,message:'该购票人已有占位或已购票。'};
    if(p.refunded)return {ok:false,message:'已退票购票人本轮不能重新登记。'};
    if(r.config.mode==='lottery'){
      if(Date.now()>=r.windowEndsAt){this.draw(r);return {ok:p.status==='held'||p.status==='waiting',message:p.entry?p.message:'抽签登记窗口已关闭。'};}
      if(p.entry)return {ok:p.status==='waiting',message:p.message};
    } else if(p.eligible&&p.status==='waiting')return {ok:true,message:'已登记候补，重复请求不会改变顺序。'};
    p.entry=true;p.eligible=true;p.owner=a;p.status='waiting';p.registeredAt=Date.now();p.message=r.config.mode==='lottery'?'已登记：同一购票人仅一个抽签名额。':'已登记候补，按照服务器登记生效顺序递补。';
    // A cancelled registration has forfeited its place. Remove its stale queue
    // node before appending a new registration; person identity alone is no token.
    r.waitlist=r.waitlist.filter(id=>id!==p.id);
    r.waitlist.push(p.id);p.rank=r.waitlist.filter(id=>r.people.get(id).eligible).length;
    this.event(r,'entry',p.group,`${p.id}：${p.message}`);
    if(r.config.mode==='standby')this.promote(r);
    return {ok:true,message:p.message};
  }
  draw(r){
    if(r.lotteryClosed||!this.live(r))return;r.lotteryClosed=true;
    const ids=r.waitlist.filter(id=>r.people.get(id).eligible);
    for(let i=ids.length-1;i>0;i--){const j=Math.floor(r.random()*(i+1));[ids[i],ids[j]]=[ids[j],ids[i]];}
    r.waitlist=ids;ids.forEach((id,i)=>{const p=r.people.get(id);p.rank=i+1;p.message=`抽签顺序第 ${i+1} 位，等待分配或递补。`;});
    this.event(r,'draw',null,`${ids.length} 位独立购票人统一随机排序；账号重复登记不增加机会。`);this.promote(r);
  }
  promote(r){
    if(!['standby','lottery'].includes(r.config.mode)||(r.config.mode==='lottery'&&!r.lotteryClosed)||!this.live(r))return;
    while(this.stock(r).available>0&&r.waitlist.length){const p=r.people.get(r.waitlist.shift());if(p?.eligible&&p.status==='waiting')this.hold(r,p,p.owner);}
  }
  async simulate(r,a){
    if(r.closed||this.round!==r||!this.live(r))return;
    const p=r.people.get(a.personId);if(['held','confirmed','refunded'].includes(p.status)||p.status==='waiting')return;
    await this.submit('query',a.accountId,r);
    if(r.closed||!this.live(r))return;
    const think=a.group==='bot'?15+r.random()*30:220+r.random()*650;
    this.schedule(r,async()=>{
      await this.submit('claim',a.accountId,r);
      if(r.closed||!this.live(r))return;
      if(r.config.mode==='standby'&&!['held','confirmed','refunded','waiting'].includes(p.status))await this.submit('waitlist',a.accountId,r);
      if(r.closed||!this.live(r)||['held','confirmed','refunded','waiting'].includes(p.status))return;
      if(a.group==='crowd'&&a.attempts>=6)return;
      const retry=a.group==='bot'?r.config.botInterval:900+r.random()*1700;
      this.schedule(r,()=>this.simulate(r,a),retry);
    },think);
  }
}
