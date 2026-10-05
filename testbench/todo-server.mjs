import {createServer} from 'node:http';

// A local browser task fixture. State and the read-only oracle stay in this process.
const items=[];
const port=Number(process.env.AGENT_DESKTOP_TODO_PORT??4174);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid fixture port');
const escape=value=>String(value).replace(/[&<>"']/g,char=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
}[char]));
const server=createServer(async(request,response)=>{
  const url=new URL(request.url??'/','http://127.0.0.1');
  const blocked=url.searchParams.get('mode')==='blocked';
  const send=(code,body,type='text/html; charset=utf-8')=>{
    response.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store'});response.end(body);
  };
  if(request.method==='GET'&&url.pathname==='/__state')
    return send(200,JSON.stringify(items),'application/json; charset=utf-8');
  if(request.method==='POST'&&url.pathname==='/__reset'){
    items.length=0;return send(200,'reset','text/plain; charset=utf-8');
  }
  if(request.method==='POST'&&['/add','/toggle'].includes(url.pathname)){
    let body='';for await(const chunk of request){body+=chunk;if(body.length>2000)return send(413,'too large');}
    const data=new URLSearchParams(body);
    if(url.pathname==='/add'){
      const title=data.get('title')?.trim();
      if(title&&title.length<=100)items.push({title,completed:false});
    }else if(!blocked){
      const index=Number(data.get('index'));
      if(Number.isInteger(index)&&index>=0&&items[index])items[index].completed=true;
    }
    response.writeHead(303,{Location:blocked?'/?mode=blocked':'/','Cache-Control':'no-store'});
    response.end();return;
  }
  if(request.method!=='GET'||url.pathname!=='/')return send(404,'not found');
  send(200,`<!doctype html><html lang="zh"><meta charset="utf-8"><title>本地任务清单</title>
    <main><h1>本地任务清单</h1><form method="post" action="/add${blocked?'?mode=blocked':''}">
    <label for="title">任务</label><input id="title" name="title" required maxlength="100">
    <button type="submit">添加任务</button></form><ul>${items.map((item,index)=>
      `<li aria-label="${escape(item.title)}" class="${item.completed?'completed':''}"><form method="post" action="/toggle${blocked?'?mode=blocked':''}"><input type="hidden" name="index" value="${index}"><label><input type="checkbox" aria-label="${escape(item.title)}" ${item.completed?'checked disabled':''} ${blocked?'disabled':''} onchange="this.form.submit()">${escape(item.title)}</label></form></li>`).join('')}</ul></main></html>`);
});
server.listen(port,'127.0.0.1',()=>console.log(`Todo fixture listening on http://127.0.0.1:${port}/`));
