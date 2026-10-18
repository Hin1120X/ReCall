import {randomUUID} from 'node:crypto';
import type {Store} from './store.ts';
import type {Reminder} from './shared.ts';

export class Reminders {
  error='';
  private store:Store;
  constructor(store:Store){this.store=store;}
  sync(){
    const items=this.store.items(),wanted=new Set<string>();
    this.store.db.exec('BEGIN IMMEDIATE');
    try{
      for(const item of items)if(item.state!=='done')for(const kind of ['reminder','deadline'] as const){
        const dueAt=item[kind];if(!dueAt)continue;
        wanted.add(JSON.stringify([item.id,kind,dueAt]));
        this.store.db.prepare("INSERT INTO reminders(id,itemId,kind,dueAt,scheduledAt,state) VALUES(?,?,?,?,?,'pending') ON CONFLICT(itemId,kind,dueAt) DO UPDATE SET state=CASE WHEN reminders.sentAt IS NULL THEN 'pending' ELSE 'sent' END WHERE reminders.state='cancelled'").run(randomUUID(),item.id,kind,dueAt,dueAt);
      }
      for(const row of this.store.db.prepare("SELECT id,itemId,kind,dueAt FROM reminders WHERE state IN ('pending','sent')").all() as {id:string;itemId:string;kind:string;dueAt:string}[])if(!wanted.has(JSON.stringify([row.itemId,row.kind,row.dueAt])))this.store.db.prepare("UPDATE reminders SET state='cancelled' WHERE id=?").run(row.id);
      this.store.db.exec('COMMIT');
    }catch(error){this.store.db.exec('ROLLBACK');throw error;}
  }
  list(now=Date.now()):Reminder[]{
    this.sync();
    return this.store.db.prepare("SELECT r.id,r.itemId,r.kind,r.dueAt,r.scheduledAt,r.state,i.text FROM reminders r JOIN items i ON i.id=r.itemId WHERE r.state IN ('pending','sent') AND r.scheduledAt<=? ORDER BY r.scheduledAt,r.id").all(new Date(now).toISOString()) as Reminder[];
  }
  tick(notify:(rows:Reminder[],failed:(message:string)=>void)=>void,now=Date.now()){
    const rows=this.list(now).filter(row=>row.state==='pending');if(!rows.length)return;
    // 发出状态先落盘；系统屏蔽横幅时，未处理提醒仍留在工作台。
    for(const row of rows)this.store.db.prepare("UPDATE reminders SET state='sent',sentAt=? WHERE id=? AND state='pending'").run(new Date(now).toISOString(),row.id);
    this.error='';
    try{notify(rows,message=>{this.error=message;});}catch(error){this.error=String(error);}
  }
  handle(id:string,minutes:number|null,now=Date.now()){
    if(typeof id!=='string'||(minutes!==null&&![10,30,60,1440].includes(minutes)))throw new Error('提醒操作无效');
    this.sync();
    if(!this.store.db.prepare("SELECT id FROM reminders WHERE id=? AND state IN ('pending','sent')").get(id))throw new Error('提醒已变化，请刷新');
    if(minutes===null)this.store.db.prepare("UPDATE reminders SET state='done' WHERE id=?").run(id);
    else this.store.db.prepare("UPDATE reminders SET state='pending',scheduledAt=?,sentAt=NULL WHERE id=?").run(new Date(now+minutes*60000).toISOString(),id);
  }
}
