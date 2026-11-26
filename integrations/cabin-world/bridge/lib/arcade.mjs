import { randomUUID } from 'node:crypto';

const NAMES = { snake:'贪吃蛇', mines:'扫雷', blocks:'俄罗斯方块', xiangqi:'象棋',gomoku:'五子棋' };
export {NAMES as ARCADE_NAMES};
const LIMIT = { snake:240000, mines:180000, blocks:300000, xiangqi:600000,gomoku:600000 };
// One shared hall for all residents. Boards, moves and rewards remain game-owned;
// the bridge only reserves seats and advances the authoritative protocol clock.
export class Arcade {
  constructor(host) {
    this.host=host; this.sessions=new Map(); this.history=[];
    host.on('frame', f => { if(f.type==='arcade.pulse') void this.pulse(f).catch(e=>this.interrupt(this.sessions.get(f.key),e.message)); });
    host.on('disconnected',()=>{ for(const s of this.sessions.values()) this.interrupt(s,'游戏连接中断，本局不算输赢'); });
  }
  async rule(rule,args) { return (await this.host.request('rules.ask',{rule,args},{replyType:'rules.answer',timeoutMs:30000})).value; }
  key(object,resident) { return object.id.startsWith('home_chess') ? (object.arcadeBoard || resident.homeBoard || 'xiangqi@xjhome') : object.id==='arcade_blocks_2'?'blocks@second':object.id.replace('arcade_',''); }
  view() {
    if(!this.host.connected)return;
    const sessions={};
    for(const [key,s] of this.sessions) sessions[key]={key,cabinetKey:key,passerby:s.board?.players?.includes('computer')||s.board?.sides?.includes('computer')||false,matchId:s.id,kind:s.kind,name:NAMES[s.kind],status:s.status,game:s.board||null,players:s.members.map(m=>({id:m.r.key,name:m.r.name,seat:m.seat})),reason:s.reason||'',startedAt:s.startedAt||0,endedAt:s.endedAt||0};
    this.host.send({type:'arcade.view',sessions,history:this.history,rules:{blocks:'消除30行获胜',snake:'双人或电脑对手',mines:'9×9，10颗雷',xiangqi:'按象棋合法走法轮流落子',gomoku:'15×15，黑先白后，五子连珠获胜，无禁手'}});
  }
  watch(s) { if(this.host.connected)this.host.send({type:'arcade.watch',key:s.key,matchId:s.id,kind:s.kind,status:s.status,board:s.board||null,startedAt:s.startedAt||0}); this.view(); }
  interrupt(s,reason) {
    if(!s||!['waiting','playing'].includes(s.status))return false;
    s.status='interrupted';s.reason=reason;s.endedAt=Date.now();clearTimeout(s.timer);
    for(const m of s.members) { m.r.effect=null; m.reject(Error(reason)); }
    this.watch(s);return true;
  }
  quit(resident) { const s=[...this.sessions.values()].find(s=>['waiting','playing'].includes(s.status)&&s.members.some(m=>m.r===resident)); this.interrupt(s,'主动退出，本局不算输赢'); return {ok:true,stopped:!!s}; }
  play(r,object,mode='solo',variant='') {
    if(r.task)throw Object.assign(Error('正在'+r.task.label+'，请先完成或叫停'),{code:'busy'});
    if(!['solo','npc','duo','join'].includes(mode))throw Error('模式只能是 npc（电脑对手）、solo（单住户）、duo（等另一位住户）或 join（加入住户）');
    let key=this.key(object,r);if(variant==='gomoku')key=key.replace(/^xiangqi/,'gomoku');const kind=key.split('@')[0];
    for(const other of this.sessions.values())if(['waiting','playing'].includes(other.status)&&other.key!==key&&other.key.replace(/^gomoku/,'xiangqi')===key.replace(/^gomoku/,'xiangqi'))throw Error('这张棋桌正在下另一种棋');
    if(!NAMES[kind])throw Error('没有这个机台');
    if(mode==='npc') {
      if(!['snake','xiangqi','gomoku'].includes(kind))throw Error('这台机子是单人游戏，使用 solo');
      mode='solo'; // One resident; the game adds the computer opponent.
    }
    if(/^(xiangqi|gomoku)@/.test(key)&&mode==='solo')throw Error('家中棋盘需要两位住户，使用 duo 开桌、join 入座');
    if(key==='blocks'&&['waiting','playing'].includes(this.sessions.get(key)?.status)&&!['waiting','playing'].includes(this.sessions.get('blocks@second')?.status)){key='blocks@second';object={...object,zone:'arcade_blocks_2'};}
    let s=this.sessions.get(key);
    if(s&&['waiting','playing'].includes(s.status)) {
      if(mode!=='join'||s.status!=='waiting'||s.mode==='solo'||!['snake','xiangqi','gomoku'].includes(kind)||s.members.length>=2)throw Error('这台机子正在使用；加入等待中的住户对局请明确使用 join，电脑对战请等机台空闲');
    } else {
      if(mode==='join')throw Error('这台机子还没有等待中的对局');
      if(mode==='duo'&&!['snake','xiangqi','gomoku'].includes(kind))throw Error('这台机子是单人游戏');
      s={key,kind,id:randomUUID(),mode,status:'waiting',createdAt:Date.now(),members:[],busy:false};
      this.sessions.set(key,s);
      s.timer=setTimeout(()=>this.interrupt(s,'等待入座超时，本局没有开始'),120000);s.timer.unref?.();
    }
    const session=s;
    return r.startTask('arcade','玩'+NAMES[kind],async()=>{
      const seat=session.members.length;
      const zone=/^(xiangqi|gomoku)@/.test(key)?(object.arcadeSeats||r.homeSeats||['chess_xj_a','chess_xj_b'])[seat]:kind==='snake'?['arcade_snake_left','arcade_snake_right'][seat]:['xiangqi','gomoku'].includes(kind)?['arcade_xiangqi_far','arcade_xiangqi_near'][seat]:object.zone;
      let member;
      const ended=new Promise((resolve,reject)=>{member={r,seat,zone,scene:r.spaces.get(object.space).scene,seated:false,resolve,reject};});
      ended.catch(()=>{}); // a timeout may arrive while walking
      session.members.push(member);
      r.current={interrupt:()=>this.interrupt(session,'活动被打断，本局不算输赢')};
      this.watch(session);
      try {
        await r.walkTo(member.scene,zone);
        if(session.status!=='waiting')throw Error(session.reason||'本局已结束');
        member.seated=true;
        r.setEffect({kind:/^(xiangqi|gomoku)@/.test(key)?'chess':'typing',module:object.id,zone,use:'play',label:'玩'+NAMES[kind],seconds:900});
        await this.pulse({key,matchId:session.id});
        return await ended;
      } catch(e) {this.interrupt(session,e.message);throw e;}
      finally {r.current=null;r.effect=null;r.publish();}
    });
  }
  async pulse(f) {
    const s=this.sessions.get(f.key);
    if(!s||s.id!==f.matchId||s.busy||!['waiting','playing'].includes(s.status))return;
    s.busy=true;
    try {
      const members=[...s.members];
      if(!members.length||members.some(m=>!m.seated))return;
      for(const m of members) {
        const valid=await this.rule('residentAt',{actor:m.r.key,scene:m.scene,zone:m.zone});
        if(!['waiting','playing'].includes(s.status))return;
        // A join can happen while the game is answering. Validate the complete
        // new seating group on the next pulse, never a newcomer still walking.
        if(s.members.length!==members.length||s.members.some(m=>!m.seated))return;
        if(!valid){this.interrupt(s,'住户离开座位，本局不算输赢');return;}
      }
      if(s.status==='waiting') {
        if(s.mode!=='solo'&&s.members.length<2)return;
        const a=await this.rule('arcadeLobby',{kind:s.kind,seed:Date.now()%2147483647,now:Date.now(),createdAt:s.createdAt,seatedAt:Date.now(),invited:false,invitedAt:0,atHome:/^(xiangqi|gomoku)@/.test(s.key),members:s.members.map(m=>({id:m.r.key,name:m.r.name,seat:m.seat,seated:true,valid:true,skill:.68}))});
        if(s.status!=='waiting')return;
        if(a.action!=='start')throw Error(a.reason||'无法开局');
        s.board=a.board;s.status='playing';s.startedAt=Date.now();clearTimeout(s.timer);
        s.timer=setTimeout(()=>this.interrupt(s,'对局响应超时，未确认结果'),LIMIT[s.kind]+45000);s.timer.unref?.();this.watch(s);return;
      }
      const board=await this.rule('arcadeAuto',{key:s.key,matchId:s.id,board:s.board,at:Date.now()});
      if(s.status!=='playing')return;
      s.board=board;
      if(board.status==='playing'){this.view();return;}
      s.status='settling';clearTimeout(s.timer);
      const players=s.members.map(m=>({id:m.r.key,name:m.r.name,result:board.status==='draw'?'draw':board.winner===m.r.key?'won':'lost'}));
      const record={matchId:s.id,kind:s.kind,at:Date.now(),players,reason:board.reason,score:board.score||0};
      const saved=await this.host.request('arcade.records',{history:[record]},{replyType:'arcade.history'});this.history=saved.history;
      for(const m of s.members) {
        const result=players.find(p=>p.id===m.r.key).result;
        const notes=await m.r.lifeEvent({type:'arcade',matchId:s.id,kind:s.kind,name:NAMES[s.kind],result,score:board.score||0});
        m.resolve({ok:true,matchId:s.id,result,reason:board.reason,happened:notes,...m.r.summary()});
      }
      s.status=board.status;s.endedAt=Date.now();this.watch(s);
    } catch(e) {
      if(s.status==='settling'){s.status='interrupted';s.reason='结算未全部确认，请查看游戏账本，勿重复计分';for(const m of s.members)m.reject(Error(s.reason));this.watch(s);}
      else this.interrupt(s,e.message);
    } finally {s.busy=false;}
  }
}
