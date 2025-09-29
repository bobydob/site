;(function(){
  var TAG='[br-probe]';
  function log(){ try{console.log.apply(console, arguments);}catch(e){} }
  log(TAG,'loaded');
  function startUnityBr(canvas, config, onProgress){
    log(TAG,'startUnityBr stub called');
    if (typeof onProgress==='function') onProgress(0.1);
    return Promise.reject(new Error('probe only'));
  }
  window.startUnityBr = startUnityBr;
  log(TAG,'exported startUnityBr:', typeof window.startUnityBr);
})();