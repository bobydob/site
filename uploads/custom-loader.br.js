/* custom-loader.br.js — Unity WebGL BR loader (v2, worker + JS/WASM Brotli)
   API: window.startUnityBr(canvas, config, onProgress)
   Notes:
   - Decompresses .wasm.br and .data.br in a Web Worker using a built-in fallback chain:
       1) brotli-dec-wasm (WASM, small ~200KB) via jsDelivr
       2) wasm-brotli (WASM, bigger ~1.6MB) via jsDelivr
       3) brotli-js (pure JS, ~90KB) via jsDelivr
     You can later inline any of these to remove the external dependency.
   - Then it feeds already-decompressed blob: URLs to Unity's inner loader.js (config.innerLoaderUrl).
*/
(() => {
  const TAG = "[br-loader]";
  const log  = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err  = (...a) => console.error(TAG, ...a);

  log("file loaded");

  // ————————————————————————————————————————————————————————————————————————————
  // Helpers

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function assert(cond, message) {
    if (!cond) throw new Error(`${TAG} ${message}`);
  }

  // Streams → Uint8Array (with per-chunk progress callback)
  async function streamToU8(readable, onBytes) {
    const reader = readable.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        chunks.push(value);
        total += value.byteLength;
        onBytes && onBytes(value.byteLength, total);
      }
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  }

  // Fetch with progress (compressed bytes)
  async function fetchWithProgress(url, { cache = "default" } = {}, onProgress) {
    const res = await fetch(url, { cache });
    if (!res.ok) throw new Error(`${TAG} HTTP ${res.status} for ${url}`);
    const total = Number(res.headers.get("Content-Length")) || 0;
    let loaded = 0;

    const body = res.body ? res.body : new ReadableStream({
      start(controller) {
        res.arrayBuffer().then(buf => {
          controller.enqueue(new Uint8Array(buf));
          controller.close();
        }).catch(e => controller.error(e));
      }
    });

    const u8 = await streamToU8(body, (delta) => {
      loaded += delta;
      if (onProgress && total) onProgress(loaded, total);
    });
    if (onProgress && !total) onProgress(loaded, loaded);
    return { u8, res };
  }

  // Progress combiner: pre (download+inflate) → tail (Unity init)
  function chainProgress(preCap, outer) {
    let last = 0;
    return {
      pre(v) {
        const clamped = Math.max(0, Math.min(preCap, v));
        last = clamped;
        outer && outer(clamped);
      },
      tail(inner) {
        const mapped = preCap + (1 - preCap) * inner;
        last = Math.max(last, mapped);
        outer && outer(last);
      }
    };
  }

  // ————————————————————————————————————————————————————————————————————————————
  // Worker that performs Brotli decompression. It tries multiple public decoders.
  // You can later replace CDN URLs with your self-hosted copies (same filenames).

  function makeBrotliWorkerBlob() {
    const workerSrc = `
      let decoderReady = null;
      let decodeFn = null;

      function asU8(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }

      async function tryLoad_brotli_dec_wasm() {
        // wasm-pack style: loads JS glue and then the wasm file.
        const base = "https://cdn.jsdelivr.net/npm/brotli-dec-wasm@2.3.0/pkg";
        importScripts(base + "/brotli_dec_wasm.js");
        // wasm-pack usually exposes a default initializer or a wasm_bindgen function.
        const init = self.__wbg_init || self.init || self.default || self.wasm_bindgen;
        if (typeof init !== "function") return false;
        try {
          await init(base + "/brotli_dec_wasm_bg.wasm");
        } catch(e) {
          // Some builds expect init() without URL (embedded base64). Retry once.
          try { await init(); } catch(_) { return false; }
        }
        // Heuristic: exported function names we might find
        const candidates = [
          // wasm-pack exported names (guess list)
          self.decompress, self.brotli_decompress, self.brotliDecompress,
          (self.wasm_bindgen && self.wasm_bindgen.decompress),
          (self.wasm_bindgen && self.wasm_bindgen.brotli_decompress),
        ].filter(Boolean);
        for (const f of candidates) {
          try {
            const test = f(new Uint8Array([27])); // invalid data, should throw
            // If it didn't throw, ignore. We'll still use it if signature matches later.
          } catch {}
          if (typeof f === "function") {
            decodeFn = (u8) => asU8(f(u8));
            return true;
          }
        }
        return false;
      }

      async function tryLoad_wasm_brotli() {
        // wasm-brotli package (Rust) for browsers
        const base = "https://cdn.jsdelivr.net/npm/wasm-brotli@2.0.2";
        importScripts(base + "/wasm_brotli_browser.js");
        // Exposed APIs vary: init (async) + { decompress } or similar
        const init = self.init || self.default || self.wasm_brotli_init;
        try {
          if (typeof init === "function") {
            try { await init(base + "/wasm_brotli_browser_bg.wasm"); }
            catch { await init(); }
          }
        } catch {}
        const candidates = [
          self.decompress, self.decode, self.brotliDecompress,
        ].filter(Boolean);
        for (const f of candidates) {
          if (typeof f === "function") { decodeFn = (u8) => asU8(f(u8)); return true; }
        }
        // Some builds attach to a namespace object
        for (const k of Object.keys(self)) {
          const v = self[k];
          if (v && typeof v.decompress === "function") { decodeFn = (u8) => asU8(v.decompress(u8)); return true; }
          if (v && typeof v.decode      === "function") { decodeFn = (u8) => asU8(v.decode(u8));      return true; }
        }
        return false;
      }

      async function tryLoad_brotli_js() {
        // foliojs/brotli.js — pure JS fallback
        const url = "https://cdn.jsdelivr.net/npm/brotli@1.3.3/dist/brotli.min.js";
        importScripts(url);
        // Common symbols seen in the wild:
        if (typeof self.brotli === "object" && typeof self.brotli.decompress === "function") {
          decodeFn = (u8) => asU8(self.brotli.decompress(u8));
          return true;
        }
        if (typeof self.BrotliDecode === "function") {
          decodeFn = (u8) => asU8(self.BrotliDecode(u8));
          return true;
        }
        return false;
      }

      async function ensureDecoder() {
        if (decodeFn) return true;
        if (decoderReady) { await decoderReady; return !!decodeFn; }
        decoderReady = (async () => {
          if (await tryLoad_brotli_dec_wasm()) return true;
          if (await tryLoad_wasm_brotli()) return true;
          if (await tryLoad_brotli_js()) return true;
          return false;
        })();
        const ok = await decoderReady;
        return ok;
      }

      function postError(id, message) {
        self.postMessage({ id, error: String(message) });
      }
      function postData(id, u8) {
        self.postMessage({ id, ok: true, data: u8 }, [u8.buffer]);
      }

      self.onmessage = async (e) => {
        const { id, cmd, bytes } = e.data || {};
        if (cmd === "decompress") {
          try {
            const ok = await ensureDecoder();
            if (!ok) return postError(id, "No Brotli decoder available (all fallbacks failed). Host a decoder or inline it.");
            const input = asU8(bytes);
            let out = null;
            try {
              out = decodeFn(input);
            } catch (ex) {
              return postError(id, "Decoder threw: " + (ex && ex.message || ex));
            }
            if (!(out instanceof Uint8Array)) {
              // Some decoders return ArrayBuffer
              out = new Uint8Array(out);
            }
            return postData(id, out);
          } catch (ex) {
            return postError(id, ex && ex.message || ex);
          }
        }
      };
    `;
    return new Blob([workerSrc], { type: "application/javascript" });
  }

  class BrotliWorker {
    constructor() {
      this._worker = new Worker(URL.createObjectURL(makeBrotliWorkerBlob()));
      this._nextId = 1;
      this._pending = new Map();
      this._worker.onmessage = (e) => {
        const { id, ok, data, error } = e.data || {};
        const p = this._pending.get(id);
        if (!p) return;
        this._pending.delete(id);
        if (ok) p.resolve(data);
        else p.reject(new Error(error || "Unknown worker error"));
      };
      this._worker.onerror = (e) => {
        console.error(TAG, "worker error", e && e.message);
      };
    }
    decompress(u8) {
      const id = this._nextId++;
      return new Promise((resolve, reject) => {
        this._pending.set(id, { resolve, reject });
        this._worker.postMessage({ id, cmd: "decompress", bytes: u8 }, [u8.buffer]);
      });
    }
  }

  let sharedBrotli = null;
  function getBrotli() {
    if (!sharedBrotli) sharedBrotli = new BrotliWorker();
    return sharedBrotli;
  }

  // ————————————————————————————————————————————————————————————————————————————
  // Public API

  async function startUnityBr(canvas, userConfig, onProgress) {
    try {
      assert(canvas && canvas instanceof HTMLCanvasElement, "canvas is missing/invalid");
      assert(userConfig && typeof userConfig === "object", "config must be an object");

      const {
        dataUrl,
        codeUrl,
        frameworkUrl,
        innerLoaderUrl,
        streamingAssetsUrl,
        ...rest
      } = userConfig;

      assert(innerLoaderUrl, "config.innerLoaderUrl is required");
      assert(dataUrl && codeUrl && frameworkUrl, "config.{dataUrl,codeUrl,frameworkUrl} are required");

      log("start → downloading & inflating .br assets");

      const preCap = 0.85;
      const prog = chainProgress(preCap, (p) => {
        if (!onProgress) return;
        onProgress(Math.max(p, 0.05));
      });

      // 1) Download compressed assets
      let wasmLoaded = 0, wasmTotal = 0;
      const wasmFetch = fetchWithProgress(codeUrl, { cache: "no-store" }, (l, t) => {
        wasmLoaded = l; wasmTotal = t;
        const dlPart = 0.5 * (wasmTotal ? l / wasmTotal : 1);
        prog.pre(0.30 * dlPart);
      });

      let dataLoaded = 0, dataTotal = 0;
      const dataFetch = fetchWithProgress(dataUrl, { cache: "default" }, (l, t) => {
        dataLoaded = l; dataTotal = t;
        const dlPart = 0.5 * (dataTotal ? l / dataTotal : 1);
        prog.pre(0.30 + 0.40 * dlPart);
      });

      const [{ u8: wasmBr }, { u8: dataBr }] = await Promise.all([wasmFetch, dataFetch]);

      // 2) Decompress in a Web Worker
      const brotli = getBrotli();

      const wasmDecompTarget = 0.30 + 0.20;
      const dataDecompTarget = 0.30 + 0.40 + 0.15;

      const wasmDecomp = (async () => {
        const out = await brotli.decompress(wasmBr);
        prog.pre(wasmDecompTarget);
        return out;
      })();

      const dataDecomp = (async () => {
        const out = await brotli.decompress(dataBr);
        prog.pre(dataDecompTarget);
        return out;
      })();

      const [wasmU8, dataU8] = await Promise.all([wasmDecomp, dataDecomp]);

      // 3) Sanity check WASM magic
      if (!(wasmU8[0] === 0x00 && wasmU8[1] === 0x61 && wasmU8[2] === 0x73 && wasmU8[3] === 0x6D)) {
        throw new Error("WASM magic not found after decompression");
      }

      // 4) Create blob: URLs
      const wasmBlob = new Blob([wasmU8], { type: "application/wasm" });
      const dataBlob = new Blob([dataU8], { type: "application/octet-stream" });
      const wasmUrl  = URL.createObjectURL(wasmBlob);
      const dataUrl2 = URL.createObjectURL(dataBlob);

      log("assets ready → loading inner loader:", innerLoaderUrl);

      // 5) Load Unity's inner loader.js and start the game
      await new Promise((resolve, reject) => {
        if (document.querySelector(\`script[data-br-inner="\${innerLoaderUrl}"]\`)) return resolve();
        const s = document.createElement("script");
        s.src = innerLoaderUrl;
        s.async = true;
        s.dataset.brInner = innerLoaderUrl;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(TAG + " failed to load innerLoaderUrl"));
        document.body.appendChild(s);
      });

      assert(typeof createUnityInstance === "function", "inner loader did not define createUnityInstance");

      const cfg = {
        ...rest,
        frameworkUrl,
        codeUrl: wasmUrl,
        dataUrl: dataUrl2,
        streamingAssetsUrl,
      };

      const unity = await createUnityInstance(canvas, cfg, (p) => {
        prog.tail(Math.max(0, Math.min(1, p)));
      });

      for (let i = 0; i < 3; i++) { prog.tail(1); await sleep(16); }

      log("Unity instance started");
      return unity;

    } catch (e) {
      err(e && e.stack ? e.stack : String(e));
      throw e;
    }
  }

  window.startUnityBr = startUnityBr;
  log("exported startUnityBr:", typeof window.startUnityBr);
})();