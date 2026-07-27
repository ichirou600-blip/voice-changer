import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const CHROME='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARGS=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--disable-dev-shm-usage','--no-sandbox'];
const pose=process.argv[2]||'hero', out=process.argv[3]||'shots/final/hero.png';
const b=await chromium.launch({executablePath:CHROME,args:ARGS});
const p=await b.newPage({viewport:{width:1280,height:720}});
const errs=[];
p.on('pageerror',e=>errs.push(String(e).slice(0,200)));
p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,200));});
await p.goto(`http://127.0.0.1:5330/?capture=1&pose=${pose}&q=low`,{waitUntil:'load',timeout:120000});
// Poll for readiness with a generous ceiling: under heavy CPU contention the
// procedural bake legitimately takes many minutes on a software rasteriser.
let ready=false;
for(let i=0;i<180;i++){
  const s=await p.evaluate(()=>({r:window.__GAME_READY__,e:window.__GAME_ERROR__,
    stage:document.querySelector('#loading .stage')?.textContent||null}));
  if(s.e){console.log('BOOT ERROR:',String(s.e).slice(0,400));break;}
  if(s.r){ready=true;console.log('ready after',i*5,'s');break;}
  if(i%12===0)console.log('t=',i*5,'s stage=',s.stage);
  await p.waitForTimeout(5000);
}
await p.waitForTimeout(4000);
await mkdir('shots/final',{recursive:true});
await p.screenshot({path:out});
console.log(JSON.stringify({out,ready,errors:[...new Set(errs)].slice(0,5)}));
await b.close();
