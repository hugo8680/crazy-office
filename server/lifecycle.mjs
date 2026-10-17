/** Stop accepting work, cancel models/tools, flush run files, then release sockets. */
export function createShutdown({ server, engine, getEngine = () => engine, sseResponses = new Set(), probeController, onStart = () => {}, timeoutMs = 10000 } = {}) {
  let pending;
  return function shutdown() {
    if (pending) return pending;
    pending = (async () => {
      onStart();
      const closed = new Promise(resolve => server.close(() => resolve()));
      probeController?.abort(new Error('服务停止，模型连接检查已取消。'));
      for (const response of sseResponses) if (!response.destroyed && !response.writableEnded) response.end();
      sseResponses.clear();
      let timer; let failure;
      try {
        const current = getEngine();
        if (current) await Promise.race([
          current.shutdown({ timeoutMs: Math.max(100, timeoutMs - 1000) }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('服务停机超时，已停止接收新请求。')), timeoutMs); }),
        ]);
      } catch (error) { failure = error; }
      finally {
        clearTimeout(timer);
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        await closed;
      }
      if (failure) throw failure;
    })();
    return pending;
  };
}
