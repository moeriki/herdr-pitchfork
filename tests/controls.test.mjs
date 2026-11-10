import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const model=await import('data:text/javascript;base64,'+Buffer.from(await readFile(new URL('../mods/pitchfork/model.js',import.meta.url),'utf8')).toString('base64'));
const source=(await readFile(new URL('../mods/pitchfork/main.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export default class Pitchfork','class Pitchfork');
function node(){
  const n={items:[]};
  const p=new Proxy(n,{get:(o,k)=>k in o?o[k]:()=>p});
  n.id=id=>{n.key=id;return p;};n.child=c=>{n.items.push(c);return p;};return p;
}
const Klass=new Function('View','div','h_flex','v_flex','daemonUrl','daemonActions','groupActions',source+';return Pitchfork;')(class{},node,node,node,model.daemonUrl,model.daemonActions,model.groupActions);
function fixture(row){
  const view=new Klass();view.pending={};view.rows=[];view.selected=null;
  view.button=(id,label,click)=>({key:id,label,click,items:[]});
  const calls=[];view.command=(...args)=>calls.push(args);
  const render=()=>view.daemonControls(row,{});
  const find=(id,n=render())=>n.key===id?n:n.items?.map(c=>typeof c==='object'?find(id,c):null).find(Boolean);
  return {view,render,find,calls};
}
test('lifecycle actions follow state and disappear during transitions or commands',()=>{
  for(const status of ['available','stopped','failed'])assert.deepEqual(model.daemonActions({status}),['start']);
  assert.deepEqual(model.daemonActions({status:'running'}),['stop','restart']);
  for(const status of ['stopping','unknown'])assert.deepEqual(model.daemonActions({status}),[]);
  for(const status of ['waiting','restarting'])assert.deepEqual(model.daemonActions({status}),['stop']);
  assert.deepEqual(model.daemonActions({status:'errored'}),['start','stop']);
  assert.deepEqual(model.daemonActions({status:'running'},true),[]);
  assert.deepEqual(model.daemonActions({status:'completed',oneshot:true}),['start']);
  assert.deepEqual(model.daemonActions({status:'available',disabled:true}),[]);
  assert.deepEqual(model.daemonActions({status:'running',disabled:true}),['stop']);
});
test('Open is absent without an HTTP URL, including unsafe URLs',()=>{
  for(const url of [undefined,'','javascript:alert(1)','file:///tmp/foo','http://']){
    const f=fixture({id:'ns/web',status:'running',url});assert.equal(f.find('pf-open-ns/web'),undefined);
  }
  assert.ok(fixture({id:'ns/web',status:'running',url:'http://localhost:3000'}).find('pf-open-ns/web'));
  assert.equal(model.daemonUrl({status:'running',proxy_url:'invalid',url:'https://example.org'}),'https://example.org');
});
test('running daemon renders separate Stop and Restart, without Start or a dropdown',()=>{
  const f=fixture({id:'ns/web',status:'running'});
  assert.equal(f.find('pf-stop-ns/web').label,'Stop');
  assert.equal(f.find('pf-start-ns/web'),undefined);
  assert.equal(f.find('pf-more-ns/web'),undefined);
  f.find('pf-restart-ns/web').click({});assert.equal(f.view.selected,'ns/web');assert.equal(f.calls[0][0],'restart');
});
test('Start button dispatches Start and running button dispatches Stop',()=>{
  for(const [status,action] of [['available','start'],['running','stop']]){
    const f=fixture({id:'ns/web',status});f.find('pf-'+action+'-ns/web').click({});assert.equal(f.calls[0][0],action);
  }
});

test('stopped daemon only renders Start; pending daemon hides lifecycle buttons',()=>{
  const f=fixture({id:'ns/web',status:'stopped'});
  assert.ok(f.find('pf-start-ns/web'));
  assert.equal(f.find('pf-stop-ns/web'),undefined);
  assert.equal(f.find('pf-restart-ns/web'),undefined);
  f.view.pending={'ns/web':'starting'};
  assert.equal(f.find('pf-start-ns/web'),undefined);
  assert.ok(f.find('pf-logs-ns/web'));
});

test('group actions reflect applicable work and preflight restrictions',()=>{
  const running={status:'running'},stopped={status:'stopped'};
  assert.deepEqual(model.groupActions([running]),['restart','stop']);
  assert.deepEqual(model.groupActions([stopped]),['start']);
  assert.deepEqual(model.groupActions([running,stopped]),['start','restart','stop']);
  assert.deepEqual(model.groupActions([{status:'completed',oneshot:true}]),['start']);
  assert.deepEqual(model.groupActions([{status:'available',disabled:true}]),[]);
  assert.deepEqual(model.groupActions([running,{status:'waiting'}]),[]);
  assert.deepEqual(model.groupActions([running],true),[]);
  assert.deepEqual(model.groupActions([]),[]);
});

test('footer renders Start all / Restart all / Stop all for the listed daemons',()=>{
  const f=fixture({id:'ns/web',status:'running'});
  f.view.groupAction=(...args)=>f.calls.push(args);
  f.view.rows=[{id:'ns/web',status:'running'},{id:'ns/api',status:'stopped'}];
  const controls=f.view.groupControls({});
  assert.deepEqual(controls.items.map(c=>c.label),['Start all','Restart all','Stop all']);
  controls.items[1].click({});
  assert.equal(f.calls[0][0],'restart');
});
