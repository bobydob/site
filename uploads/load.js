console.log("[br-loader] file loaded");
// custom-loader.br.js — ЛОАДЕР с распаковкой Brotli, без шима и без внешних ссылок
(() => {
  // ╭─────────────────────────────────────────────────────────────╮
  // │ 1) Brotli-декодер                                           │
  // │    По умолчанию — через встроенный DecompressionStream('br')│
  // │    Для 100% совместимости можно ВСТАВИТЬ свой P.br.decompress│
  // ╰─────────────────────────────────────────────────────────────╯
  async function brDecompress(u8 /* Uint8Array */) {
    // ВАРИАНТ A (по умолчанию): нативный декомпрессор браузера
    if (typeof DecompressionStream === "function") {
      const ds = new DecompressionStream("br");
      const input = new Blob([u8]).stream();
      const outAB = await new Response(input.pipeThrough(ds)).arrayBuffer();
      return new Uint8Array(outAB);
    }

    // ВАРИАНТ B (если нужен кросс-браузер): вставь свой декомпрессор сюда.
    // return P.br.decompress(u8); // REPLACE WITH P.br.decompress(...)

    throw new Error("Brotli decompressor missing: browser has no DecompressionStream and no inline decoder provided");
  }

  // ╭─────────────────────────────────────────────────────────────╮
  // │ 2) Утилиты                                                  │
  // ╰─────────────────────────────────────────────────────────────╯
  const isBr = u => /\.br(?:$|\?)/i.test(String(u||""));
  const toU8 = ab => (ab instanceof Uint8Array) ? ab : new Uint8Array(ab);
  const hasWasmMagic = u8 => u8 && u8.length >= 4 && u8[0]===0x00 && u8[1]===0x61 && u8[2]===0x73 && u8[3]===0x6D;       // '\0asm'
  const hasUnityFSMagic = u8 => u8 && u8.length >= 7 && u8[0]===0x55 && u8[1]===0x6E && u8[2]===0x69 && u8[3]===0x74 &&
                                  u8[4]===0x79 && u8[5]===0x46 && u8[6]===0x53;                                            // 'UnityFS'
  function blobURL(u8, mime){ return URL.createObjectURL(new Blob([u8], { type: mime })); }

  async function fetchAsU8(url, { cache="default", onBegin, onChunk } = {}) {
    const resp = await fetch(url, { mode:"cors", credentials:"omit", cache });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`);
    const len = parseInt(resp.headers.get("Content-Length")||"0",10)||0;
    onBegin && onBegin(len);

    if (!resp.body || !resp.body.getReader) {
      const buf = await resp.arrayBuffer();
      onChunk && onChunk(buf.byteLength||0, len);
      return new Uint8Array(buf);
    }
    const reader = resp.body.getReader();
    const chunks = []; let recvd = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (value && value.length) {
        chunks.push(value); recvd += value.length;
        onChunk && onChunk(value.length, len);
      }
    }
    let total = 0; for (const c of chunks) total += c.length;
    const out = new Uint8Array(total); let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  // ╭─────────────────────────────────────────────────────────────╮
  // │ 3) Прогресс по байтам (+ладный буст на распаковке)          │
  // ╰─────────────────────────────────────────────────────────────╯
  function makeProgress(onProgress){
    let totalKnown = 0, loaded = 0, phase = 0, last = 0;
    const draw = () => {
      const pNet = totalKnown ? (loaded/totalKnown) : Math.min(0.6, last + 0.02);
      const p = Math.min(0.98, pNet*0.85 + phase); // до 98%, финал отдаст inner loader
      last = Math.max(last, p);
      if (typeof onProgress === "function") onProgress(last);
    };
    return {
      onBegin(len){ if (len>0 && Number.isFinite(len)) totalKnown += len; draw(); },
      onChunk(n){ loaded += (n||0); draw(); },
      onDecompStart(){ phase = Math.max(phase, 0.08); draw(); },
      onDecompEnd(){ phase = Math.min(0.25, phase + 0.12); draw(); },
      finish(){ if (typeof onProgress === "function") onProgress(0.99); }
    };
  }

  // ╭─────────────────────────────────────────────────────────────╮
  // │ 4) Скачивание + распаковка .br → Uint8Array                 │
  // ╰─────────────────────────────────────────────────────────────╯
  async function loadAsset(url, type, prog){
    const u8 = await fetchAsU8(url, {
      cache: "default", // позволяем обычный HTTP-кэш (как в 2loader.js)
      onBegin: (len) => prog.onBegin(len),
      onChunk: (n)   => prog.onChunk(n),
    });

    if (!isBr(url)) return u8; // уже не brotli

    prog.onDecompStart();
    const out = toU8(await brDecompress(u8));
    prog.onDecompEnd();

    // защита от «двойной распаковки»/битых тел:
    if (type === "wasm") {
      if (hasWasmMagic(out)) return out;
      if (hasWasmMagic(u8))  return u8; // вдруг пришло уже разжатое
      throw new Error("WASM bad magic after decompress");
    } else {
      if (hasUnityFSMagic(out)) return out;
      if (hasUnityFSMagic(u8))  return u8;
      throw new Error("DATA bad magic after decompress");
    }
  }

  // ╭─────────────────────────────────────────────────────────────╮
  // │ 5) Подготовка ассетов и запуск внутреннего лоадера          │
  // ╰─────────────────────────────────────────────────────────────╯
  function loadScript(url){
    return new Promise((ok, err)=>{
      const s=document.createElement("script");
      s.src=url; s.async=true; s.onload=ok; s.onerror=()=>err(new Error("Script load failed: "+url));
      document.head.appendChild(s);
    });
  }

async function prepareAndRun(canvas, config, onProgress){
  if (!config || !config.frameworkUrl) throw new Error("config.frameworkUrl is required");
  const innerLoaderUrl = config.innerLoaderUrl;
  if (!innerLoaderUrl) throw new Error("config.innerLoaderUrl is required (path to your loader.js)");

  // 0) Сначала — внутренний loader.js (он объявит createUnityInstance)
  await loadScript(innerLoaderUrl);

  // 1) Framework — если ещё не подключён
  const fwUrl = String(config.frameworkUrl);
  let needFW = true;
  for (const s of document.scripts) {
    if (s.src && s.src.indexOf(fwUrl) !== -1) { needFW = false; break; }
  }
  if (needFW) await loadScript(fwUrl);

  // 2) Безопасный fallback для instantiateStreaming (blob/миме/кэш)
  if (WebAssembly.instantiateStreaming) {
    const orig = WebAssembly.instantiateStreaming;
    WebAssembly.instantiateStreaming = async (src, imp) => {
      try {
        const resp = await (src instanceof Promise ? src : Promise.resolve(src));
        try { return await orig(Promise.resolve(resp), imp); }
        catch { const buf = await resp.arrayBuffer(); return WebAssembly.instantiate(buf, imp); }
      } catch {
        const r = await fetch(src); const b = await r.arrayBuffer();
        return WebAssembly.instantiate(b, imp);
      }
    };
  }

  // 3) Скачиваем и распаковываем .br
  const prog = makeProgress(onProgress);
  const [wasmU8, dataU8] = await Promise.all([
    loadAsset(String(config.codeUrl||""), "wasm", prog),
    loadAsset(String(config.dataUrl||""), "data", prog),
  ]);
  prog.finish();

  // 4) Подменяем пути на blob:
  const codeBlobURL = blobURL(wasmU8, "application/wasm");
  const dataBlobURL = blobURL(dataU8, "application/octet-stream");

  // 5) Страховка от «залипаний»: включаем явный вывод ошибок Emscripten
  const realCreate = window.createUnityInstance;
  if (typeof realCreate !== "function")
    throw new Error("Inner loader didn't expose createUnityInstance");

  // Сбрасываем возможный старый Module
  try { if (window.Module) delete window.Module; } catch {}

  const cfg = Object.assign({}, config, {
    codeUrl: codeBlobURL,
    dataUrl: dataBlobURL,

    // вытащить скрытые ошибки
    print:    (t)=>{ try{console.log(t);}catch{} },
    printErr: (t)=>{ try{console.error(t);}catch{} },
    onAbort:  (r)=>{ try{console.error("Unity abort:", r);}catch{} },

    // иногда нужен, если у тебя есть StreamingAssets
    streamingAssetsUrl: config.streamingAssetsUrl || "StreamingAssets",
  });

  // 6) Запуск
  const p = realCreate(canvas, cfg, onProgress);

  // логируем исход, если он есть
  p.then(()=>console.log("[loader] started"))
   .catch(e=>console.error("[loader] start error:", e));

  // 7) Чистка blob позже
  const clean = () => { try{URL.revokeObjectURL(codeBlobURL);}catch{} try{URL.revokeObjectURL(dataBlobURL);}catch{} };
  p.finally(()=>setTimeout(clean, 15000));
  return p;
}

  // ╭─────────────────────────────────────────────────────────────╮
  // │ 6) Экспортируем drop-in createUnityInstance                 │
  // ╰─────────────────────────────────────────────────────────────╯
  async function outerCreateUnityInstance(canvas, config, onProgress){
    return prepareAndRun(canvas, config, onProgress);
  }

window.startUnityBr = outerCreateUnityInstance;
console.log("[br-loader] startUnityBr exported:", typeof window.startUnityBr);
})();

