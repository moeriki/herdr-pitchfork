import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const modelSource=await readFile(new URL('../mods/pitchfork/model.js',import.meta.url),'utf8');
const {snapshot,control}=await import('data:text/javascript;base64,'+Buffer.from(modelSource).toString('base64'));
// Only replace native imports; exercise the production View methods with injected native boundaries.
const source=(await readFile(new URL('../mods/pitchfork/main.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export default class Pitchfork','class Pitchfork');
const make=new Function('View','exec','home','props','snapshot','control',source+';return Pitchfork;');
const tick=()=>new Promise(r=>setImmediate(r));
const output=rows=>({code:0,stdout:JSON.stringify(rows),stderr:''});
function harness(execute){
  const Klass=make(class{},execute,()=>'/home',()=>({}),snapshot,control);
  const view=new Klass();view.init({}, {timer:{every(){}},spawn(){}});
  let context={space:'a',cwd:'/a',machine:null,all:false};view.context=()=>context;
  const tasks=[];const cx={notify(){},spawn(fn){tasks.push(fn(cx));}};
  return {view,cx,tasks,context(c){context={...context,...c};}};
}

test('A-B-A navigation drops stale results and stale finally cannot clear latest loading',async()=>{
  const pending=[];
  const h=harness(async(cmd,args,opts)=>cmd==='sh'?{code:0,stdout:opts.cwd,stderr:''}:new Promise(resolve=>pending.push({root:opts.cwd,resolve})));
  h.view.refresh(h.cx);await tick();
  h.context({space:'b',cwd:'/b'});h.view.refresh(h.cx);await tick();
  h.context({space:'a',cwd:'/a'});h.view.refresh(h.cx);await tick();
  assert.equal(pending.length,3);
  pending[0].resolve(output([{id:'old/a',status:'running'}]));await tick();
  assert.equal(h.view.loading,true);assert.equal(h.view.target,null);
  pending[1].resolve(output([{id:'old/b',status:'running'}]));await tick();
  assert.equal(h.view.loading,true);
  pending[2].resolve(output([{id:'new/a',status:'stopped'}]));await Promise.all(h.tasks);
  assert.equal(h.view.loading,false);assert.equal(h.view.selected,'new/a');assert.equal(h.view.target.root,'/a');
});

