import { chromium } from 'playwright';
const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:640,height:360}});
p.on('pageerror',e=>console.log('ERR',String(e)));
p.on('console',m=>{if(m.type()==='error')console.log('CERR',m.text())});
await p.goto('http://localhost:5173/?capture=1&pose=hero&hud=0',{waitUntil:'load'});
await p.waitForFunction(()=>window.__GAME_READY__||window.__GAME_ERROR__,{timeout:180000}).catch(()=>console.log('no ready'));
await p.waitForTimeout(1000);

const avg = async (label) => {
  await p.waitForTimeout(500);
  const buf = await p.screenshot();
  // rough brightness via sharp-less: decode PNG in page instead
  console.log(label, buf.length);
};

console.log(await p.evaluate(()=>{
  const c = window.__engine.composerPasses = window.__engine.renderPipeline.composer.passes.map(x=>x.constructor.name);
  return c;
}));

const probe = async (label) => {
  await p.waitForTimeout(400);
  const v = await p.evaluate(()=>{
    const cv = document.querySelector('#app canvas');
    const t = document.createElement('canvas'); t.width=64; t.height=36;
    const g = t.getContext('2d'); g.drawImage(cv,0,0,64,36);
    const d = g.getImageData(0,0,64,36).data;
    let s=0; for(let i=0;i<d.length;i+=4) s+=(d[i]+d[i+1]+d[i+2])/3;
    return +(s/(64*36)).toFixed(2);
  });
  console.log(label, 'meanLuma', v);
};

await probe('full pipeline');
await p.evaluate(()=>{ window.__engine.renderPipeline.composer.passes[1].enabled=false; });
await probe('bloom off');
await p.evaluate(()=>{ window.__engine.renderPipeline.composer.passes[2].enabled=false; });
await probe('bloom+grade off');
await p.evaluate(()=>{ window.__engine.renderPipeline.composer.passes[3].enabled=false; });
await probe('only worldpass');
await p.evaluate(()=>{ const e=window.__engine; e.renderPipeline=null; });
await probe('no composer');
await b.close();
