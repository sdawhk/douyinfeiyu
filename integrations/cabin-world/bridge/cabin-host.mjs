// Optional Node.js adapter for an existing bot application. No VADS dependency,
// model calls, QQ login, resident memory or world rules are implemented here.
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';

const MAX_LINE=1024*1024;
export class CabinHost extends EventEmitter {
  constructor({dataDir,name='外部机器人',clock=Date.now,onPanelGet=null,onPanelDo=null,audioSettings=false}={}){
    super();
    if(!dataDir)throw Error('dataDir is required');
    this.dataDir=path.resolve(dataDir);this.name=String(name).slice(0,40);
    this.clock=clock;this.onPanelGet=onPanelGet;this.onPanelDo=onPanelDo;this.audioSettings=audioSettings;
    this.pending=new Map();this.sockets=new Set();this.socket=null;this.server=null;this.token='';this.timer=null;this.discoveryOwned=false;
  }
  get connected(){return Boolean(this.socket&&!this.socket.destroyed);}
  async start(){
    if(this.server)throw Error('Host already started');
    this.file=path.join(this.dataDir,'world','game-link.json');
    await fs.mkdir(path.dirname(this.file),{recursive:true});
    this.token=randomBytes(32).toString('hex');
    const server=net.createServer(socket=>this.accept(socket));this.server=server;
    try{
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
      server.on('error',error=>this.emit('hostError',error));
      // Never overwrite another host's discovery file, even if it looks stale.
      await fs.writeFile(this.file,JSON.stringify({port:server.address().port,token:this.token,at:this.clock()})+'\n',{flag:'wx',mode:0o600});
      this.discoveryOwned=true;this.lastClock=0;
      this.timer=setInterval(()=>{
        if(!this.connected)return;
        if(Date.now()-this.heard>9000){this.socket.destroy();return;}
        if(Date.now()-this.lastClock>=15000)this.sendClock();
      },1000);this.timer.unref();
      return this;
    }catch(error){await this.close();throw error;}
  }
  accept(socket){
    this.sockets.add(socket);let buffer=Buffer.alloc(0),authed=false;
    const timeout=setTimeout(()=>socket.destroy(),3000);timeout.unref();
    socket.on('error',()=>{});
    socket.on('close',()=>{
      clearTimeout(timeout);this.sockets.delete(socket);
      if(this.socket!==socket)return;
      this.socket=null;
      for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(Error('Game disconnected; outcome not confirmed'));}
      this.pending.clear();this.emit('disconnected');
    });
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      for(;;){
        const end=buffer.indexOf(10);if(end<0){if(buffer.length>MAX_LINE)socket.destroy();return;}
        if(end>MAX_LINE){socket.destroy();return;}
        const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);
        let frame;try{frame=JSON.parse(line.toString('utf8'));}catch{socket.destroy();return;}
        if(!frame||Array.isArray(frame)||typeof frame!=='object'||typeof frame.type!=='string'){socket.destroy();return;}
        if(!authed){
          const supplied=Buffer.from(typeof frame.token==='string'?frame.token:'');const expected=Buffer.from(this.token);
          if(frame.type!=='hello'||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)||this.connected){socket.destroy();return;}
          authed=true;clearTimeout(timeout);this.socket=socket;this.heard=Date.now();
          this.send({type:'welcome',residents:true,bodySave:1,social:1,host:{name:this.name,audioSettings:this.audioSettings}});
          this.sendClock();
          const {token,...capabilities}=frame; // Never expose the session token to application logs/hooks.
          this.emit('connected',capabilities);continue;
        }
        this.heard=Date.now();
        if(frame.type==='ping'){this.send({type:'pong'});continue;}
        if(frame.type==='panel.get'||frame.type==='panel.do'){void this.panel(frame,socket);continue;}
        const item=this.pending.get(frame.id);
        if(item&&item.replyType===frame.type){
          this.pending.delete(frame.id);clearTimeout(item.timer);
          if(frame.ok===false||frame.denied===true||frame.replaced===true){const error=Error(frame.error||'Game action refused or replaced');error.frame=frame;item.reject(error);}else item.resolve(frame);
        }
        this.emit('frame',frame);
      }
    });
  }
  send(frame){
    if(!this.connected)throw Error('Game is not connected');
    const line=JSON.stringify(frame)+'\n';if(Buffer.byteLength(line)>MAX_LINE)throw Error('Frame exceeds 1 MiB');
    this.socket.write(line);
  }
  sendClock(){this.send({type:'clock',now:this.clock()});this.lastClock=Date.now();}
  forResident(actor){
    if(typeof actor!=='string'||!actor.trim())throw Error('Resident key is required');
    return Object.freeze({actor,request:async(type,fields={},options={})=>{
      if(Object.hasOwn(fields,'actor')&&fields.actor!==actor)throw Error('Cannot act as another resident');
      const result=await this.request(type,{...fields,actor},options);
      if(result.actor!==undefined&&result.actor!==actor)throw Error('Reply belongs to another resident');
      return {actor,result};
    }});
  }
  request(type,fields={}, {replyType,timeoutMs=15000}={}){
    if(!replyType)return Promise.reject(Error('replyType is required'));
    if(!this.connected)return Promise.reject(Error('Game is not connected'));
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Game request timed out; outcome unknown, reconcile before retrying'));},timeoutMs);timer.unref();
      this.pending.set(id,{replyType,resolve,reject,timer});
      try{this.send({...fields,type,id});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  async panel(frame,socket){
    const isRead=frame.type==='panel.get',handler=isRead?this.onPanelGet:this.onPanelDo;
    let result;
    try{result=handler?await handler(frame):{ok:false,error:'机器人软件尚未实现此面板接口'};}
    catch{result={ok:false,error:'机器人软件的面板接口调用失败'};}
    // A late callback from a prior connection must not leak into the next session.
    if(this.socket!==socket||!this.connected)return;
    // The game routes replies by panel (and who/photo for albums); echo them back.
    this.send({...result,type:isRead?'panel.data':'panel.did',id:frame.id,...(isRead?{panel:frame.panel,who:frame.who,...(frame.photo!==undefined?{photo:frame.photo}:{})}:{action:frame.action,who:frame.who})});
  }
  async close({quitGame=false}={}){
    clearInterval(this.timer);this.timer=null;
    if(quitGame&&this.connected)this.send({type:'quit'});
    for(const socket of this.sockets)socket.destroy();
    for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(Error('Host closed; outcome not confirmed'));}this.pending.clear();
    if(this.server){const server=this.server;this.server=null;await new Promise(resolve=>server.close(resolve));}
    if(this.discoveryOwned){
      let row;try{row=JSON.parse(await fs.readFile(this.file,'utf8'));}catch{}
      if(row?.token===this.token)await fs.unlink(this.file);
    }
    this.discoveryOwned=false;this.socket=null;
  }
}
