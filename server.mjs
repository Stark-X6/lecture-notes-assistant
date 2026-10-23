import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TicketEngine, defaults } from './engine.mjs';

export { defaults };
const root=path.dirname(fileURLToPath(import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.png':'image/png'};
const manualOperations=new Set(['query','claim','waitlist','confirm','cancel','refund']);
function json(res,data,status=200){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>32768)throw new Error('请求体过大。');}return text?JSON.parse(text):{};}

export function createServer({engine=new TicketEngine()}={}){
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://127.0.0.1');
      if(url.pathname.startsWith('/api/')){
        if(req.method==='GET'&&url.pathname==='/api/state')return json(res,engine.snapshot());
        if(req.method==='GET'&&url.pathname==='/api/export'){
          const state=engine.snapshot();res.setHeader('content-disposition',`attachment; filename="ticket-lab-${state.roundId||'idle'}.json"`);
          return json(res,{exportedAt:new Date().toISOString(),methodology:'本机进程内简化实验。查询快照不预留库存；独立购票人去重；所有请求先采样单程网络延迟，再进入有限并发服务队列，FIFO 开始服务，并发与有限慢处理可能改变完成顺序；在完成处理时检查库存并分配，不能理解为严格按网络到达顺序获票。serviceMs 为模拟服务耗时，业务处理耗时另实测。保护仅使用账号、购票人和设备频率，分组仅事后统计，不代表真实平台算法。固定种子只控制随机采样，实际操作与系统调度并非精确可复现。未支付取消/超时立即释放；已支付退票进入 returned，按 resaleDelay 批次延迟返售。模拟付款延迟 paymentDelayMs±250ms，paymentAbandonRate 为不付款概率；每次模拟确认后以 refundRate 概率在800–2400ms后申请一次退票。',...state});
        }
        if(req.method!=='POST')return json(res,{ok:false,message:'接口不存在。'},404);
        const input=await body(req);let result;
        if(url.pathname==='/api/start')result=engine.start(input.config||input);
        else if(url.pathname==='/api/reset')result=engine.reset();
        else if(url.pathname.startsWith('/api/manual/')){
          const operation=url.pathname.slice('/api/manual/'.length);
          if(!manualOperations.has(operation))return json(res,{ok:false,message:'接口不存在。'},404);
          result=await engine.submit(operation);
        } else return json(res,{ok:false,message:'接口不存在。'},404);
        return json(res,{...result,state:engine.snapshot()});
      }
      if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end();}
      let name=decodeURIComponent(url.pathname);if(name==='/')name='/index.html';
      const publicRoot=path.join(root,'public'),target=path.resolve(publicRoot,`.${name}`);
      if(target!==publicRoot&&!target.startsWith(publicRoot+path.sep)){res.writeHead(403);return res.end();}
      try {const content=await readFile(target);res.writeHead(200,{'content-type':types[path.extname(target)]||'application/octet-stream','cache-control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);}
      catch {res.writeHead(404);res.end('Not found');}
    } catch(error){json(res,{ok:false,message:error instanceof SyntaxError?'请求 JSON 格式无效。':error.message},400);}
  });
  server.on('close',()=>engine.reset());
  return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT)||3186;
  createServer().listen(port,'127.0.0.1',()=>console.log(`Ticket Lab: http://127.0.0.1:${port}`));
}
