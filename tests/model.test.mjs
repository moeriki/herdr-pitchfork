import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, mkdir, rm, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const source = await readFile(new URL('../mods/pitchfork/model.js', import.meta.url), 'utf8');
const { decode, disposition, snapshot, control, daemonUrl, formatElapsed } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const target = {root:'/sample/worktree',machine:null,all:false};
const row = {id:'sample/web',name:'web',status:'stopped'};
const output = rows => ({code:0,stdout:JSON.stringify(rows),stderr:''});

for (const [action, state, oneshot, expected] of [
  ['start','running',false,'noop'], ['start','completed',true,'run'], ['stop','errored',false,'run'], ['stop','waiting',false,'run'], ['stop','failed',false,'noop'],
  ['stop','stopped',false,'noop'], ['stop','available',false,'noop'],
  ['start','available',false,'run'], ['restart','running',false,'run'],
]) test(`${action} ${state} oneshot=${oneshot}: ${expected}`, () => assert.equal(disposition(action,{...row,status:state,oneshot}),expected));

test('Open needs a running daemon and falls back to its port',()=>{
  assert.equal(daemonUrl({status:'stopped',proxy_url:'https://web.localhost'}),null);
  assert.equal(daemonUrl({status:'running',active_port:3000}),'http://localhost:3000');
  assert.equal(daemonUrl({status:'running',proxy_url:'https://web.localhost',active_port:3000}),'https://web.localhost');
});
test('uptime reads ps etime for running pids only',async()=>{
  const calls=[];
  const rows=await snapshot(async(cmd,args)=>{calls.push([cmd,args]);return cmd==='ps'?{code:1,stdout:'  42   01:25:03\n',stderr:''}:output([{...row,status:'running',pid:42},{...row,id:'sample/gone',status:'running',pid:7},row]);},target,{uptime:true});
  assert.deepEqual(calls[1],['ps',['-o','pid=,etime=','-p','42,7']]);
  assert.deepEqual(rows.map(r=>r.uptime),['1h 25m',undefined,undefined]);
});
test('elapsed time formats like the Pitchfork TUI',()=>{
  assert.deepEqual(['00:42','05:09','15:29:00','2-03:04:05'].map(formatElapsed),['42s','5m','15h 29m','2d 3h']);
});
test('bad JSON, exit failure and unexpected schema fail closed',()=>{
  assert.throws(()=>decode({code:1,stderr:'unavailable',stdout:''}),/unavailable/);
  assert.throws(()=>decode(output({rows:[]})),/Unsupported/);
  assert.throws(()=>decode(output([{id:{qualified:'x'},status:{type:'running'}}])),/Unsupported/);
});
test('transitional, missing, disabled and invalid actions fail closed',()=>{
  assert.throws(()=>disposition('start',{...row,status:'waiting'}),/wait/);
  assert.throws(()=>disposition('start',null),/no longer exists/);
  assert.throws(()=>disposition('start',{...row,disabled:true}),/disabled/);
  assert.throws(()=>disposition('kill',row),/Unsupported/);
});
test('current-worktree list uses --project and exact cwd/machine',async()=>{
  let call;
  await snapshot(async(...args)=>{call=args;return output([row]);},{...target,machine:'remote'});
  assert.deepEqual(call,['pitchfork',['list','--json','--project'],{cwd:target.root,on:'remote',autostart:false}]);
});
test('all-daemon list omits project filter',async()=>{
  let args;
  await snapshot(async(_cmd,a)=>{args=a;return output([]);},{...target,all:true});
  assert.deepEqual(args,['list','--json']);
});
test('already-running start never sends a start or force flag',async()=>{
  let count=0;
  const result=await control(async()=>{count++;return output([{...row,status:'running'}]);},target,row.id,'start',()=>true);
  assert.equal(count,1);assert.equal(result.noop,true);
});
test('context change after preflight prevents mutation',async()=>{
  let count=0;
  await assert.rejects(control(async()=>{count++;return output([row]);},target,row.id,'start',()=>false),/changed/);
  assert.equal(count,1);
});
test('qualified ID remains a single argv value, no shell or --force',async()=>{
  const calls=[];
  await control(async(...a)=>{calls.push(a);return calls.length===1?output([row]):{code:0,stdout:'',stderr:''};},target,row.id,'start',()=>true);
  assert.deepEqual(calls[1],['pitchfork',['start','--','sample/web'],{cwd:target.root,on:null,timeout:600000}]);
});
test('failed action is not reported successful',async()=>{
  let count=0;
  await assert.rejects(control(async()=>++count===1?output([row]):{code:1,stdout:'',stderr:'port busy'},target,row.id,'start',()=>true),/port busy/);
});

