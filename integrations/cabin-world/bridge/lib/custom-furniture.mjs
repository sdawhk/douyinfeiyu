import {randomUUID} from 'node:crypto';

/** Uploaded images and named operations, never user scripts or arbitrary URLs. */
export class CustomFurniture {
  constructor(host, event) { this.host=host; this.event=event; this.pending=new Map(); }
  async list(r) {
    const reply=await r.scope.request('furniture.do',{action:'list'},{replyType:'furniture.result'});
    return reply.result.objects;
  }
  async upload(spec, images) {
    if(!spec||typeof spec!=='object'||!images||typeof images!=='object'||Array.isArray(images))throw Error('缺少家具配置与PNG图片');
    if(Object.keys(images).length>132)throw Error('图片过多');
    let total=0;
    for(const [key,value] of Object.entries(images)){
      if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(key)||typeof value!=='string'||value.length>5600000||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw Error('图片必须是PNG的base64数据');
      total+=Buffer.byteLength(value,'base64');
    }
    if(total>24*1024*1024)throw Error('图片合计超过24MB');
    return this.host.request('furniture.do',{action:'import',spec,images},{replyType:'furniture.result',timeoutMs:30000});
  }
  complete(actor,requestId,ok,result) {
    const p=this.pending.get(requestId);
    if(!p||p.actor!==actor)throw Error('这个功能请求不存在、已结束或不属于该机器人');
    if(typeof ok!=='boolean'||typeof result!=='string'||!result.trim()||result.length>2000)throw Error('请提交明确的成功/失败及1–2000字真实结果');
    this.pending.delete(requestId);
    if(ok)p.resolve(result);else p.reject(Error(result));
    return {ok:true,requestId};
  }
  external(r,object,use) {
    const requestId=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(reject,Error('外部功能120秒未返回结果，未确认完成')),120000);timer.unref();
      const lost=()=>finish(reject,Error('游戏断开，外部功能未确认完成'));
      const finish=(fn,value)=>{clearTimeout(timer);this.host.off('disconnected',lost);this.pending.delete(requestId);fn(value);};
      this.pending.set(requestId,{actor:r.key,taskId:r.task.id,resolve:v=>finish(resolve,v),reject:e=>finish(reject,e)});
      this.host.once('disconnected',lost);
      this.event({type:'furniture.request',actor:r.key,requestId,taskId:r.task.id,object:object.id,use:use.id,name:use.label,description:use.description});
    });
  }
  use(r,id,useId) {
    return r.startTask('furniture','使用自制家具',async()=>{
      let guard;
      const taskId=r.task.id;
      try{
        const object=(await this.list(r)).find(o=>o.id===id);
        if(!object)throw Error('家具不在当前可访问房间，或已被收起');
        const use=object.uses.find(u=>u.id===useId);
        if(!use)throw Error('这是装饰家具，或还没配置这位机器人的对应动作图');
        r.task.label=use.label;r.publish();
        await r.walkTo(object.scene,object.zone);
        const current=(await this.list(r)).find(o=>o.id===id);
        if(!current||current.asset!==object.asset||current.revision!==object.revision)throw Error('家具布置已变化，请重新选择');
        let checking=false;
        guard=setInterval(async()=>{
          if(checking||!r.current)return;checking=true;
          try{const now=(await this.list(r)).find(o=>o.id===id);if(!now||now.revision!==object.revision)r.current?.interrupt('家具布置已变化，动作中断');}
          catch{r.current?.interrupt('无法确认家具位置，动作中断');}finally{checking=false;}
        },1000);guard.unref();
        return await r.runAction('furniture',use.label,[
          {id:'perform',ms:use.seconds*1000,run:()=>r.setEffect({kind:'custom_furniture',module:object.module,zone:object.zone,use:use.id,label:use.label,seconds:use.seconds+125})},
          {id:'result',run:async()=>{
            const detail=use.mode==='external'?await this.external(r,object,use):'已播放「'+use.label+'」配置动作';
            return {ok:true,object:id,use:useId,mode:use.mode,happened:[detail],note:use.mode==='activity'?'只确认配置动作，不代表完成外部读写或设备操作':undefined};
          }}
        ]);
      }finally{
        clearInterval(guard);
        for(const [request,p] of this.pending)if(p.taskId===taskId){this.pending.delete(request);p.reject(Error('家具动作已结束，未确认外部结果'));}
      }
    });
  }
}
