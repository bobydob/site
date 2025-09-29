/* custom-loader.v5.js — Unity WebGL BR loader (pure, CSP-friendly)
   API: window.startUnityBr(canvas, config, onProgress)

   config:
     dataUrl, codeUrl, frameworkUrl, innerLoaderUrl   — ОБЯЗАТЕЛЬНО
     streamingAssetsUrl                                — опционально (как в Unity)
     brotliUrl                                         — опционально (URL внешнего brotli.min.js)
*/

(function () {
  const TAG = '[br-loader]';
  const log  = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err  = (...a) => console.error(TAG, ...a);

  log('file loaded');

  // ───────────────────────── helpers ─────────────────────────
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  function assert(cond, msg){ if(!cond) throw new Error(`${TAG} ${msg}`); }

  async function streamToU8(readable, onBytes){
    const r = readable.getReader(); const chunks=[]; let total=0;
    while(true){ const {done,value}=await r.read(); if(done) break;
      if(value && value.byteLength){ chunks.push(value); total+=value.byteLength; onBytes && onBytes(value.byteLength,total); }
    }
    const out=new Uint8Array(total); let off=0; for(const c of chunks){ out.set(c,off); off+=c.byteLength; }
    return out;
  }

  async function fetchWithProgress(url, fetchOpts, onProgress){
    const res = await fetch(url, fetchOpts||{});
    if(!res.ok) throw new Error(`${TAG} HTTP ${res.status} for ${url}`);
    const total = Number(res.headers.get('Content-Length'))||0;
    let loaded=0;
    const body = res.body ? res.body : new ReadableStream({
      start(controller){ res.arrayBuffer().then(b=>{controller.enqueue(new Uint8Array(b)); controller.close();})
                         .catch(e=>controller.error(e)); }
    });
    const u8 = await streamToU8(body, (d)=>{ loaded+=d; if(onProgress && total) onProgress(loaded,total); });
    if(onProgress && !total) onProgress(loaded,loaded);
    return { u8, res };
  }

  function chainProgress(preCap, outer){
    let last=0;
    return {
      pre(v){ v=Math.max(0,Math.min(preCap,v)); last=v; outer && outer(v); },
      tail(inner){ const m=preCap+(1-preCap)*inner; if(m>last) last=m; outer && outer(last); }
    };
  }

  function haveDecoder(){
    if (self.brotli && typeof self.brotli.decompress === 'function') return (u8)=>self.brotli.decompress(u8);
    if (typeof self.BrotliDecode === 'function') return (u8)=>self.BrotliDecode(u8);
    return null;
  }

  function loadScriptOnce(src){
    return new Promise((resolve,reject)=>{
      if (document.querySelector('script[data-br-loader="'+src+'"]')) return resolve();
      const s=document.createElement('script');
      s.src=src; s.async=true; s.dataset.brLoader=src;
      s.onload=()=>resolve(); s.onerror=()=>reject(new Error(`${TAG} failed to load ${src}`));
      document.body.appendChild(s);
    });
  }

  async function ensureBrotliDecoder(brotliUrl){
    // Уже есть?
    let dec = haveDecoder(); if (dec) return dec;

    // Список кандидатов: кастомный URL → jsDelivr → cdnjs
    const candidates = [
      brotliUrl || '',
      'https://cdn.jsdelivr.net/npm/brotli@1.3.3/dist/brotli.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/brotli/1.3.3/brotli.min.js'
    ].filter(Boolean);

    for (const url of candidates){
      try {
        await loadScriptOnce(url);
        dec = haveDecoder();
        if (dec) { log('brotli decoder loaded:', url); return dec; }
      } catch(e){ warn('decoder load failed:', url, e && e.message); }
    }
    throw new Error('Brotli decoder not found (set config.brotliUrl or allow jsDelivr/CDNJS).');
  }

  // ───────────────────────── public API ─────────────────────────
  async function startUnityBr(canvas, userConfig, onProgress){
    try{
      assert(canvas && canvas instanceof HTMLCanvasElement, 'canvas is missing/invalid');
      assert(userConfig && typeof userConfig==='object', 'config must be an object');

      const {
        dataUrl, codeUrl, frameworkUrl, innerLoaderUrl,
        streamingAssetsUrl, brotliUrl, ...rest
      } = userConfig;

      assert(innerLoaderUrl, 'config.innerLoaderUrl is required');
      assert(dataUrl && codeUrl && frameworkUrl, 'config.{dataUrl,codeUrl,frameworkUrl} are required');

      log('start → downloading & inflating .br assets');

      const preCap = 0.85;
      const prog = chainProgress(preCap, (p)=>{ if(onProgress) onProgress(Math.max(p,0.05)); });

      // 1) качаем с прогрессом (wasm без кэша, data — с кэшем)
      let wasmLoaded=0, wasmTotal=0;
      const wasmFetch = fetchWithProgress(codeUrl, { cache:'no-store' }, (l,t)=>{ wasmLoaded=l; wasmTotal=t; const part=0.5*(t?l/t:1); prog.pre(0.30*part); });

      let dataLoaded=0, dataTotal=0;
      const dataFetch = fetchWithProgress(dataUrl, { cache:'default' }, (l,t)=>{ dataLoaded=l; dataTotal=t; const part=0.5*(t?l/t:1); prog.pre(0.30 + 0.40*part); });

      const [{u8:wasmBr},{u8:dataBr}] = await Promise.all([wasmFetch, dataFetch]);

      // 2) подключаем декодер и распаковываем
      const dec = await ensureBrotliDecoder(brotliUrl);
      const wasmU8 = new Uint8Array(dec(wasmBr));    prog.pre(0.50);
      const dataU8 = new Uint8Array(dec(dataBr));    prog.pre(0.75);

      // 3) sanity: \0asm
      assert(wasmU8[0]===0x00 && wasmU8[1]===0x61 && wasmU8[2]===0x73 && wasmU8[3]===0x6D, 'WASM magic not found after decompression');

      // 4) blob: ссылки
      const wasmUrl = URL.createObjectURL(new Blob([wasmU8], {type:'application/wasm'}));
      const dataUrl2= URL.createObjectURL(new Blob([dataU8], {type:'application/octet-stream'}));

      log('assets ready → loading inner loader:', innerLoaderUrl);

      // 5) грузим Unity loader.js и стартуем
      await loadScriptOnce(innerLoaderUrl);
      assert(typeof createUnityInstance==='function','inner loader did not define createUnityInstance');

      const cfg = { ...rest, frameworkUrl, codeUrl: wasmUrl, dataUrl: dataUrl2, streamingAssetsUrl };

      const unity = await createUnityInstance(canvas, cfg, (p)=>{ prog.tail(Math.max(0,Math.min(1,p))); });
      // добиваем прогресс до 100%
      for(let i=0;i<3;i++){ prog.tail(1); await sleep(16); }

      log('Unity instance started');
      return unity;

    }catch(e){
      err(e && e.stack ? e.stack : String(e));
      throw e;
    }
  }

  window.startUnityBr = startUnityBr;
  log('exported startUnityBr:', typeof window.startUnityBr);
})();
