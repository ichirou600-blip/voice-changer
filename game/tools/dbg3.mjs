import { chromium } from 'playwright';
const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:640,height:360}});
p.on('pageerror',e=>console.log('ERR',String(e)));
await p.goto('http://localhost:5173/?capture=1&pose=hero&hud=0',{waitUntil:'load'});
await p.waitForFunction(()=>window.__GAME_READY__||window.__GAME_ERROR__,null,{timeout:240000,polling:250}).catch(()=>console.log('noready'));
await p.waitForTimeout(800);
const luma = () => p.evaluate(()=>{
  const cv=document.querySelector('#app canvas');const t=document.createElement('canvas');t.width=64;t.height=36;
  const g=t.getContext('2d');g.drawImage(cv,0,0,64,36);const d=g.getImageData(0,0,64,36).data;
  let s=0;for(let i=0;i<d.length;i+=4)s+=(d[i]+d[i+1]+d[i+2])/3;return +(s/(64*36)).toFixed(2);});
console.log('hdrFlag', await p.evaluate(()=>window.__engine.renderPipeline.hdr));
console.log('rtType', await p.evaluate(()=>window.__engine.renderPipeline.composer.renderTarget1.texture.type));
console.log('full', await luma());
// Force worldpass to render straight to screen
console.log(await p.evaluate(()=>{
  const e=window.__engine, c=e.renderPipeline.composer;
  c.passes[0].renderToScreen=true;
  c.passes[1].enabled=false;c.passes[2].enabled=false;c.passes[3].enabled=false;
  return 'set';
}));
await p.waitForTimeout(600);
console.log('worldpass->screen', await luma());
// Now test: read back the composer readBuffer after a manual world render
console.log(await p.evaluate(()=>{
  const e=window.__engine, c=e.renderPipeline.composer;
  const r=e.renderer;
  r.setRenderTarget(c.readBuffer); r.clear(true,true,true); r.render(e.scene,e.camera);
  const T=c.readBuffer.texture.type;
  const buf = T===1009? new Uint8Array(c.readBuffer.width*c.readBuffer.height*4) : new Float32Array(c.readBuffer.width*c.readBuffer.height*4);
  let err=null; try{ r.readRenderTargetPixels(c.readBuffer,0,0,c.readBuffer.width,c.readBuffer.height,buf);}catch(ex){err=String(ex);}
  let s=0,n=0; for(let i=0;i<buf.length;i+=4){s+=buf[i];n++;}
  r.setRenderTarget(null);
  return {type:T, mean:+(s/n).toFixed(4), err, w:c.readBuffer.width,h:c.readBuffer.height};
}));
await b.close();
