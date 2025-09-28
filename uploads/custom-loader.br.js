/* custom-loader.br.js — outer loader with fallback
 * - Path A: DecompressionStream('br') → blob: → inner loader (loader.js)
 * - Path B: NO 'br' support → gracefully fall back to your 2loader.js
 */
(() => {
  const TAG = "[br-loader]";
  console.log(`${TAG} file loaded`);

  const clamp01 = (v) => Math.max(0, Math.min(1, v ?? 0));
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  const hasDS = typeof DecompressionStream === "function";

  function loadScript(url){
    return new Promise((resolve,reject)=>{
      const s=document.createElement("script");
      s.src=url; s.async=false;
      s.onload=resolve;
      s.onerror=()=>reject(new Error(`${TAG} failed to load script: ${url}`));
      document.head.appendChild(s);
    });
  }

  const once = (fn)=>{ let p,done=false; return (...a)=>done?p:(done=true,p=fn(...a)); };
  const loadInnerOnce = once(async (url)=>{
    console.log(`${TAG} loading inner loader: ${url}`);
    await loadScript(url);
    if (typeof window.createUnityInstance!=="function"){
      throw new Error(`${TAG} inner loader did not expose createUnityInstance`);
    }
    console.log(`${TAG} inner loader ready`);
  });

  (function patchInstantiateStreaming(){
    const orig = WebAssembly.instantiateStreaming;
    if (!orig){
      WebAssembly.instantiateStreaming = async (respPromise, imports)=>{
        const resp = await respPromise; const buf = await resp.arrayBuffer();
        return WebAssembly.instantiate(buf, imports);
      };
      console.log(`${TAG} patched instantiateStreaming (polyfill)`); return;
    }
    WebAssembly.instantiateStreaming = async (respPromise, imports)=>{
      try{ return await orig(respPromise, imports); }
      catch(e){ console.warn(`${TAG} instantiateStreaming failed, falling back`, e);
        const resp = await respPromise; const buf = await resp.arrayBuffer();
        return WebAssembly.instantiate(buf, imports);
      }
    };
    console.log(`${TAG} patched instantiateStreaming (fallback)`);
  })();

  function progressBridge(user){
    const s={unityMax:0, loader:0};
    const emit=()=>{ try{ user?.(clamp01(Math.max(s.unityMax,s.loader))); }catch{} };
    return {
      unity(p){ s.unityMax=Math.max(s.unityMax,clamp01(p)); emit(); },
      set(p){ s.loader=clamp01(p); emit(); },
      bump(d){ s.loader=clamp01(s.loader+d); emit(); },
      done(){ s.loader=1; s.unityMax=Math.max(s.unityMax,1); emit(); }
    };
  }

  async function fetchDecompressBRToArrayBuffer(url,{mime,noStore,onProgress,progressWeight,boostAfter}){
    const res = await fetch(url,{cache:noStore?"no-store":"default"});
    if (!res.ok || !res.body) throw new Error(`${TAG} fetch failed ${res.status} for ${url}`);

    const total = Number(res.headers.get("content-length"))||0;
    let read = 0;
    const progressTap = new TransformStream({
      transform(chunk,ctlr){
        read += chunk.byteLength||chunk.length||0;
        const downloadPart = (1 - boostAfter);
        const p = total ? (read/total)*downloadPart : Math.min(downloadPart,(read/(1024*1024))*0.01);
        onProgress(Math.max(0,Math.min(1,p))*progressWeight);
        ctlr.enqueue(chunk);
      }
    });

    const ds = new DecompressionStream("br");
    const decompressed = res.body.pipeThrough(progressTap).pipeThrough(ds);
    const ab = await new Response(decompressed,{headers:{"Content-Type":mime}}).arrayBuffer();

    for(let i=1;i<=6;i++){ await sleep(8); const p=(1-boostAfter)+boostAfter*(i/6); onProgress(p*progressWeight); }
    return ab;
  }

  // -------- Fallback path (uses your 2loader.js end-to-end) ----------
  async function runFallback2Loader(canvas, baseConfig, userOnProgress){
    console.warn(`${TAG} DecompressionStream('br') is not available. Switching to fallbackLoaderUrl (2loader.js).`);
    const { fallbackLoaderUrl } = baseConfig;
    if (!fallbackLoaderUrl) throw new Error(`${TAG} Provide config.fallbackLoaderUrl pointing to your 2loader.js`);

    // Load the proven 2loader.js (it will unpack .br itself)
    await loadScript(fallbackLoaderUrl);

    // From here we do the simplest path: call the normal inner loader entry if present,
    // otherwise 2loader.js typically provides its own bootstrap that hooks createUnityInstance.
    if (typeof window.createUnityInstance !== "function"){
      throw new Error(`${TAG} 2loader.js did not expose createUnityInstance`);
    }
    return window.createUnityInstance(canvas, baseConfig, userOnProgress);
  }

  // -------- Public API -------------------------------------------------
  async function startUnityBr(canvas, config, userOnProgress){
    console.log(`${TAG} startUnityBr called`);
    if (!canvas) throw new Error(`${TAG} canvas is required`);
    if (!config) throw new Error(`${TAG} config is required`);

    const {
      dataUrl, codeUrl, frameworkUrl,
      innerLoaderUrl,               // your original loader.js
      fallbackLoaderUrl             // <-- NEW: url to 2loader.js for environments w/o 'br'
    } = config;

    if (!dataUrl || !codeUrl || !frameworkUrl) {
      throw new Error(`${TAG} config must include dataUrl, codeUrl, frameworkUrl`);
    }

    // If no 'br' support → go straight to fallback (2loader.js)
    if (!hasDS){
      return runFallback2Loader(canvas, config, userOnProgress);
    }

    if (!innerLoaderUrl){
      throw new Error(`${TAG} config.innerLoaderUrl is required (path to original loader.js)`);
    }

    const PB = progressBridge(userOnProgress);
    const W = { data:0.42, wasm:0.48, beforeRun:0.10 };

    PB.set(0.02);
    await (async()=>{ // load inner loader once
      console.log(`${TAG} loading inner loader: ${innerLoaderUrl}`);
      await loadInnerOnce(innerLoaderUrl);
    })();
    PB.bump(0.02);

    // Parallel download + decompress
    const dataP = fetchDecompressBRToArrayBuffer(dataUrl,{
      mime:"application/octet-stream", noStore:false,
      onProgress:(p)=>PB.set(p), progressWeight:W.data, boostAfter:0.08
    });
    const wasmP = fetchDecompressBRToArrayBuffer(codeUrl,{
      mime:"application/wasm", noStore:true,
      onProgress:(p)=>PB.set(W.data+p), progressWeight:W.wasm, boostAfter:0.10
    });

    const [dataAB, wasmAB] = await Promise.all([dataP, wasmP]);
    const dataBlob = URL.createObjectURL(new Blob([dataAB],{type:"application/octet-stream"}));
    const wasmBlob = URL.createObjectURL(new Blob([wasmAB],{type:"application/wasm"}));

    const patched = { ...config, dataUrl:dataBlob, codeUrl:wasmBlob };
    const unityOnProgress = (p)=>PB.unity(p);

    PB.set(W.data + W.wasm + 0.02);
    const inst = await window.createUnityInstance(canvas, patched, unityOnProgress)
      .catch(e=>{ console.error(`${TAG} createUnityInstance error`, e); throw e; });

    PB.set(W.data + W.wasm + W.beforeRun);
    PB.done();

    addEventListener("pagehide", ()=>{ try{URL.revokeObjectURL(dataBlob);}catch{} try{URL.revokeObjectURL(wasmBlob);}catch{} }, {once:true});
    console.log(`${TAG} Unity instance ready`);
    return inst;
  }

  window.startUnityBr = startUnityBr;
  console.log(`${TAG} exported startUnityBr (typeof: ${typeof window.startUnityBr})`);
})();
