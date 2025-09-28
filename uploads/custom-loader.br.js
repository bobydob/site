/* custom-loader.br.js — Unity WebGL BR loader (jsDelivr-friendly)
   API: window.startUnityBr(canvas, config, onProgress)
   Requires: browser with DecompressionStream('br') (Chromium/Edge/Opera/Safari TP).
*/
(() => {
  const TAG = '[br-loader]';

  const log  = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err  = (...a) => console.error(TAG, ...a);

  log('file loaded');

  // ─────────────────────────────────────────────────────────────────────────────
  // Small utils
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function assert(cond, message) {
    if (!cond) throw new Error(`${TAG} ${message}`);
  }

  // ReadableStream → Uint8Array, with progress (bytes)
  async function streamToUint8Array(stream, onBytes) {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        chunks.push(value);
        total += value.byteLength;
        if (onBytes) onBytes(value.byteLength, total);
      }
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  }

  // Fetch with progress (compressed bytes)
  async function fetchWithProgress(url, { cache = 'default' } = {}, onProgress) {
    const res = await fetch(url, { cache });
    if (!res.ok) throw new Error(`${TAG} HTTP ${res.status} for ${url}`);
    const total = Number(res.headers.get('Content-Length')) || 0;
    let loaded = 0;
    const body = res.body ? res.body : new ReadableStream({
      start(controller) {
        res.arrayBuffer().then(buf => {
          controller.enqueue(new Uint8Array(buf));
          controller.close();
        }).catch(e => controller.error(e));
      }
    });
    const u8 = await streamToUint8Array(body, (delta) => {
      loaded += delta;
      if (onProgress && total) onProgress(loaded, total);
    });
    if (onProgress && !total) onProgress(loaded, loaded); // unknown length → treat as 100%
    return { u8, res };
  }

  // Brotli decompress (streaming) with progress "boost"
  async function brotliDecompress(u8, onProgress) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error(`${TAG} This browser lacks DecompressionStream('br'). Use Chrome/Edge/Opera, or provide a JS Brotli fallback.`);
    }
    // Feed the compressed bytes via a stream
    const readable = new ReadableStream({
      start(controller) { controller.enqueue(u8); controller.close(); }
    });
    const ds = new DecompressionStream('br');
    const decompressed = readable.pipeThrough(ds);

    // We don't know the final size in advance. For smoothness we emulate a
    // "virtual" total = compressedSize * 4.5 and ramp up while reading.
    const virtTotal = Math.max(u8.byteLength * 4.5, u8.byteLength + 1);
    let virtLoaded = 0;

    const out = await streamToUint8Array(decompressed, (delta) => {
      virtLoaded += delta;
      if (onProgress) {
        const v = Math.min(virtLoaded, virtTotal);
        onProgress(v, virtTotal);
      }
    });

    // Finish at 100% for the decompress phase
    if (onProgress) onProgress(virtTotal, virtTotal);
    return out;
  }

  // Load a JS file once
  async function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-br-loader="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.dataset.brLoader = src;
      s.onload = () => resolve();
      s.onerror = (e) => reject(new Error(`${TAG} failed to load ${src}`));
      document.body.appendChild(s);
    });
  }

  // Map our pre-init progress [0..preCap] + Unity init tail [preCap..1]
  function chainProgress(preCap, outerOnProgress) {
    let last = 0;
    return {
      pre(v) {
        const clamped = Math.max(0, Math.min(preCap, v));
        last = clamped;
        outerOnProgress && outerOnProgress(clamped);
      },
      tail(inner) {
        const mapped = preCap + (1 - preCap) * inner;
        last = Math.max(last, mapped);
        outerOnProgress && outerOnProgress(last);
      }
    };
  }

  // Public API: startUnityBr
  async function startUnityBr(canvas, userConfig, onProgress) {
    try {
      assert(canvas && canvas instanceof HTMLCanvasElement, 'canvas is missing/invalid');
      assert(userConfig && typeof userConfig === 'object', 'config must be an object');

      const {
        dataUrl,
        codeUrl,
        frameworkUrl,
        innerLoaderUrl,     // REQUIRED: your classic loader.js (Unity’s)
        streamingAssetsUrl, // passthrough
        ...rest
      } = userConfig;

      assert(innerLoaderUrl, 'config.innerLoaderUrl is required');
      assert(dataUrl && codeUrl && frameworkUrl, 'config.{dataUrl,codeUrl,frameworkUrl} are required');

      log('start → downloading & inflating .br assets');

      // Our progress combiner
      const preCap = 0.85; // up to 85% before handing off to Unity’s own progress
      const prog = chainProgress(preCap, (p) => {
        if (!onProgress) return;
        // Respect UI contract: floor at 0.05 so the bar appears
        onProgress(Math.max(p, 0.05));
      });

      // 1) Fetch compressed .wasm.br (fresh, no-store)
      let wasmLoaded = 0, wasmTotal = 0;
      const wasmFetch = fetchWithProgress(codeUrl, { cache: 'no-store' }, (l, t) => {
        wasmLoaded = l; wasmTotal = t;
        // Weight downloads vs decompression 50/50 inside preCap
        const dlPart = 0.5 * (wasmTotal ? l / wasmTotal : 1);
        prog.pre(0.30 * dlPart); // allocate 30% of bar to wasm phase
      });

      // 2) Fetch compressed .data.br (allow HTTP cache)
      let dataLoaded = 0, dataTotal = 0;
      const dataFetch = fetchWithProgress(dataUrl, { cache: 'default' }, (l, t) => {
        dataLoaded = l; dataTotal = t;
        const dlPart = 0.5 * (dataTotal ? l / dataTotal : 1);
        // allocate 40% of bar to data phase
        prog.pre(0.30 + 0.40 * dlPart);
      });

      const [{ u8: wasmBr }, { u8: dataBr }] = await Promise.all([wasmFetch, dataFetch]);

      // 3) Decompress both with smooth virtual progress
      // Split remaining of preCap between decompressions
      const wasmDecompTarget = 0.30 + 0.20; // +20%
      const dataDecompTarget = 0.30 + 0.40 + 0.15; // +15% (keeps 0.85 headroom)

      const wasmDecomp = brotliDecompress(wasmBr, (virtLoaded, virtTotal) => {
        const ratio = virtTotal ? virtLoaded / virtTotal : 1;
        prog.pre(0.30 + 0.20 * ratio);
      });

      const dataDecomp = brotliDecompress(dataBr, (virtLoaded, virtTotal) => {
        const ratio = virtTotal ? virtLoaded / virtTotal : 1;
        prog.pre(0.70 + 0.15 * ratio);
      });

      const [wasmU8, dataU8] = await Promise.all([wasmDecomp, dataDecomp]);

      // Sanity for WASM magic: 00 61 73 6d
      assert(wasmU8[0] === 0x00 && wasmU8[1] === 0x61 && wasmU8[2] === 0x73 && wasmU8[3] === 0x6D,
        'WASM magic not found after decompression');

      // 4) Blob URLs
      const wasmBlob = new Blob([wasmU8], { type: 'application/wasm' });
      const dataBlob = new Blob([dataU8], { type: 'application/octet-stream' });
      const wasmUrl  = URL.createObjectURL(wasmBlob); // ends with blob:<uuid>
      const dataUrl2 = URL.createObjectURL(dataBlob);

      log('assets ready → loading inner loader:', innerLoaderUrl);

      // 5) Load inner Unity loader.js, then call createUnityInstance with swapped URLs
      await loadScriptOnce(innerLoaderUrl);
      assert(typeof createUnityInstance === 'function', 'inner loader did not define createUnityInstance');

      // Build config for Unity
      const cfg = {
        ...rest,
        frameworkUrl,            // as is (plain JS)
        codeUrl: wasmUrl,        // decompressed .wasm
        dataUrl: dataUrl2,       // decompressed .data
        streamingAssetsUrl,      // passthrough
      };

      // 6) Kick Unity. We map its own progress into the tail [0.85..1]
      const unity = await createUnityInstance(canvas, cfg, (p) => {
        // p is [0..1] for Unity initialization
        prog.tail(Math.max(0, Math.min(1, p)));
      });

      // A touch of UX smoothness: make sure we end at full bar
      for (let i = 0; i < 3; i++) { prog.tail(1); await sleep(16); }

      log('Unity instance started');
      return unity;

    } catch (e) {
      err(e && e.stack ? e.stack : String(e));
      throw e;
    }
  }

  // Export
  window.startUnityBr = startUnityBr;
  log('exported startUnityBr:', typeof window.startUnityBr);
})();
