import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
export const defaults = { mode:'fcfs', stock:30, crowd:120, bots:12, countdown:8, duration:25, windowSeconds:3, botInterval:150, networkMs:60, jitterMs:40, seed:42, holdSeconds:6 };
const modes = new Set(['fcfs','throttled','lottery']);
const groupNames = ['crowd','bot','manual'];
let round = null;
let history = [];
let sequence = 0;
let eventSequence = 0;
const timers = new Set();
const queue = [];
let workerScheduled = false;
const clamp = (v,min,max,def) => Number.isFinite(Number(v)) ? Math.max(min,Math.min(max,Number(v))) : def;
function configOf(input={}) {
  const c = { mode:modes.has(input.mode)?input.mode:defaults.mode };
  for (const [k,min,max] of [['stock',1,200],['crowd',0,1000],['bots',0,100],['countdown',0,30],['duration',4,120],['windowSeconds',0.2,20],['botInterval',40,3000],['networkMs',0,400],['jitterMs',0,400],['seed',0,4294967295],['holdSeconds',1,10]]) c[k]=clamp(input[k],min,max,defaults[k]);
  for(const k of ['stock','crowd','bots','seed']) c[k]=Math.floor(c[k]);
  c.windowSeconds=Math.min(c.windowSeconds,c.duration);
  return c;
}
function rng(seed) { let a=seed>>>0; return () => {a+=0x6D2B79F5;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;}; }
function later(r, fn, ms) { const id=setTimeout(()=>{timers.delete(id);if(round===r)fn();},Math.max(0,ms));timers.add(id);return id; }
function clearTimers(){ for(const p of round?.pending||[])p.resolve({ok:false,message:'轮次已结束或重置。'});for(const id of timers)clearTimeout(id);timers.clear();while(queue.length)queue.shift().resolve({ok:false,message:'本轮已重置。'}); }
function event(r,type,group,message){r.events.push({id:++eventSequence,time:Date.now(),type,group,message});if(r.events.length>160)r.events.shift();}
function inventory(r){const actors=[...r.actors.values()];const held=actors.filter(a=>a.status==='held').length;const confirmed=actors.filter(a=>a.status==='confirmed').length;return {total:r.config.stock,available:r.config.stock-held-confirmed,held,confirmed};}
function actor(r,id,group){const a={id,group,status:'idle',attempts:0,lastRequest:-Infinity,orderId:null,expiresAt:null,entry:false,eligible:false,message:'等待开售',rank:null};r.actors.set(id,a);return a;}
function groups(r){return Object.fromEntries(groupNames.map(g=>{const list=[...r.actors.values()].filter(a=>a.group===g);return [g,{participants:list.length,...r.stats[g],held:list.filter(a=>a.status==='held').length,confirmed:list.filter(a=>a.status==='confirmed').length}];}));}
function sample(r){const g=groups(r);r.timeline.push({t:Math.round((Date.now()-r.saleAt)/100)/10,crowd:g.crowd.confirmed,bot:g.bot.confirmed,manual:g.manual.confirmed,requests:groupNames.reduce((n,k)=>n+g[k].requests,0)});if(r.timeline.length>300)r.timeline.shift();}
function snapshot(){
  if(!round)return {status:'idle',roundId:null,mode:defaults.mode,config:defaults,serverTime:Date.now(),saleAt:null,endsAt:null,windowEndsAt:null,stock:{total:defaults.stock,available:defaults.stock,held:0,confirmed:0},groups:Object.fromEntries(groupNames.map(g=>[g,{participants:g==='manual'?1:0,requests:0,accepted:0,limited:0,rejected:0,held:0,confirmed:0}])),manual:{status:'idle',message:'开始实验后，可亲自参与抢票。',orderId:null,expiresAt:null,rank:null},events:[],timeline:[],history,actors:[],health:{queueDepth:0,processed:0,averageProcessingMs:0,simulation:'in-process'}};
  const r=round,a=r.actors.get('manual');
  return {status:r.status,roundId:r.id,mode:r.config.mode,config:r.config,serverTime:Date.now(),saleAt:r.saleAt,endsAt:r.endsAt,windowEndsAt:r.windowEndsAt,stock:inventory(r),groups:groups(r),manual:{status:a.status,message:a.message,orderId:a.orderId,expiresAt:a.expiresAt,rank:a.rank},events:r.events,timeline:r.timeline,history,actors:[...r.actors.values()].map(a=>({id:a.id,group:a.group,status:a.status})),health:{queueDepth:queue.length,inFlight:r.inFlight,processed:r.processed,averageProcessingMs:r.processed?r.processingMs/r.processed:0,simulation:'in-process',networkModel:'每次提交在进入同一 FIFO 服务队列前采样单程延迟，处理耗时为实测。'}};
}
function summary(r){const g=groups(r),s=inventory(r),crowdRate=g.crowd.participants?g.crowd.confirmed/g.crowd.participants:0,botRate=g.bot.participants?g.bot.confirmed/g.bot.participants:0;return {roundId:r.id,mode:r.config.mode,stock:s,crowdRate,botRate,gain:crowdRate&&g.bot.participants?botRate/crowdRate:null,requests:groupNames.reduce((n,k)=>n+g[k].requests,0),groups:g,config:r.config,finishedAt:Date.now()};}
function finish(r){if(r.status==='finished')return;r.status='finished';for(const a of r.actors.values()){if(a.status==='held'){a.status='expired';a.message='本轮结束，未确认的占位已释放。';a.expiresAt=null;}else if(a.status==='waiting'){a.status='failed';a.message='本轮结束，未获得票。';}a.eligible=false;}sample(r);event(r,'finish',null,'本轮结束；停止分配，未确认占位已释放。');history.unshift(summary(r));history=history.slice(0,10);}
function stillLive(r){if(Date.now()>=r.endsAt){finish(r);return false;}return r.status==='live';}
function confirm(r,a){if(!stillLive(r))return {ok:false,message:'本轮已经结束。'};if(a.status==='confirmed')return {ok:true,message:'订单已经确认，每个身份最多一张票。'};if(a.status!=='held')return {ok:false,message:'当前没有可确认的占位。'};if(Date.now()>=a.expiresAt){release(r,a,'expired');return {ok:false,message:'占位已到期，请重新尝试。'};}a.status='confirmed';a.expiresAt=null;a.message='购票成功，订单已确认。';event(r,'confirmed',a.group,`${a.id} 确认了订单。`);return {ok:true,message:a.message};}
function hold(r,a){if(!stillLive(r)||inventory(r).available<=0)return false;a.status='held';a.orderId=`${r.id}-${++r.orders}`;a.expiresAt=Date.now()+r.config.holdSeconds*1000;a.message='已获得占位，请在倒计时结束前确认。';a.eligible=false;r.stats[a.group].accepted++;const order=a.orderId;event(r,'held',a.group,`${a.id} 获得占位。`);later(r,()=>{if(a.status==='held'&&a.orderId===order)release(r,a,'expired');},r.config.holdSeconds*1000);if(a.id!=='manual')later(r,()=>{if(a.status!=='held'||a.orderId!==order)return;if(r.random()<0.035)release(r,a,'cancelled');else confirm(r,a);},350+r.random()*950);return true;}
function promote(r){if(r.config.mode!=='lottery'||!r.lotteryClosed||!stillLive(r))return;while(inventory(r).available>0&&r.waitlist.length){const a=r.actors.get(r.waitlist.shift());if(a?.eligible&&a.status==='waiting')hold(r,a);}}
function release(r,a,reason){if(a.status!=='held'&&a.status!=='waiting')return {ok:false,message:'当前没有可取消的占位或抽签登记。'};a.status=reason==='expired'?'expired':'failed';a.eligible=false;a.expiresAt=null;a.message=reason==='expired'?'占位超时，票已释放。':'已取消，票已释放。';event(r,reason,a.group,`${a.id} ${a.message}`);promote(r);return {ok:true,message:a.message};}
function closeLottery(r){if(r.lotteryClosed||!stillLive(r))return;r.lotteryClosed=true;const ids=[...r.actors.values()].filter(a=>a.eligible&&a.status==='waiting').map(a=>a.id);for(let i=ids.length-1;i>0;i--){const j=Math.floor(r.random()*(i+1));[ids[i],ids[j]]=[ids[j],ids[i]];}r.waitlist=ids;ids.forEach((id,i)=>{const a=r.actors.get(id);a.rank=i+1;a.message=`抽签顺序第 ${i+1} 位，等待分配或递补。`;});event(r,'draw',null,`抽签窗口关闭，${ids.length} 个有效身份参与统一随机排序。`);promote(r);}
function processClaim(r,a){
  if(round!==r)return {ok:false,message:'轮次已改变。'};
  const now=Date.now();r.stats[a.group].requests++;a.attempts++;
  if(now<r.saleAt){r.stats[a.group].rejected++;a.message='尚未开售，请等待倒计时结束后点击。';return {ok:false,message:a.message};}
  if(!stillLive(r)){r.stats[a.group].rejected++;return {ok:false,message:'本轮已结束。'};}
  if(a.status==='confirmed'||a.status==='held')return {ok:true,message:a.status==='confirmed'?'此身份已购票成功。':'已有占位，请及时确认。'};
  if(r.config.mode==='throttled'&&now-a.lastRequest<800){r.stats[a.group].limited++;a.message='请求过快：同一身份至少间隔 800 毫秒。';return {ok:false,message:a.message};}a.lastRequest=now;
  if(r.config.mode==='lottery'){
    if(now>=r.windowEndsAt){closeLottery(r);if(a.status==='held')return {ok:true,message:a.message};if(!a.entry){r.stats[a.group].rejected++;a.status='failed';a.message='抽签登记窗口已经关闭。';return {ok:false,message:a.message};}}
    if(a.entry)return {ok:a.status==='waiting',message:a.message};
    a.entry=true;a.eligible=true;a.status='waiting';a.message='登记成功；每个身份仅有一个抽签名额，重复请求不增加机会。';event(r,'entry',a.group,`${a.id} 登记抽签。`);return {ok:true,message:a.message};
  }
  if(hold(r,a))return {ok:true,message:a.message};
  r.stats[a.group].rejected++;a.status='failed';a.message='当前无余票，可等待占位释放后重试。';return {ok:false,message:a.message};
}
function work(){workerScheduled=false;const job=queue.shift();if(!job)return;const begin=performance.now();const result=processClaim(job.r,job.a);job.r.processed++;job.r.processingMs+=performance.now()-begin;job.resolve(result);if(queue.length){workerScheduled=true;setImmediate(work);}}
function submit(r,a){return new Promise(resolve=>{if(round!==r){resolve({ok:false,message:'轮次已改变。'});return;}r.inFlight++;const delay=Math.max(0,r.config.networkMs+(r.random()*2-1)*r.config.jitterMs);const id=setTimeout(()=>{timers.delete(id);r.inFlight--;if(round!==r){resolve({ok:false,message:'轮次已改变。'});return;}queue.push({r,a,resolve});if(!workerScheduled){workerScheduled=true;setImmediate(work);}},delay);timers.add(id);r.pending.push({id,resolve});});}
function simAttempt(r,a,max,interval){if(round!==r||Date.now()>=r.endsAt||a.status==='confirmed'||a.status==='held'||(r.config.mode==='lottery'&&a.entry))return;submit(r,a).then(()=>{if(round!==r||a.attempts>=max||a.status==='held'||a.status==='confirmed'||(r.config.mode==='lottery'&&a.entry))return;later(r,()=>simAttempt(r,a,max,interval),interval());});}
function start(input){if(round&&['countdown','live'].includes(round.status))return {ok:false,message:'本轮仍在运行，请先重置。'};clearTimers();const config=configOf(input);const now=Date.now(),r={id:`R${++sequence}`,config,status:config.countdown?'countdown':'live',saleAt:now+config.countdown*1000,endsAt:now+(config.countdown+config.duration)*1000,windowEndsAt:now+(config.countdown+config.windowSeconds)*1000,random:rng(config.seed),actors:new Map(),stats:Object.fromEntries(groupNames.map(g=>[g,{requests:0,accepted:0,limited:0,rejected:0}])),events:[],timeline:[],waitlist:[],lotteryClosed:false,orders:0,inFlight:0,processed:0,processingMs:0,pending:[]};round=r;actor(r,'manual','manual');for(let i=1;i<=config.crowd;i++)actor(r,`crowd-${i}`,'crowd');for(let i=1;i<=config.bots;i++)actor(r,`bot-${i}`,'bot');event(r,'start',null,`已创建本轮，${config.stock} 张票由所有身份共同竞争。`);later(r,()=>{r.status='live';event(r,'sale',null,'已开售，所有请求进入同一服务队列。');},config.countdown*1000);later(r,()=>finish(r), (config.countdown+config.duration)*1000);if(config.mode==='lottery')later(r,()=>closeLottery(r),(config.countdown+config.windowSeconds)*1000);for(const a of r.actors.values()){if(a.group==='manual')continue;const first=a.group==='bot'?r.random()*65:300+r.random()*2200+(r.random()<0.16?r.random()*Math.min(8000,config.duration*600):0);later(r,()=>simAttempt(r,a,a.group==='bot'?Math.ceil(config.duration*1000/config.botInterval)+1:6,a.group==='bot'?()=>config.botInterval:()=>900+r.random()*1700),config.countdown*1000+first);}const tick=()=>{sample(r);if(r.status!=='finished')later(r,tick,500);};tick();return {ok:true,message:'实验已开始。'};}
function reset(){if(round){for(const p of round.pending)p.resolve({ok:false,message:'本轮已重置。'});}clearTimers();round=null;return {ok:true,message:'实验已重置，历史保留。'};}
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.png':'image/png'};
function json(res,data,status=200){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>32768)throw new Error('请求体过大。');}return text?JSON.parse(text):{};}
export function createServer(){return http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://127.0.0.1');if(url.pathname.startsWith('/api/')){
  if(req.method==='GET'&&url.pathname==='/api/state')return json(res,snapshot());
  if(req.method==='GET'&&url.pathname==='/api/export'){res.setHeader('content-disposition',`attachment; filename="ticket-lab-${round?.id||'idle'}.json"`);return json(res,{exportedAt:new Date().toISOString(),methodology:'本机进程内模拟；网络延迟在进入统一 FIFO 队列前采样；实际处理耗时实测。固定种子只控制随机采样，操作系统调度与真人操作使实际结果并非精确可复现。',...snapshot()});}
  if(req.method!=='POST')return json(res,{ok:false,message:'接口不存在。'},404);
  const input=await body(req);let result;
  if(url.pathname==='/api/start')result=start(input.config||input);
  else if(url.pathname==='/api/reset')result=reset();
  else if(url.pathname.startsWith('/api/manual/')){if(!round)result={ok:false,message:'请先开始实验。'};else{const r=round,a=r.actors.get('manual');if(url.pathname==='/api/manual/claim')result=await submit(r,a);else if(url.pathname==='/api/manual/confirm')result=confirm(r,a);else if(url.pathname==='/api/manual/cancel')result=release(r,a,'cancelled');else return json(res,{ok:false,message:'接口不存在。'},404);}}
  else return json(res,{ok:false,message:'接口不存在。'},404);
  return json(res,{...result,state:snapshot()});
}if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end();}let name=decodeURIComponent(url.pathname);if(name==='/')name='/index.html';const publicRoot=path.join(root,'public');const target=path.resolve(publicRoot,`.${name}`);if(target!==publicRoot&&!target.startsWith(publicRoot+path.sep)){res.writeHead(403);return res.end();}try{const content=await readFile(target);res.writeHead(200,{'content-type':types[path.extname(target)]||'application/octet-stream','cache-control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);}catch{res.writeHead(404);res.end('Not found');}}catch(error){json(res,{ok:false,message:error instanceof SyntaxError?'请求 JSON 格式无效。':error.message},400);}});}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const port=Number(process.env.PORT)||3186;createServer().listen(port,'127.0.0.1',()=>console.log(`Ticket Lab: http://127.0.0.1:${port}`));}
