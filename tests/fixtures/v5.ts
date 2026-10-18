import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// 独立定义已发布的v5结构，防止用当前Store建库再改版本掩盖迁移遗漏。
export function createV5Fixture(directory:string){
  if(existsSync(join(directory,'recall.sqlite')))throw new Error('样例目标已有数据库，未覆盖');
  mkdirSync(join(directory,'attachments'),{recursive:true});mkdirSync(join(directory,'draft-files'),{recursive:true});
  writeFileSync(join(directory,'attachments','input.txt'),'无敏感样例输入材料');
  writeFileSync(join(directory,'attachments','record.txt'),'无敏感样例记录附件');
  writeFileSync(join(directory,'draft-files','22222222-2222-4222-8222-222222222222'),'无敏感未提交附件');
  writeFileSync(join(directory,'release-state.json'),JSON.stringify({version:'0.3.0',schema:5}));
  writeFileSync(join(directory,'opencode-settings.json'),JSON.stringify({executable:'',model:''}));
  const db=new DatabaseSync(join(directory,'recall.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    BEGIN IMMEDIATE;
    CREATE TABLE items(id TEXT PRIMARY KEY,text TEXT NOT NULL,quadrant INTEGER,reminder TEXT,deadline TEXT,folder TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,lastProgressAt TEXT,state TEXT NOT NULL DEFAULT 'ready',inbox INTEGER NOT NULL DEFAULT 1,nextStep TEXT NOT NULL DEFAULT '',resumeNote TEXT NOT NULL DEFAULT '',waitingFor TEXT NOT NULL DEFAULT '',completedAt TEXT,extra TEXT NOT NULL DEFAULT '{"version":1,"fields":{}}');
    CREATE TABLE notes(id TEXT PRIMARY KEY,itemId TEXT NOT NULL REFERENCES items(id),kind TEXT NOT NULL,text TEXT NOT NULL,createdAt TEXT NOT NULL,extra TEXT NOT NULL DEFAULT '{"version":1,"fields":{}}');
    CREATE TABLE attachments(id TEXT PRIMARY KEY,itemId TEXT NOT NULL REFERENCES items(id),name TEXT NOT NULL,path TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'input',noteId TEXT REFERENCES notes(id));
    CREATE TABLE analyses(id TEXT PRIMARY KEY,itemId TEXT REFERENCES items(id),kind TEXT NOT NULL,state TEXT NOT NULL,output TEXT NOT NULL,error TEXT NOT NULL,model TEXT NOT NULL,version TEXT NOT NULL,fingerprint TEXT NOT NULL,createdAt TEXT NOT NULL,finishedAt TEXT);
    CREATE TABLE refs(id TEXT PRIMARY KEY,itemId TEXT NOT NULL REFERENCES items(id),name TEXT NOT NULL,target TEXT NOT NULL,kind TEXT NOT NULL,role TEXT NOT NULL,createdAt TEXT NOT NULL);
    CREATE TABLE drafts(key TEXT PRIMARY KEY,body TEXT NOT NULL,updatedAt TEXT NOT NULL);
    CREATE TABLE pending_files(token TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL);
    CREATE TABLE reminders(id TEXT PRIMARY KEY,itemId TEXT NOT NULL REFERENCES items(id),kind TEXT NOT NULL,dueAt TEXT NOT NULL,scheduledAt TEXT NOT NULL,state TEXT NOT NULL,sentAt TEXT,UNIQUE(itemId,kind,dueAt));
    CREATE TABLE future_data(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO items VALUES('11111111-1111-4111-8111-111111111111','无敏感样例：核对周报',1,'2099-01-05T01:00:00.000Z',NULL,NULL,'2026-01-01T01:00:00.000Z','2026-01-03T01:00:00.000Z','2026-01-02T01:00:00.000Z','paused',0,'核对第四项','停在第三项','',NULL,'{"version":1,"fields":{"future":{"keep":[1,"样例"]}}}');
    INSERT INTO notes VALUES('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','communication','无敏感历史沟通记录','2026-01-02T01:00:00.000Z','{"version":1,"fields":{"result":"样例反馈"}}');
    INSERT INTO attachments VALUES('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','input.txt','attachments/input.txt','input',NULL);
    INSERT INTO attachments VALUES('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111','record.txt','attachments/record.txt','result','33333333-3333-4333-8333-333333333333');
    INSERT INTO analyses VALUES('66666666-6666-4666-8666-666666666666','11111111-1111-4111-8111-111111111111','approach','succeeded','无敏感已有建议','','sample/model','sample','sample','2026-01-02T01:00:00.000Z','2026-01-02T01:00:00.000Z');
    INSERT INTO refs VALUES('77777777-7777-4777-8777-777777777777','11111111-1111-4111-8111-111111111111','样例入口','https://example.com/input','url','input','2026-01-01T01:00:00.000Z');
    INSERT INTO pending_files VALUES('22222222-2222-4222-8222-222222222222','draft.txt','draft-files/22222222-2222-4222-8222-222222222222');
    INSERT INTO future_data VALUES('one','未知表的原有内容');
    PRAGMA user_version=5; COMMIT;`);
  db.prepare('INSERT INTO drafts(key,body,updatedAt) VALUES(?,?,?)').run('capture',JSON.stringify({text:'无敏感未提交草稿',pending:[{token:'22222222-2222-4222-8222-222222222222',name:'draft.txt'}],quadrant:1,reminder:'2099-02-01T01:00:00.000Z',deadline:null,folder:null,extra:{version:1,fields:{draftFuture:{keep:true}}}}),'2026-01-03T01:00:00.000Z');
  return db;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const directory=resolve(process.argv[2]??'');
  const cache=resolve(fileURLToPath(new URL('../../.cache/',import.meta.url)));
  if(!directory.toLowerCase().startsWith(cache.toLowerCase()+'\\lifecycle-'))throw new Error('命令行样例仅允许写入仓库隔离生命周期目录');
  createV5Fixture(directory);
  // 刻意模拟已提交写入后进程中断，留下有效WAL供跨运行时恢复检查。
  process.exit(0);
}
