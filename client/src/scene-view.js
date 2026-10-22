/* Renderers live for the workspace session. Only the visible view owns motion
 * and input; the server remains the source of workflow and presence state. */
export function createSceneViewController(container, callbacks = {}, options = {}) {
  const {
    mount2D,
    load3D = () => import('./scene3d.js'),
    initialMode = '3d',
    warmup = true,
    onChange = () => {},
    onError = () => {},
  } = options;
  if (typeof mount2D !== 'function') throw new TypeError('缺少 2D 场景。');
  if (!['2d', '3d'].includes(initialMode)) throw new TypeError('视角仅支持 2D 或 3D。');

  const entries = new Map(), loads = new Map();
  let mode = initialMode, pending = initialMode === '3d', disposed = false, epoch = 0;
  let current = null, lastState = null, topology = true, selectedNode = null;
  let selectedAgent = null, selectedHuman = null, presence = null, version = 0;
  let module3D = null, warmHandle = null, warmingMode = null;
  let deferredFocus = null;
  const notify = () => { if (!disposed) onChange({ mode, pending }); };
  const ownsInput = entry => !disposed && current === entry && entry.valid && entry.active;
  const invoke = (method, ...args) => current?.valid ? current.scene?.[method]?.(...args) : undefined;

  function expose(entry, visible) {
    entry.layer.style.visibility = visible ? '' : 'hidden';
    entry.layer.style.pointerEvents = visible ? '' : 'none';
    entry.layer.dataset.active = String(visible);
    entry.layer.setAttribute?.('aria-hidden', String(!visible));
    entry.layer.inert = !visible;
  }
  function activate(entry, value) {
    if (!entry?.valid || entry.active === value) return;
    entry.active = value;
    entry.scene?.setActive?.(value);
  }
  function disposeEntry(entry) {
    if (!entry || entry.disposed) return;
    entry.disposed = true; entry.valid = false; entry.active = false;
    if (entries.get(entry.mode) === entry) entries.delete(entry.mode);
    entry.scene?.destroy?.(); entry.layer.remove();
  }
  function unavailable(entry, error) {
    if (disposed || !entry.valid) return;
    entry.failed = error || new Error('3D 渲染暂不可用。');
    const visible = current === entry;
    disposeEntry(entry);
    if (entry.mode === '3d') module3D = null;
    if (visible) {
      onError(entry.failed);
      void setMode('2d');
    }
  }
  function mountEntry(next, factory) {
    const layer = container.ownerDocument.createElement('div');
    layer.className = 'office-view-layer';
    Object.assign(layer.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
    const entry = { mode: next, layer, scene: null, active: false, valid: true, disposed: false, preparedVersion: -1 };
    expose(entry, false); container.append(layer);
    const wrapped = Object.fromEntries(Object.entries(callbacks).map(([key, fn]) => [key, (...args) => {
      if (ownsInput(entry)) return fn(...args);
    }]));
    try {
      entry.scene = factory(layer, { ...wrapped, onUnavailable: error => unavailable(entry, error) });
      if (!entry.scene || entry.failed) throw entry.failed || new Error('场景未能载入。');
      // A constructor may schedule its initial frame. Suspend it before yielding
      // so warming a hidden view never starts a second perpetual render loop.
      entry.scene.setActive?.(false);
      entries.set(next, entry);
      return entry;
    } catch (error) {
      disposeEntry(entry);
      throw error;
    }
  }
  function ensure(next) {
    if (disposed) return Promise.resolve(null);
    const cached = entries.get(next);
    if (cached?.valid) return Promise.resolve(cached);
    if (loads.has(next)) return loads.get(next);
    const load = (async () => {
      let factory = mount2D;
      if (next === '3d') {
        if (!module3D) {
          const module = Promise.resolve().then(load3D);
          module3D = module;
          module.catch(() => { if (module3D === module) module3D = null; });
        }
        factory = (await module3D).mountScene3D;
      }
      if (disposed) return null;
      if (typeof factory !== 'function') throw new Error('3D 场景未能载入。');
      return mountEntry(next, factory);
    })();
    loads.set(next, load);
    void load.finally(() => { if (loads.get(next) === load) loads.delete(next); }).catch(() => {});
    return load;
  }
  function applyPresence(entry, positions, rebase = false) {
    if (!presence) return;
    entry.scene.setPresence?.({
      ...presence,
      ...(positions ? { positions, rebase } : {}),
      onSelectEmployee: person => { if (ownsInput(entry)) presence?.onSelectEmployee?.(person); },
    });
  }
  function restore(entry, positions) {
    const scene = entry.scene;
    if (lastState) scene.update({ ...lastState, animateEvents: false });
    scene.setTopology?.(topology);
    scene.setSelectedNode?.(selectedNode);
    scene.setSelectedAgent?.(selectedAgent);
    scene.setSelectedHuman?.(selectedHuman);
    applyPresence(entry, positions, true);
    entry.preparedVersion = version;
  }
  async function prepare(entry) {
    // Snapshot restoration can race with a network result while an asynchronous
    // GPU preparation is in progress. Never reveal an older result or identity.
    do {
      if (!entry.valid || disposed) return;
      const positions = current?.valid ? current.scene.getPresenceState?.()?.positions : undefined;
      restore(entry, positions);
      await entry.scene.prepare?.();
    } while (!disposed && entry.valid && entry.preparedVersion !== version);
  }
  function cancelWarmup() {
    if (warmHandle === null) return;
    if (warmingMode === 'idle') globalThis.cancelIdleCallback?.(warmHandle);
    else clearTimeout(warmHandle);
    warmHandle = null; warmingMode = null;
  }
  function scheduleWarmup() {
    cancelWarmup();
    if (!warmup || disposed || !current?.valid) return;
    const next = mode === '3d' ? '2d' : '3d';
    if (entries.get(next)?.valid) return;
    const run = () => {
      warmHandle = null; warmingMode = null;
      if (disposed || pending) return;
      // Failure in an optional hidden view must not interrupt a working office.
      void ensure(next).then(async entry => {
        if (!entry?.valid || disposed || pending || entry === current) return;
        try { await prepare(entry); }
        catch { if (entry !== current) disposeEntry(entry); }
      }).catch(() => {});
    };
    if (typeof globalThis.requestIdleCallback === 'function') {
      warmingMode = 'idle'; warmHandle = globalThis.requestIdleCallback(run, { timeout: 2500 });
    } else {
      warmingMode = 'timer'; warmHandle = setTimeout(run, 300);
    }
  }
  async function setMode(next) {
    if (disposed) return mode;
    if (!['2d', '3d'].includes(next)) throw new TypeError('视角仅支持 2D 或 3D。');
    const ticket = ++epoch;
    cancelWarmup();
    if (current?.valid && next === mode) {
      pending = false;if(deferredFocus){const [method,args]=deferredFocus;deferredFocus=null;current.scene[method]?.(...args);}notify(); scheduleWarmup(); return mode;
    }
    pending = true; notify();
    let candidate;
    try {
      candidate = await ensure(next);
      if (disposed || ticket !== epoch) return mode;
      if (!candidate?.valid) throw candidate?.failed || new Error('场景未能载入。');
      await prepare(candidate);
      if (disposed || ticket !== epoch) return mode;
      if (!candidate.valid) throw candidate.failed || new Error('场景未能载入。');
      const previous = current;
      if (previous?.valid) activate(previous, false);
      current = candidate; mode = next;
      expose(candidate, true);
      activate(candidate, true);
      if (previous && previous !== candidate) expose(previous, false);
      if (deferredFocus) { const [method, args] = deferredFocus; deferredFocus = null; candidate.scene[method]?.(...args); }
      pending = false; notify(); callbacks.onViewChange?.();
      scheduleWarmup();
    } catch (error) {
      if (candidate && candidate !== current) disposeEntry(candidate);
      if (!disposed && ticket === epoch) {
        pending = false;
        onError(error);
        if (!current?.valid && next !== '2d') return setMode('2d');
        if(current?.valid&&deferredFocus){const [method,args]=deferredFocus;deferredFocus=null;current.scene[method]?.(...args);}
        notify();
      }
    }
    return mode;
  }

  // The 2D fallback can mount synchronously when explicitly requested. Default
  // startup waits for 3D instead of flashing 2D and rebuilding after login.
  if (initialMode === '2d') {
    current = mountEntry('2d', mount2D);
    expose(current, true); activate(current, true);
  }
  const ready = Promise.resolve().then(() => {
    if (disposed) return mode;
    if (epoch === 0) return initialMode === '3d' ? setMode('3d') : (notify(), scheduleWarmup(), mode);
    return mode;
  });
  const focus = (method, args) => {
    if (disposed) return false;
    if (!current?.valid||pending) { deferredFocus = [method, args]; return false; }
    return current.scene[method]?.(...args);
  };
  return {
    get mode() { return mode; }, get pending() { return pending; }, ready, setMode,
    update(state) { if (disposed) return; lastState = state; version++; invoke('update', state); },
    setTopology(value) { if (disposed) return; topology = value; version++; invoke('setTopology', value); },
    setSelectedNode(value) { if (disposed) return; selectedNode = value; version++; invoke('setSelectedNode', value); },
    setSelectedAgent(value) { if (disposed) return; selectedAgent = value; version++; invoke('setSelectedAgent', value); },
    setSelectedHuman(value) { if (disposed) return; selectedHuman = value; version++; invoke('setSelectedHuman', value); },
    setPresence(value) {
      if (disposed) return;
      presence = { ...value, people: Array.isArray(value?.people) ? value.people.map(person => ({ ...person })) : [] };
      version++;
      if (current?.valid) applyPresence(current);
      // Expired or signed-out identities must also disappear from a cached view.
      if (!presence.enabled || !presence.people.length) for (const entry of entries.values()) if (entry !== current) applyPresence(entry);
    },
    getPresenceState: () => invoke('getPresenceState'),
    getHumanAnchor: (...args) => invoke('getHumanAnchor', ...args),
    getNodeAnchor: (...args) => invoke('getNodeAnchor', ...args),
    getAgentAnchor: (...args) => invoke('getAgentAnchor', ...args),
    focusHuman: (...args) => focus('focusHuman', args),
    focusPoint: (...args) => focus('focusPoint', args),
    focusNode: (...args) => focus('focusNode', args),
    focusArea: (...args) => focus('focusArea', args),
    focusAgent: (...args) => focus('focusAgent', args),
    zoom: (...args) => invoke('zoom', ...args), resetView: () => focus('resetView', []),
    rotate: (...args) => invoke('rotate', ...args),
    fit: () => current?.scene?.fit ? invoke('fit') : invoke('resetView'),
    getPerformanceStats: () => invoke('getPerformanceStats'),
    destroy() {
      if (disposed) return;
      disposed = true; epoch++; cancelWarmup(); deferredFocus = null;
      for (const entry of [...entries.values()]) disposeEntry(entry);
      current = null; presence = null; lastState = null;
    },
  };
}
