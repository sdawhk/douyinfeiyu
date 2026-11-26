import {randomUUID} from 'node:crypto';
const OPEN=new Set(['queued','running']);
const BODY=new Set(['cabin_go','cabin_use','cabin_buy','cabin_eat','cabin_restaurant']);
const MENTAL=new Set(['chat','think','read']);
// Roles describe attention. They never grant a second body or claim that an
// external model has already thought/read/spoken. Physical completion is the
// actual game task's result; foreground queries remain nonblocking.
export class Processes{
 constructor(resident,dispatch){this.r=resident;this.dispatch=dispatch;this.rows=new Map();this.focus=null;this.busy=false;this.closed=false;this.timer=setInterval(()=>void this.pump(),200);this.timer.unref();}
 view(row){return {id:row.id,kind:row.kind,label:row.label,status:row.status,role:row.id===this.focus?'primary':'secondary',...(row.taskId?{taskId:row.taskId}:{}),...(row.error?{error:row.error}:{}),...(row.result!==undefined?{result:row.result}:{}),external:row.kind!=='body'};}
 list(){const rows=[...this.rows.values()].map(r=>this.view(r));if(this.r.task&&!rows.some(r=>r.taskId===this.r.task.id))rows.push({id:this.r.task.id,taskId:this.r.task.id,kind:'body',label:this.r.task.label,status:'running',role:!this.focus||this.focus===this.r.task.id?'primary':'secondary',external:false});return rows;}
 start(a){
  if(this.closed)throw Error('活动管理器已关闭');
  if([...this.rows.values()].filter(r=>OPEN.has(r.status)).length>=24)throw Error('最多同时保留24项活动');
  const kind=a.kind||'body';if(kind!=='body'&&!MENTAL.has(kind))throw Error('kind 为 body、chat、think 或 read');
  if(kind==='body'&&!BODY.has(a.tool))throw Error('身体活动需要有效的 cabin_go/use/buy/eat/restaurant 工具');
  if(a.role!==undefined&&!['primary','secondary'].includes(a.role))throw Error('role 为 primary 或 secondary');
  const row={id:'process-'+randomUUID(),kind,label:String(a.label||a.tool||kind).slice(0,120),tool:a.tool,args:a.arguments||{},status:kind==='body'?'queued':'running'};
  this.rows.set(row.id,row);if(!this.focus)this.focus=row.id;
  if(a.role==='primary'&&(!this.r.task||kind!=='body'))this.focus=row.id;
  for(const [id,old]of this.rows)if(this.rows.size>100&&!OPEN.has(old.status))this.rows.delete(id);
  void this.pump();return {ok:true,process:this.view(row),note:kind==='body'?'已登记，只有游戏确认后才算完成':'已登记认知/交流活动，其内容由外部AI实际执行'};
 }
 chooseFocus(){if(!this.focus||!OPEN.has(this.rows.get(this.focus)?.status))this.focus=[...this.rows.values()].find(r=>OPEN.has(r.status))?.id||this.r.task?.id||null;}
 async pump(){
  if(this.closed||this.busy||this.r.task)return;
  const queued=[...this.rows.values()].filter(r=>r.kind==='body'&&r.status==='queued');const row=queued.find(r=>r.id===this.focus)||queued[0];if(!row)return;
  this.busy=true;row.status='running';
  try{const task=await this.dispatch(row.tool,row.args);if(task?.promise){row.taskId=task.id;await task.promise;if(task.status!=='done')throw Error(task.error||'活动未完成');row.result=task.result;}else row.result=task;row.status='done';}
  catch(e){row.status='failed';row.error=e.message;}
  finally{this.busy=false;this.chooseFocus();if(!this.closed)void this.pump();}
 }
 async promote(id){
  let row=this.rows.get(id);
  if(!row&&MENTAL.has(id)){const r=this.start({kind:id,label:id});id=r.process.id;row=this.rows.get(id);}
  if(!row&&id===this.r.task?.id){this.focus=id;return {ok:true,primary:id,processes:this.list()};}
  if(!row||!OPEN.has(row.status))throw Error('只能选择仍在等待或进行的活动');
  if(row.kind==='body'&&this.r.task&&row.taskId!==this.r.task.id){
   const stopped=this.r.stop('机器人切换主要身体活动');if(!stopped.stopped)throw Error('当前活动正在提交，不能中断；主活动尚未切换');
  }
  this.focus=id;void this.pump();return {ok:true,primary:id,processes:this.list()};
 }
 stop(id,finish=false){
  const row=this.rows.get(id);if(!row&&id===this.r.task?.id)return this.r.stop('机器人自主结束',finish?'finish':'stop');
  if(!row||!OPEN.has(row.status))return {ok:false,error:'活动不存在或已经结束'};
  if(row.kind==='body'&&row.status==='running')return this.r.stop('机器人自主结束',finish?'finish':'stop');
  if(finish&&row.status==='queued')return {ok:false,error:'尚未执行的活动不能标记为完成'};
  row.status=finish?'done':'cancelled';this.chooseFocus();return {ok:true,process:this.view(row)};
 }
 async handle(a){switch(a.action||'list'){case'list':return {ok:true,primary:this.focus,processes:this.list()};case'start':return this.start(a);case'promote':return this.promote(a.id);case'stop':return this.stop(a.id);case'finish':return this.stop(a.id,true);default:throw Error('action 为 list/start/promote/stop/finish');}}
 close(){this.closed=true;clearInterval(this.timer);for(const row of this.rows.values())if(OPEN.has(row.status)){row.status='cancelled';row.error='住户或连接已关闭'}this.focus=null;}
}
