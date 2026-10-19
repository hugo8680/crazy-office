/* Presentation-only view switching. Workflow state always belongs to the server. */
export function createSceneViewController(container, callbacks = {}, options = {}) {
  const { mount2D, load3D = () => import('./scene3d.js'), onChange = () => {}, onError = () => {} } = options;
  if (typeof mount2D !== 'function') throw new TypeError('缺少 2D 场景。');
  let mode = '2d', pending = false, disposed = false, epoch = 0, lastState = null;
  let topology = true, selectedNode = null, selectedAgent = null, selectedHuman = null;
  const makeLayer = () => {
    const layer = container.ownerDocument.createElement('div');
    layer.className = 'office-view-layer';
    Object.assign(layer.style, { position:'absolute', inset:'0', width:'100%', height:'100%' });
    container.append(layer);
    return layer;
  };
  const notify = () => { if (!disposed) onChange({ mode, pending }); };
  const wrapCallbacks = layer => Object.fromEntries(Object.entries(callbacks).map(([key, fn]) => [key, (...args) => {
    if (!disposed && currentLayer === layer) return fn(...args);
  }]));
  let currentLayer = makeLayer(), current = mount2D(currentLayer, wrapCallbacks(currentLayer));
  const restore = scene => {
    // A newly created renderer observes the current snapshot. It must not replay
    // completed handoffs or generate another workflow/approval callback.
    if (lastState) scene.update({ ...lastState, animateEvents:false });
    scene.setTopology(topology);
    scene.setSelectedNode(selectedNode);
    scene.setSelectedAgent(selectedAgent);
    scene.setSelectedHuman?.(selectedHuman);
  };
  async function setMode(next) {
    if (disposed) return mode;
    if (!['2d','3d'].includes(next)) throw new TypeError('视角仅支持 2D 或 3D。');
    const ticket = ++epoch;
    if (next === mode) { pending = false; notify(); return mode; }
    pending = true; notify();
    let layer, candidate;
    try {
      const factory = next === '2d' ? mount2D : (await load3D()).mountScene3D;
      if (disposed || ticket !== epoch) return mode;
      if (typeof factory !== 'function') throw new Error('3D 场景未能载入。');
      layer = makeLayer(); layer.style.visibility = 'hidden';
      candidate = factory(layer, { ...wrapCallbacks(layer), onUnavailable:error => {
        if (!disposed && currentLayer === layer) {
          onError(error || new Error('3D 渲染暂不可用。'));
          void setMode('2d');
        }
      } });
      restore(candidate);
      if (disposed || ticket !== epoch) { candidate.destroy(); layer.remove(); return mode; }
      const previous = current, previousLayer = currentLayer;
      current = candidate; currentLayer = layer; mode = next;
      layer.style.visibility = '';
      previous.destroy(); previousLayer.remove();
      pending = false; notify(); callbacks.onViewChange?.();
    } catch (error) {
      candidate?.destroy?.(); layer?.remove();
      if (!disposed && ticket === epoch) { pending = false; notify(); onError(error); }
    }
    return mode;
  }
  return {
    get mode() { return mode; }, get pending() { return pending; }, setMode,
    update(state) { lastState = state; current.update(state); },
    setTopology(value) { topology = value; current.setTopology(value); },
    setSelectedNode(value) { selectedNode = value; current.setSelectedNode(value); },
    setSelectedAgent(value) { selectedAgent = value; current.setSelectedAgent(value); },
    setSelectedHuman(value) { selectedHuman = value; current.setSelectedHuman?.(value); },
    getHumanAnchor:(...args) => current.getHumanAnchor?.(...args),
    getNodeAnchor:(...args) => current.getNodeAnchor(...args),
    getAgentAnchor:(...args) => current.getAgentAnchor(...args),
    focusHuman:(...args) => current.focusHuman?.(...args),
    focusNode:(...args) => current.focusNode(...args),
    focusAgent:(...args) => current.focusAgent(...args),
    zoom:(...args) => current.zoom(...args), resetView:() => current.resetView(),
    destroy() { if(disposed)return; disposed = true; epoch++; current.destroy(); currentLayer.remove(); }
  };
}