function execute(cmd,args,opts={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(cmd,args,{cwd:opts.cwd,env:process.env});let stdout='',stderr='';
    child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
}

test('LIVE: two disposable worktrees, namespace isolation, idempotent start, logs, restart, stop', {skip:!process.env.PITCHFORK_LIVE_TEST}, async()=>{
  const scratch=await realpath(tmpdir());
  const dir=await mkdtemp(join(scratch,'herdr-pitchfork-test-'));
  const token=dir.split('/').at(-1).toLowerCase();
  const targets=[];
  const before=decode(await execute('pitchfork',['list','--json'],{cwd:scratch}));
  try {
    for (const suffix of ['a','b']) {
      const root=join(dir,suffix+" space's $(exit 9)");await mkdir(root);
      await writeFile(join(root,'pitchfork.toml'),'[daemons.probe]\nrun = "echo herdr-probe-ready; exec sleep 120"\n');
      await writeFile(join(root,'pitchfork.local.toml'),'namespace = "'+token+'-'+suffix+'"\n');
      const t={root,machine:null,all:false};targets.push(t);
      const rows=await snapshot(execute,t);assert.equal(rows.length,1);assert.equal(rows[0].id,token+'-'+suffix+'/probe');
    }
    const [a,b]=targets;
    const id=token+'-a/probe';
    // Simulate two clients observing available concurrently. Supervisor owns start serialization.
    const starts=await Promise.allSettled([control(execute,a,id,'start',()=>true),control(execute,a,id,'start',()=>true)]);
    assert.ok(starts.some(r=>r.status==='fulfilled'));
    let state=(await snapshot(execute,a))[0];assert.equal(state.status,'running');const pid=state.pid;
    assert.equal((await snapshot(execute,b))[0].status,'available');
    assert.equal((await control(execute,a,id,'start',()=>true)).noop,true);
    assert.equal((await snapshot(execute,a))[0].pid,pid);
    const logs=await execute('pitchfork',['logs','-n','100','--raw','--no-pager','--',id],{cwd:a.root});
    assert.equal(logs.code,0,logs.stderr);assert.match(logs.stdout,/herdr-probe-ready/);
    assert.equal(logs.stdout.split('herdr-probe-ready').length-1,1,'Concurrent clients must launch the command exactly once');
    await control(execute,a,id,'restart',()=>true);
    state=(await snapshot(execute,a))[0];assert.equal(state.status,'running');assert.notEqual(state.pid,pid);
    await control(execute,a,id,'stop',()=>true);
    assert.equal((await snapshot(execute,a))[0].status,'stopped');
    const after=decode(await execute('pitchfork',['list','--json'],{cwd:scratch}));
    for(const old of before.filter(r=>r.status==='running')) assert.equal(after.find(r=>r.id===old.id)?.pid,old.pid,'unrelated daemon PID: '+old.id);
    console.log('Live fixture: local namespace overrides honored; repeated start kept PID; restart changed PID; stop verified; unrelated running PIDs unchanged.');
  } finally {
    for(const t of targets) {
      const rows=await snapshot(execute,t).catch(()=>[]);
      for(const r of rows) if(r.id.startsWith(token+'-')) {
        await execute('pitchfork',['stop','--',r.id],{cwd:t.root});
        await execute('pitchfork',['clean','--daemon',r.id],{cwd:t.root});
      }
    }
    await rm(dir,{recursive:true,force:true});
    // Namespace-scoped prune: never clean another project's stopped records.
    for (const suffix of ['a','b']) await execute('pitchfork',['clean','--prune',token+'-'+suffix],{cwd:scratch});
  }
});
