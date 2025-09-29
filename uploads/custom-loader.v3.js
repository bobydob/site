/* custom-loader.v3.js — Unity WebGL BR loader (pure main thread, requires brotli.min.js)
   Usage:
     1) Include brotli decoder BEFORE this file:
        <script src="https://cdn.jsdelivr.net/npm/brotli@1.3.3/dist/brotli.min.js"></script>
     2) Include this file.
     3) Call window.startUnityBr(canvas, config, onProgress).
*/
(() => {
  const TAG = "[br-loader]";
  const log  = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err  = (...a) => console.error(TAG, ...a);

  log("file loaded");

  // Helpers
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  function assert(cond, message) { if (!cond) throw new Error(`${TAG} ${message}`); }

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

  async function fetchWithProgress(url, { cache = "default" } = {}, onProgress) {
    const res = await fetch(url, { cache });
    if (!res.ok) throw new Error(`${TAG} HTTP ${res.status} for ${url}`);
    const total = Number(res.headers.get("Content-Length")) || 0;
    let loaded = 0;
    const body = res.body ? res.body : new ReadableStream({
      start(controller) {
        res.arrayBuffer().then(buf => { controller.enqueue(new Uint8Array(buf)); controller.close(); })
                         .catch(e => controller.error(e));
      }
    });
    const u8 = await streamToU8(body, (delta) => {
      loaded += delta;
      if (onProgress && total) onProgress(loaded, total);
    });
    if (onProgress && !total) onProgress(loaded, loaded);
    return { u8, res };
  }

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

  function getDecoder() {
    // Accept either brotli.decompress (foliojs)
    // or global BrotliDecode function.
    if (self.brotli && typeof self.brotli.decompress === "function") {
      return (u8) => self.brotli.decompress(u8);
    }
    if (typeof self.BrotliDecode === "function") {
      return (u8) => self.BrotliDecode(u8);
    }
    return null;
  }

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

      const dec = getDecoder();
      if (!dec) {
        throw new Error("Brotli decoder not found on page. Include <script src=\"https://cdn.jsdelivr.net/npm/brotli@1.3.3/dist/brotli.min.js\"></script> BEFORE custom-loader.v3.js");
      }

      log("start → downloading & inflating .br assets");

      const preCap = 0.85;
      const prog = chainProgress(preCap, (p) => {
        if (!onProgress) return;
        onProgress(Math.max(p, 0.05));
      });

      // Download compressed assets
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

      // Decompress (main thread)
      const wasmU8 = new Uint8Array(dec(wasmBr));
      prog.pre(0.50); // bump after decompress start (simple pacing)

      const dataU8 = new Uint8Array(dec(dataBr));
      prog.pre(0.75);

      // Sanity check WASM magic
      if (!(wasmU8[0] === 0x00 && wasmU8[1] === 0x61 && wasmU8[2] === 0x73 && wasmU8[3] === 0x6D)) {
        throw new Error("WASM magic not found after decompression");
      }

      const wasmBlob = new Blob([wasmU8], { type: "application/wasm" });
      const dataBlob = new Blob([dataU8], { type: "application/octet-stream" });
      const wasmUrl  = URL.createObjectURL(wasmBlob);
      const dataUrl2 = URL.createObjectURL(dataBlob);

      log("assets ready → loading inner loader:", innerLoaderUrl);

      await new Promise((resolve, reject) => {
        if (document.querySelector(`script[data-br-inner="${innerLoaderUrl}"]`)) return resolve();
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