import { chromium } from 'playwright';
const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:640,height:360}});
await p.goto('http://localhost:5173/?capture=1&pose=hero&hud=0',{waitUntil:'load'});
await p.waitForFunction(()=>window.__GAME_READY__||window.__GAME_ERROR__,{timeout:180000}).catch(()=>{});
console.log(await p.evaluate(()=>{
  const gl = window.__engine.renderer.getContext();
  return {
    version: gl.getParameter(gl.VERSION),
    colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
    colorBufferHalfFloat: !!gl.getExtension('EXT_color_buffer_half_float'),
    floatBlend: !!gl.getExtension('EXT_float_blend'),
    linearHalf: !!gl.getExtension('OES_texture_float_linear'),
    maxSamples: gl.getParameter(gl.MAX_SAMPLES),
  };
}));
// try rendering into a byte RT manually
console.log(await p.evaluate(async ()=>{
  const e = window.__engine;
  const THREE = e.game.level.root.constructor === Object ? null : null;
  const rt = new (Object.getPrototypeOf(e.renderPipeline.composer.renderTarget1).constructor)(320,180,{type:1009});
  e.renderer.setRenderTarget(rt);
  e.renderer.clear(true,true,true);
  e.renderer.render(e.scene, e.camera);
  const buf = new Uint8Array(320*180*4);
  e.renderer.readRenderTargetPixels(rt,0,0,320,180,buf);
  let s=0; for(let i=0;i<buf.length;i+=4) s+=(buf[i]+buf[i+1]+buf[i+2])/3;
  e.renderer.setRenderTarget(null);
  return {byteRTmean:+(s/(320*180)).toFixed(2)};
}));
console.log(await p.evaluate(async ()=>{
  const e = window.__engine;
  const RT = Object.getPrototypeOf(e.renderPipeline.composer.renderTarget1).constructor;
  const rt = new RT(320,180,{type:1016}); // HalfFloatType
  e.renderer.setRenderTarget(rt);
  e.renderer.clear(true,true,true);
  e.renderer.render(e.scene, e.camera);
  const buf = new Uint8Array(320*180*4);
  let err=null;
  try { e.renderer.readRenderTargetPixels(rt,0,0,320,180,buf); } catch(ex){ err=String(ex); }
  let s=0; for(let i=0;i<buf.length;i+=4) s+=(buf[i]+buf[i+1]+buf[i+2])/3;
  e.renderer.setRenderTarget(null);
  return {halfRTmean:+(s/(320*180)).toFixed(2), err};
}));
await b.close();
