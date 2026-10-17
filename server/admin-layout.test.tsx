import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { useState, act } from 'react';
import { JSDOM } from 'jsdom';
import { AdminTabs, MoreActions } from '../src/admin/layout.js';

test('compact tabs and overflow-safe menus preserve keyboard access, disabled actions, focus and dismissal', async () => {
  const dom=new JSDOM('<html><body><div id="root"></div></body></html>',{url:'http://localhost/admin'});
  const keys=['window','document','navigator','HTMLElement','IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
  keys.forEach(key=>Object.defineProperty(globalThis,key,{configurable:true,value:key==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[key as keyof typeof dom.window]}));
  const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);const doc=dom.window.document;
  let actions=0;
  function Workspace(){const[value,setValue]=useState<'one'|'two'|'three'>('one');return <><AdminTabs<'one'|'two'|'three'> label="分区" value={value} onChange={setValue} items={[{value:'one',label:'授权码'},{value:'two',label:'套餐'},{value:'three',label:'批次'}]}><p>{value}</p></AdminTabs><div className="admin-table-wrap"><MoreActions label="测试项目"><button onClick={()=>actions++}>编辑</button><button disabled>不可用操作</button><button onClick={()=>actions++}>删除</button></MoreActions><MoreActions label="另一项目"><button>操作</button></MoreActions></div></>;}
  const run=async(fn:()=>void)=>{await act(async()=>{fn();await new Promise(resolve=>setTimeout(resolve,0));});};
  const key=async(node:Element,value:string)=>run(()=>node.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:value,bubbles:true})));
  try{
    await run(()=>root.render(<Workspace/>));
    const tabs=doc.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    assert.equal(tabs[0].getAttribute('aria-selected'),'true');await key(tabs[0],'ArrowRight');assert.equal(doc.querySelector('[role="tabpanel"]')!.textContent,'two');assert.equal(doc.activeElement,tabs[1]);
    await key(tabs[1],'End');assert.equal(doc.querySelector('[role="tabpanel"]')!.textContent,'three');await key(tabs[2],'ArrowRight');assert.equal(doc.querySelector('[role="tabpanel"]')!.textContent,'one');
    const triggers=doc.querySelectorAll<HTMLButtonElement>('[aria-haspopup="menu"]');await key(triggers[0],'ArrowDown');
    const menu=doc.querySelector<HTMLElement>('[role="menu"]')!;assert.equal(menu.parentElement,doc.body,'menu is outside clipping table container');assert.equal(triggers[0].getAttribute('aria-expanded'),'true');
    assert.equal(doc.activeElement?.textContent,'编辑');await key(doc.activeElement!,'ArrowDown');assert.equal(doc.activeElement?.textContent,'删除','disabled action is skipped');await key(doc.activeElement!,'Escape');assert.equal(doc.querySelector('[role="menu"]'),null);assert.equal(doc.activeElement,triggers[0]);
    await run(()=>triggers[0].click());await run(()=>triggers[1].click());assert.equal(doc.querySelectorAll('[role="menu"]').length,1);assert.match(doc.querySelector('[role="menu"]')!.getAttribute('aria-label')!,/另一项目/);
    await run(()=>dom.window.dispatchEvent(new dom.window.Event('resize')));assert.equal(doc.querySelector('[role="menu"]'),null);
    await run(()=>triggers[0].click());await run(()=>doc.body.dispatchEvent(new dom.window.Event('pointerdown',{bubbles:true})));assert.equal(doc.querySelector('[role="menu"]'),null);
    await run(()=>triggers[0].click());await run(()=>doc.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());assert.equal(actions,1);assert.equal(doc.querySelector('[role="menu"]'),null);
    await run(()=>triggers[0].click());await key(doc.activeElement!,'Tab');assert.equal(doc.querySelector('[role="menu"]'),null);
  }finally{await run(()=>root.unmount());dom.window.close();keys.forEach((key,i)=>{if(saved[i])Object.defineProperty(globalThis,key,saved[i]!);else delete(globalThis as any)[key];});}
});

test('compact styling keeps existing typography and warm themes, reduces whitespace and supports narrow viewports',()=>{
  const css=fs.readFileSync(new URL('../src/admin/admin.css',import.meta.url),'utf8');
  const compact=css.split('/* Compact workspace:')[1];assert.ok(compact);
  assert.doesNotMatch(compact, /font-size:(?:9|10|11|12|13)px/,'density is not achieved by shrinking text');
  assert.doesNotMatch(compact,/--(?:bg-primary|bg-secondary|accent|text-primary)\s*:/,'both original palettes remain authoritative');
  assert.match(compact,/\.admin-stat\{min-height:104px/);assert.match(compact,/\.admin-two-column\{[^}]*align-items:start/);
  assert.match(compact,/\.admin-action-menu\{position:fixed/);assert.match(compact,/@media\(max-width:800px\)/);assert.match(compact,/@media\(max-width:560px\)/);
  assert.match(css,/\.admin-field input,\.admin-field select,\.table-select\{[^}]*font-size:14px/);
  assert.match(css,/\.admin-stat strong\{[^}]*font-size:32px/);
  const app=fs.readFileSync(new URL('../src/admin/AdminApp.tsx',import.meta.url),'utf8');
  assert.match(app,/admin-update-strip/);assert.match(app,/admin-disclosure/);assert.match(app,/admin-overview-notes/);
});
