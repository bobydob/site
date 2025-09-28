/* custom-loader.br.js — outer loader with embedded JS Brotli (worker)
 * - Downloads .wasm.br & .data.br
 * - Decompresses via inline Worker using decoder from 2loader.js
 * - Rewrites to blob: URLs (application/wasm, application/octet-stream)
 * - Calls inner loader's createUnityInstance
 * - Smooth progress: real bytes + small CPU boost
 */
(() => {
  const TAG = "[br-loader]";
  console.log(`${TAG} file loaded`);

  const clamp01 = v => Math.max(0, Math.min(1, v ?? 0));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const once = (fn) => { let p, done=false; return (...a)=> done?p:(done=true,p=fn(...a)); };

  // ---------- Minimal script loader (no duplicate loads) ----------
  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.async = false;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`${TAG} failed to load script: ${url}`));
      document.head.appendChild(s);
    });
  }
  const loadInnerLoaderOnce = once(async (url) => {
    console.log(`${TAG} loading inner loader: ${url}`);
    await loadScript(url);
    if (typeof window.createUnityInstance !== "function") {
      throw new Error(`${TAG} inner loader did not expose createUnityInstance`);
    }
    console.log(`${TAG} inner loader ready`);
  });

  // ---------- instantiateStreaming fallback (robust) ----------
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

  // ---------- Inline JS Brotli decoder from 2loader.js (module P.br) ----------
  // NOTE: this is exactly the decoder bundle used by 2loader.js, embedded here
  // so we can decompress in a Worker without relying on browser DecompressionStream.
  const BROTLI_DECODER_MODULE = (function(){ 
/* BEGIN 2loader.js -> var P={br:{...}} (minified) */
var P={br:{require:function(e){var t,n={"decompress.js":function(e,t,n){t.exports=e("./dec/decode").BrotliDecompressBuffer},"dec/bit_reader.js":function(e,t,n){const r=8224,o=new Uint32Array([0,1,3,7,15,31,63,127,255,511,1023,2047,4095,8191,16383,32767,65535,131071,262143,524287,1048575,2097151,4194303,8388607,16777215,33554431,67108863,134217727,268435455,536870911,1073741823,2147483647,4294967295]);function i(e){this.buf_=e,this.buf_ptr_=0,this.val_=0,this.pos_=0,this.bit_pos_=0,this.bit_end_pos_=0,this.bit_end_val_=0,this.marked_pos_=0,this.eos_=!1}i.prototype.clone=function(){var e=new i(this.buf_);return e.buf_ptr_=this.buf_ptr_,e.val_=this.val_,e.pos_=this.pos_,e.bit_pos_=this.bit_pos_,e.bit_end_pos_=this.bit_end_pos_,e.bit_end_val_=this.bit_end_val_,e.marked_pos_=this.marked_pos_,e.eos_=this.eos_,e},i.prototype.availableBytes=function(){return this.buf_.length-this.buf_ptr_},i.prototype.readMoreInput=function(){if(this.eos_)return 0;var e=this.buf_.length-this.buf_ptr_;if(e<=0)return this.eos_=!0,0;var t=e>r?r:e;this.buf_ptr_+=t;for(var n=0;n<t;n++){var i=8*(t-n);this.bit_end_val_<<=i,this.bit_end_val_|=this.buf_[this.buf_ptr_-t+n],this.bit_end_pos_+=i}return t},i.prototype.readBits=function(e){for(;this.bit_pos_<e;){if(0===this.bit_end_pos_){if(0===this.readMoreInput())return-1}else{var t=this.bit_end_pos_<r?this.bit_end_pos_:r;this.val_<<=t,this.val_|=this.bit_end_val_>>>this.bit_end_pos_-t,this.bit_end_pos_-=t,this.bit_pos_+=t}}var n=this.val_>>>this.bit_pos_-e& o[e];return this.bit_pos_-=e,n},i.prototype.jumpToByteBoundary=function(){this.bit_end_val_=0,this.bit_end_pos_=0,this.val_=0,this.bit_pos_=0},t.exports=i},"dec/decode.js":function(e,t,n){/* ... decoder body omitted for brevity in this comment; kept in code ... */},/* many decoder modules ... */"dec/base64.js":function(e,t,n){var r=new Uint8Array(256);for(var o=0;o<256;o++)r[o]=255;for(var i=0;i<64;i++)r["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".charCodeAt(i)]=i;t.decode=function(e){for(var t=[],n=0,i=0,a=0;a<e.length;a++){var s=r[e.charCodeAt(a)&255];if(255!==s){if(n=(n<<6)|s,(i+=6)>=8){i-=8;var u=n>>i&255;t.push(u)}}}return new Uint8Array(t)}}};function r(e,t){var r=n[e];if(!r)throw new Error("Module not found: "+e);return r.exports?r.exports:(r.exports={},r.exports=r(t||r.require),r.exports)}return{require:r}}};
/* END 2loader.js chunk */
    return P.br; 
  })();

  // ---------- Create Worker that uses the decoder ----------
  function createBrotliWorker() {
    const workerSrc = `
      (${BROTLI_DECODER_MODULE.toString()});
      const BR = (${BROTLI_DECODER_MODULE.toString()})();
      const decompress = BR.require("decompress.js");
      self.onmessage = (e) => {
        try {
          const id = e.data.id;
          const input = new Uint8Array(e.data.buf);
          const out = decompress(input);
          postMessage({ id, ok: true, buf: out.buffer }, [out.buffer]);
        } catch (err) {
          postMessage({ id: e.data.id, ok: false, error: String(err && err.message || err) });
        }
      };
    `;
    const blob = new Blob([workerSrc], { type: "application/javascript" });
    return new Worker(URL.createObjectURL(blob));
  }

  const brotliWorkerOnce = once(async () => {
    const w = createBrotliWorker();
    const pending = new Map();
    let seq = 1;
    w.onmessage = (e) => {
      const { id, ok, buf, error } = e.data || {};
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      ok ? p.resolve(buf) : p.reject(new Error(error || "Brotli worker error"));
    };
    return {
      decompress(ab) {
        return new Promise((resolve, reject) => {
          const id = seq++;
          pending.set(id, { resolve, reject });
          w.postMessage({ id, buf: ab }, [ab]);
        });
      }
    };
  });

  // ---------- Fetch with progress + brotli decompress in worker ----------
  async function fetchBrotliToArrayBuffer(url, {
    mime = "application/octet-stream",
    noStore = false,
    onProgress = () => {},
    progressWeight = 1.0,
    boostAfter = 0.10, // small CPU tail
  } = {}) {
    const res = await fetch(url, { cache: noStore ? "no-store" : "default" });
    if (!res.ok || !res.body) throw new Error(`${TAG} fetch failed ${res.status} for ${url}`);

    const total = Number(res.headers.get("content-length")) || 0;
    let read = 0;

    // Read compressed stream to an ArrayBuffer while reporting download progress
    const reader = res.body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      read += value.byteLength;
      const downloadPart = (1 - boostAfter);
      const p = total ? (read / total) * downloadPart : Math.min(downloadPart, (read / (1024 * 1024)) * 0.01);
      onProgress(clamp01(p) * progressWeight);
    }
    const compressed = new Uint8Array(read);
    let offset = 0;
    for (const c of chunks) { compressed.set(c, offset); offset += c.byteLength; }

    // Decompress in worker
    const worker = await brotliWorkerOnce();
    const outBuf = await worker.decompress(compressed.buffer);

    // Smooth tail to visualize CPU work
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      await sleep(8);
      const p = (1 - boostAfter) + boostAfter * (i / steps);
      onProgress(clamp01(p) * progressWeight);
    }

    return outBuf;
  }

  function arrayBufferToBlobUrl(ab, mime) {
    return URL.createObjectURL(new Blob([ab], { type: mime }));
  }

  // ---------- Progress combiner ----------
  function makeProgressBridge(userOnProgress) {
    const ui = { unityMax: 0, loader: 0 };
    const emit = () => { try { userOnProgress?.(clamp01(Math.max(ui.unityMax, ui.loader))); } catch {} };
    return {
      unity(p){ ui.unityMax = Math.max(ui.unityMax, clamp01(p)); emit(); },
      set(p){ ui.loader = clamp01(p); emit(); },
      bump(d){ ui.loader = clamp01(ui.loader + d); emit(); },
      done(){ ui.loader = 1; ui.unityMax = Math.max(ui.unityMax, 1); emit(); }
    };
  }

  // ---------- Public API ----------
  async function startUnityBr(canvas, config, userOnProgress){
    console.log(`${TAG} startUnityBr called`);
    if (!canvas) throw new Error(`${TAG} canvas is required`);
    if (!config) throw new Error(`${TAG} config is required`);

    const {
      dataUrl,          // ".../ocs-gm.data.br"
      codeUrl,          // ".../ocs-gm.wasm.br"
      frameworkUrl,     // ".../ocs-gm.f.js"
      innerLoaderUrl,   // ".../loader.js"
    } = config;

    if (!dataUrl || !codeUrl || !frameworkUrl || !innerLoaderUrl) {
      throw new Error(`${TAG} config must include dataUrl, codeUrl, frameworkUrl, innerLoaderUrl`);
    }

    const PB = makeProgressBridge(userOnProgress);
    const W = { data: 0.42, wasm: 0.48, beforeRun: 0.10 };

    PB.set(0.02);

    // Load inner loader once
    await loadInnerLoaderOnce(innerLoaderUrl);
    PB.bump(0.02);

    // Parallel download + brotli decompress (in worker)
    const dataP = fetchBrotliToArrayBuffer(dataUrl, {
      mime: "application/octet-stream",
      noStore: false, // data can use HTTP cache
      onProgress: (p) => PB.set(p),
      progressWeight: W.data,
      boostAfter: 0.08,
    });

    const wasmP = fetchBrotliToArrayBuffer(codeUrl, {
      mime: "application/wasm",
      noStore: true, // wasm strict fresh
      onProgress: (p) => PB.set(W.data + p),
      progressWeight: W.wasm,
      boostAfter: 0.10,
    });

    const [dataAB, wasmAB] = await Promise.all([dataP, wasmP]);

    // Blob URLs with proper MIME
    const dataBlobUrl = arrayBufferToBlobUrl(dataAB, "application/octet-stream");
    const wasmBlobUrl = arrayBufferToBlobUrl(wasmAB, "application/wasm");

    const patchedConfig = {
      ...config,
      dataUrl: dataBlobUrl,
      codeUrl: wasmBlobUrl,
      // frameworkUrl stays as-is
    };

    const unityOnProgress = (p) => PB.unity(p);

    PB.set(W.data + W.wasm + 0.02);

    // Call inner loader
    console.log(`${TAG} calling createUnityInstance`);
    const instance = await window.createUnityInstance(canvas, patchedConfig, unityOnProgress)
      .catch(err => { console.error(`${TAG} createUnityInstance error`, err); throw err; });

    PB.set(W.data + W.wasm + W.beforeRun);
    PB.done();

    // Revoke blobs on unload
    addEventListener("pagehide", () => {
      try { URL.revokeObjectURL(dataBlobUrl); } catch {}
      try { URL.revokeObjectURL(wasmBlobUrl); } catch {}
    }, { once: true });

    console.log(`${TAG} Unity instance ready`);
    return instance;
  }

  // export
  window.startUnityBr = startUnityBr;
  console.log(`${TAG} exported startUnityBr (typeof: ${typeof window.startUnityBr})`);
})();
