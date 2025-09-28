/* custom-loader.br.js
 * Unity WebGL BR Loader (outer loader, no global fetch hook)
 * - Downloads .wasm.br & .data.br
 * - Decompresses (Brotli) in JS
 * - Rewrites to blob: URLs with proper MIME
 * - Calls inner loader's createUnityInstance
 */
(() => {
  const TAG = "[br-loader]";
  console.log(`${TAG} file loaded`);

  // ---------------- small utils ----------------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const clamp01 = (v) => Math.max(0, Math.min(1, v ?? 0));

  const once = (fn) => {
    let done = false, p;
    return (...args) => done ? p : (done = true, p = fn(...args));
  };

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.async = false; // preserve order
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

  // Patch instantiateStreaming to be robust (blob: is fine, but keep fallback)
  (function patchInstantiateStreaming() {
    const orig = WebAssembly.instantiateStreaming;
    if (!orig) {
      WebAssembly.instantiateStreaming = async (respPromise, importObject) => {
        const resp = await respPromise;
        const buf = await resp.arrayBuffer();
        return WebAssembly.instantiate(buf, importObject);
      };
      console.log(`${TAG} patched instantiateStreaming (polyfill)`);
      return;
    }
    WebAssembly.instantiateStreaming = async (respPromise, importObject) => {
      try { return await orig(respPromise, importObject); }
      catch (e) {
        console.warn(`${TAG} instantiateStreaming failed, falling back`, e);
        const resp = await respPromise;
        const buf = await resp.arrayBuffer();
        return WebAssembly.instantiate(buf, importObject);
      }
    };
    console.log(`${TAG} patched instantiateStreaming (fallback)`);
  })();

  // --------------- brotli decompress ---------------
  const hasDS = typeof DecompressionStream === "function";

  async function fetchDecompressBRToArrayBuffer(url, {
    mime = "application/octet-stream",
    noStore = false,
    onProgress = () => {},
    progressWeight = 1.0,   // share in [0..1] for this asset
    boostAfter = 0.08,      // virtual tail for CPU decompression
  } = {}) {
    if (!hasDS) {
      throw new Error(`${TAG} DecompressionStream('br') is not supported in this browser. Use the existing shim fallback or request a JS Brotli fallback build.`);
    }

    const res = await fetch(url, {
      cache: noStore ? "no-store" : "default",
    });
    if (!res.ok || !res.body) {
      throw new Error(`${TAG} fetch failed ${res.status} for ${url}`);
    }

    const total = Number(res.headers.get("content-length")) || 0;
    let read = 0;

    // Count compressed bytes to report smooth progress before/while decompressing
    const progressTap = new TransformStream({
      transform(chunk, ctlr) {
        read += chunk.byteLength || chunk.length || 0;
        const downloadPart = (1 - boostAfter);
        const p = total ? (read / total) * downloadPart : Math.min(downloadPart, (read / (1024 * 1024)) * 0.01);
        onProgress(clamp01(p) * progressWeight);
        ctlr.enqueue(chunk);
      }
    });

    const ds = new DecompressionStream("br");
    const decompressedStream = res.body
      .pipeThrough(progressTap)
      .pipeThrough(ds);

    // Collect decompressed into ArrayBuffer
    const decompressedResp = new Response(decompressedStream, { headers: { "Content-Type": mime } });
    const ab = await decompressedResp.arrayBuffer();

    // Smooth tail to visualize CPU work
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      await sleep(8);
      const p = (1 - boostAfter) + boostAfter * (i / steps);
      onProgress(clamp01(p) * progressWeight);
    }

    return ab;
  }

  function arrayBufferToBlobUrl(ab, mime) {
    const b = new Blob([ab], { type: mime });
    return URL.createObjectURL(b);
  }

  // --------------- progress combiner ---------------
  function makeProgressBridge(userOnProgress) {
    const ui = { unityMax: 0, loader: 0 };
    const notify = () => {
      const p = Math.max(ui.unityMax, ui.loader);
      try { userOnProgress?.(clamp01(p)); } catch {}
    };
    return {
      unity(p) { ui.unityMax = Math.max(ui.unityMax, clamp01(p)); notify(); },
      set(p)  { ui.loader = clamp01(p); notify(); },
      bump(dp){ ui.loader = clamp01(ui.loader + dp); notify(); },
      done()  { ui.loader = 1; ui.unityMax = Math.max(ui.unityMax, 1); notify(); },
    };
  }

  // --------------- public API ----------------
  async function startUnityBr(canvas, config, userOnProgress) {
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
    const W = { data: 0.42, wasm: 0.48, beforeRun: 0.10 }; // sum <= 1

    PB.set(0.02);

    // 1) Inner loader (once)
    await loadInnerLoaderOnce(innerLoaderUrl);
    PB.bump(0.02);

    // 2) Parallel download + decompress
    const dataPromise = fetchDecompressBRToArrayBuffer(dataUrl, {
      mime: "application/octet-stream",
      noStore: false, // allow HTTP cache for data
      onProgress: (p) => PB.set(p), // occupies [0..W.data]
      progressWeight: W.data,
      boostAfter: 0.08,
    });

    const wasmPromise = fetchDecompressBRToArrayBuffer(codeUrl, {
      mime: "application/wasm",
      noStore: true, // strict fresh for wasm
      onProgress: (p) => PB.set(W.data + p), // occupies [W.data..W.data+W.wasm]
      progressWeight: W.wasm,
      boostAfter: 0.10,
    });

    const [dataAB, wasmAB] = await Promise.all([dataPromise, wasmPromise]);

    // 3) Blob URLs (already decompressed)
    const dataBlobUrl = arrayBufferToBlobUrl(dataAB, "application/octet-stream");
    const wasmBlobUrl = arrayBufferToBlobUrl(wasmAB, "application/wasm");

    // 4) Patch config for inner loader
    const patchedConfig = {
      ...config,
      dataUrl: dataBlobUrl,
      codeUrl: wasmBlobUrl,
      // frameworkUrl stays as is (normal js)
    };

    // 5) Bridge Unity progress
    const unityOnProgress = (p) => PB.unity(p);

    PB.set(W.data + W.wasm + 0.02);

    // 6) Call inner loader
    console.log(`${TAG} calling createUnityInstance`);
    const instance = await window.createUnityInstance(canvas, patchedConfig, unityOnProgress)
      .catch(err => {
        console.error(`${TAG} createUnityInstance error`, err);
        throw err;
      });

    PB.set(W.data + W.wasm + W.beforeRun);
    PB.done();

    // 7) Cleanup
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
