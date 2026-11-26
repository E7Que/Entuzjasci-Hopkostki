/* Tła z React Bits (https://reactbits.dev, David Haz, licencja MIT + Commons Clause: wolno ich używać jako części
   strony) bez Reacta. Pliki rb-*.js to oryginalny kod komponentów (shadery i logika bez zmian); ten plik daje im
   to, czego potrzebują z Reacta (useRef, useEffect, useState...), i podpina je do elementów strony:
     <div class="page-bg" data-rb="LightRays" data-props='{"raysColor":"#7ff0f4"}'></div>
   Zmiana ustawień w locie: element.rb.update({ colorStops: [...] }).
   data-from="selektor" (opcjonalnie): element zaczyna się nad tym miejscem strony (z data-edge="bottom": pod jego
   dolną krawędzią) i przesuwa się razem ze stroną.
   Kolory można podać jako "var(--accent)": biorą wtedy kolor strony i zmieniają się razem z nim
   (strona eventów po zmianie eventu wysyła zdarzenie „rb:theme”). */
(() => {
  'use strict';
  let cur = null;
  let uid = 0;
  const slot = (init) => {
    const h = cur;
    const k = h.i++;
    if (!(k in h.slots)) h.slots[k] = init();
    return h.slots[k];
  };
  const same = (a, b) => a && b && a.length === b.length && a.every((d, j) => Object.is(d, b[j]));
  const hooks = {
    useRef: (v) => slot(() => ({ current: v })),
    useState: (v) => {
      const h = cur;
      const s = slot(() => ({ v: typeof v === 'function' ? v() : v }));
      return [s.v, (n) => { s.v = typeof n === 'function' ? n(s.v) : n; queueMicrotask(h.render); }];
    },
    useEffect: (fn, deps) => {
      const h = cur;
      const k = h.i++;
      const prev = h.slots[k];
      if (prev && same(deps, prev.deps)) return;
      const entry = { deps, cleanup: null };
      h.slots[k] = entry;
      h.queue.push(() => {
        if (typeof prev?.cleanup === 'function') prev.cleanup();
        const c = fn();
        entry.cleanup = typeof c === 'function' ? c : null;
      });
    },
    useLayoutEffect: (fn, deps) => hooks.useEffect(fn, deps),
    useMemo: (fn, deps) => {
      const s = slot(() => ({}));
      if (!('v' in s) || !same(deps, s.deps)) { s.v = fn(); s.deps = deps; }
      return s.v;
    },
    useCallback: (fn, deps) => hooks.useMemo(() => fn, deps),
    useId: () => slot(() => `rb${++uid}`),
  };

  // Zamiast JSX: kontener to element strony, płótno tworzymy w nim raz.
  function dom(containerRef, canvasRef, cls, canvasCls) {
    const h = cur;
    if (!containerRef.current) {
      containerRef.current = h.host;
      if (cls) h.host.classList.add(cls);
    }
    if (canvasRef && !canvasRef.current) {
      const canvas = document.createElement('canvas');
      canvas.className = canvasCls;
      canvas.setAttribute('aria-hidden', 'true');
      h.host.append(canvas);
      canvasRef.current = canvas;
    }
    return null;
  }

  // "var(--accent)" -> #rrggbb z bieżących kolorów strony (komponenty React Bits przyjmują kolory w hex).
  const toHex = (v) => {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(v);
    return m ? `#${[m[1], m[2], m[3]].map((x) => Math.round(+x).toString(16).padStart(2, '0')).join('')}` : v;
  };
  const cssColor = (name) => {
    const rootEl = document.documentElement;
    return toHex(rootEl.style.getPropertyValue(name).trim() || getComputedStyle(rootEl).getPropertyValue(name).trim());
  };
  const resolve = (v) => {
    if (typeof v === 'string') { const m = /^var\((--[\w-]+)\)$/.exec(v.trim()); return m ? cssColor(m[1]) || v : v; }
    if (Array.isArray(v)) return v.map(resolve);
    return v;
  };
  const resolveAll = (props) => Object.fromEntries(Object.entries(props).map(([k, v]) => [k, resolve(v)]));
  const themed = new Set();
  document.addEventListener('rb:theme', () => {
    for (const host of themed) if (host.rb) host.rb.update(resolveAll(host.rbRaw));
  });

  const registry = {};
  function mount(name, host, props = {}) {
    const Component = registry[name];
    if (!Component || host.rb) return host.rb ?? null;
    const h = { host, slots: {}, i: 0, queue: [], props };
    h.render = () => {
      h.i = 0;
      cur = h;
      try { Component(h.props); } finally { cur = null; }
      h.queue.splice(0).forEach((f) => f());
    };
    h.update = (next) => { h.props = { ...h.props, ...next }; h.render(); };
    host.rb = h;
    h.render();
    return h;
  }

  // Pas „od miejsca X do końca strony” (np. skaner na dole): górna krawędź liczona od elementu z data-from.
  const spans = new Set();
  function place() {
    for (const host of spans) {
      const from = document.querySelector(host.dataset.from);
      if (!from) continue;
      const box = from.getBoundingClientRect();
      const edge = host.dataset.edge === 'bottom' ? box.bottom : box.top;
      const top = edge + window.scrollY - Number(host.dataset.lift || 0);
      host.style.top = `${Math.max(0, Math.round(top))}px`;
    }
  }
  let placing = 0;
  const schedule = () => { cancelAnimationFrame(placing); placing = requestAnimationFrame(place); };
  if ('ResizeObserver' in window) new ResizeObserver(schedule).observe(document.body);
  addEventListener('load', schedule);

  function define(name, Component) {
    registry[name] = Component;
    if (document.documentElement.classList.contains('embed')) return;
    document.querySelectorAll(`[data-rb="${name}"]`).forEach((host) => {
      let props = {};
      try { props = JSON.parse(host.dataset.props || '{}'); } catch { /* złe JSON: domyślne ustawienia */ }
      if (host.dataset.from) { spans.add(host); place(); }
      if (/"var\(--/.test(host.dataset.props || '')) { host.rbRaw = props; themed.add(host); }
      mount(name, host, resolveAll(props));
    });
  }

  window.RB = { hooks, dom, define, mount };
})();
