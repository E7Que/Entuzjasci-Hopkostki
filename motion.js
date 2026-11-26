/* Ruch na stronach enho.pl (strona główna, ranking, eventy, 404). Zasady: .claude/skills/site-design.
   GSAP + ScrollTrigger + Lenis (skill meng-cinematic-gsap-lenis-motion-system) i wzorce z React Bits
   (https://reactbits.dev, David Haz, MIT + Commons Clause) przeniesione z Reacta do zwykłego JS:
   - MaskedHeading: słowa tytułu wyjeżdżają spod maski,
   - AnimatedContent: sekcje wjeżdżają od dołu, gdy pojawiają się na ekranie (raz),
   - CountUp: liczby odliczają od zera, gdy są widoczne,
   - SpotlightCard: miękkie światło i jaśniejsza krawędź karty pod kursorem,
   - Magnet: główny przycisk lekko ciągnie się do kursora (sprężyna jak w React Bits).
   Do tego baner na całą szerokość, który przy przewijaniu zwija się do kolumny treści.
   Bez JS, bez bibliotek albo przy prefers-reduced-motion treść jest od razu widoczna i nieruchoma. */
(() => {
  'use strict';
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const ON = !reduce && !!window.gsap && !!window.ScrollTrigger;
  const $ = (s, el = document) => (typeof s === 'string' ? el.querySelector(s) : s);
  const $$ = (s) => (typeof s === 'string' ? [...document.querySelectorAll(s)] : s instanceof Element ? [s] : [...(s ?? [])]);

  // Dzieli tekst na słowa (z zachowaniem elementów w środku, np. <span class="hl">). cls 'word' dodaje maskę.
  function splitWords(el, cls = 'word') {
    if (!el || el.dataset.split) return [...(el?.querySelectorAll(`.${cls}`) ?? [])];
    const words = [];
    const walk = (node, hl) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.TEXT_NODE) {
          const frag = document.createDocumentFragment();
          for (const part of child.textContent.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) { frag.append(part); continue; }
            const word = document.createElement('span');
            word.className = hl ? `${cls} hl` : cls;
            word.textContent = part;
            words.push(word);
            if (cls === 'word') {
              const mask = document.createElement('span');
              mask.className = 'mask';
              mask.append(word);
              frag.append(mask);
            } else {
              frag.append(word);
            }
          }
          child.replaceWith(frag);
        } else if (child.nodeType === Node.ELEMENT_NODE && !(child instanceof SVGElement)) {
          walk(child, hl || child.classList.contains('hl'));
        }
      }
    };
    el.setAttribute('aria-label', el.textContent.replace(/\s+/g, ' ').trim());
    walk(el, false);
    el.querySelectorAll('.mask, .w').forEach((x) => x.setAttribute('aria-hidden', 'true'));
    el.dataset.split = cls;
    return words;
  }

  // Po wczytaniu danych z API zmienia się wysokość strony: przeliczamy pozycje ScrollTriggera (z opóźnieniem).
  let refreshTimer = 0;
  function refresh() {
    if (!ON) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => ScrollTrigger.refresh(), 150);
  }

  // MaskedHeading: słowa wyjeżdżają spod maski. scroll: true startuje, gdy nagłówek wjedzie na ekran.
  function rise(target, { delay = 0, scroll = false, stagger = 0.09 } = {}) {
    const el = $(target);
    if (!ON || !el || el.dataset.split) return null;
    const words = splitWords(el, 'word');
    return gsap.fromTo(words, { yPercent: 110 }, {
      yPercent: 0, duration: 1.1, ease: 'power4.out', stagger, delay,
      scrollTrigger: scroll ? { trigger: el, start: 'top 90%', once: true } : undefined,
    });
  }

  // AnimatedContent: element wjeżdża 40 px od dołu i z przezroczystości, raz. Elementy, które wjeżdżają
  // jednocześnie, idą po kolei (co 0,08 s).
  const seen = new WeakSet();
  function reveal(targets, { y = 40, stagger = 0.08 } = {}) {
    const els = $$(targets).filter((el) => el && !seen.has(el));
    if (!els.length) return;
    els.forEach((el) => seen.add(el));
    if (!ON) return;
    gsap.set(els, { autoAlpha: 0, y });
    ScrollTrigger.batch(els, {
      start: 'top 92%',
      once: true,
      onEnter: (batch) => gsap.to(batch, {
        autoAlpha: 1, y: 0, duration: 0.8, ease: 'power3.out', stagger, overwrite: true,
        clearProps: 'transform,opacity,visibility',
      }),
    });
    refresh();
  }

  // CountUp: liczba odlicza od poprzedniej wartości (za pierwszym razem od zera), gdy element jest widoczny.
  // Czytnik ekranu dostaje od razu wynik końcowy, a animowane cyfry są dla niego ukryte.
  const easeOut = (t) => 1 - Math.pow(1 - t, 3); // cubic-bezier(0.33, 1, 0.68, 1) z React Bits
  const fmt = (n) => Math.round(n).toLocaleString('pl-PL');
  function count(target, to, format = fmt, { duration = 2 } = {}) {
    const el = $(target);
    if (!el) return;
    const end = Number(to) || 0;
    const from = el._countFrom ?? 0;
    el._countFrom = end;
    if (reduce || from === end || !('IntersectionObserver' in window)) { el.textContent = format(end); return; }
    el.style.fontVariantNumeric = 'tabular-nums';
    el.innerHTML = '<span aria-hidden="true"></span><span class="sr-only"></span>';
    const [shown, spoken] = el.children;
    spoken.textContent = format(end);
    shown.textContent = format(from);
    const run = () => {
      const t0 = performance.now();
      const step = (now) => {
        if (el._countFrom !== end) return; // przyszła nowsza wartość
        const t = Math.min(1, (now - t0) / (duration * 1000));
        shown.textContent = format(from + (end - from) * easeOut(t));
        if (t < 1) requestAnimationFrame(step);
        else el.textContent = format(end);
      };
      requestAnimationFrame(step);
    };
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      run();
    });
    io.observe(el);
  }

  // SpotlightCard: jedna warstwa nad kartą pod kursorem (bez zmian w kartach): miękkie światło i krawędź w kolorze akcentu.
  function spotlight(selector) {
    if (!fine || document.querySelector('.spot-layer')) return;
    const layer = document.createElement('div');
    layer.className = 'spot-layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.innerHTML = '<i></i><b></b>';
    document.body.append(layer);
    let card = null;
    let x = 0;
    let y = 0;
    let raf = 0;
    const off = () => { card = null; layer.classList.remove('on'); };
    const paint = () => {
      raf = 0;
      const hit = document.elementFromPoint(x, y)?.closest?.(selector) ?? null;
      card = hit;
      if (!card) return off();
      const r = card.getBoundingClientRect();
      const s = layer.style;
      s.left = `${r.left}px`;
      s.top = `${r.top}px`;
      s.width = `${r.width}px`;
      s.height = `${r.height}px`;
      s.borderRadius = getComputedStyle(card).borderRadius;
      s.setProperty('--mx', `${x - r.left}px`);
      s.setProperty('--my', `${y - r.top}px`);
      layer.classList.add('on');
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(paint); };
    addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      x = e.clientX;
      y = e.clientY;
      if (card || e.target.closest?.(selector)) queue();
    }, { passive: true });
    addEventListener('scroll', () => { if (card) queue(); }, { passive: true, capture: true });
    root.addEventListener('pointerleave', off);
    addEventListener('blur', off);
  }

  // Magnet: przycisk przesuwa się w stronę kursora, gdy ten jest bliżej niż 60 px od krawędzi (najwyżej 10 px),
  // i wraca na sprężynie (sztywność 170, tłumienie 16, jak domyślnie w React Bits). Używa `translate`,
  // więc nie gryzie się z `transform` przycisku (np. wciśnięcie).
  function magnet(selector, { padding = 60, strength = 0.22, max = 10 } = {}) {
    if (!fine || reduce) return;
    const items = $$(selector).map((el) => ({ el, x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 }));
    if (!items.length) return;
    let raf = 0;
    let last = 0;
    const tick = (now) => {
      raf = 0;
      const dt = Math.min(0.032, (now - last) / 1000 || 0.016);
      last = now;
      let moving = false;
      for (const it of items) {
        let busy = false;
        for (const k of ['x', 'y']) {
          const force = 170 * (it[`t${k}`] - it[k]) - 16 * it[`v${k}`];
          it[`v${k}`] += force * dt;
          it[k] += it[`v${k}`] * dt;
          if (Math.abs(it[`t${k}`] - it[k]) > 0.05 || Math.abs(it[`v${k}`]) > 0.05) busy = true;
        }
        if (!busy) { it.x = it.tx; it.y = it.ty; it.vx = 0; it.vy = 0; }
        it.el.style.translate = it.x || it.y ? `${it.x.toFixed(2)}px ${it.y.toFixed(2)}px` : '';
        moving ||= busy;
      }
      if (moving) raf = requestAnimationFrame(tick);
    };
    const wake = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } };
    const aim = (px, py) => {
      for (const it of items) {
        const r = it.el.getBoundingClientRect();
        const dx = px - (r.left + r.width / 2);
        const dy = py - (r.top + r.height / 2);
        const outside = Math.hypot(Math.max(0, Math.abs(dx) - r.width / 2), Math.max(0, Math.abs(dy) - r.height / 2));
        const near = px !== null && outside <= padding;
        it.tx = near ? Math.max(-max, Math.min(max, dx * strength)) : 0;
        it.ty = near ? Math.max(-max, Math.min(max, dy * strength)) : 0;
      }
      wake();
    };
    addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') aim(e.clientX, e.clientY); }, { passive: true });
    root.addEventListener('pointerleave', () => aim(null, null));
  }

  // Baner przez całą szerokość: przy przewijaniu krawędzie zjeżdżają do kolumny treści, rogi się zaokrąglają,
  // obraz lekko się oddala. Po wczytaniu baner odsłania się od góry.
  function scrub(target, { column = 'main', intro = true } = {}) {
    const el = $(target);
    if (!ON || !el) return null;
    el.classList.add('scrub');
    const measure = () => {
      const col = el.closest(column) ?? $(column);
      if (!col) return;
      const cs = getComputedStyle(col);
      const inner = Math.min(col.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), el.clientWidth);
      el.style.setProperty('--gut', `${Math.max(0, (el.clientWidth - inner) / 2)}px`);
    };
    measure();
    ScrollTrigger.addEventListener('refreshInit', measure);
    gsap.to(el, { '--p': 1, ease: 'none', scrollTrigger: { trigger: el, start: 'top top', end: 'bottom 30%', scrub: 1 } });
    return intro ? gsap.fromTo(el, { '--intro': 1 }, { '--intro': 0, duration: 1, ease: 'power4.out', delay: 0.1 }) : null;
  }

  let lenis = null;
  // init({ banner, title, intro, reveal, headings, spot, magnet, column }): wszystko opcjonalne.
  function init(opts = {}) {
    if (root.classList.contains('embed')) return; // ranking w okienku Discorda zostaje statyczny
    if (ON) {
      gsap.registerPlugin(ScrollTrigger);
      gsap.defaults({ ease: 'power3.out', duration: 0.85 });
      root.classList.add('has-motion');
      // Płynne przewijanie zsynchronizowane z ScrollTriggerem. Klawiatura i kotwice działają jak zwykle.
      if (window.Lenis && !lenis) {
        lenis = new Lenis({ lerp: 0.08, smoothWheel: true, wheelMultiplier: 0.9, anchors: true });
        lenis.on('scroll', ScrollTrigger.update);
        gsap.ticker.add((time) => lenis.raf(time * 1000));
        gsap.ticker.lagSmoothing(0);
        const skip = $('.skip');
        const main = $('#tresc');
        if (skip && main) skip.addEventListener('click', () => main.focus({ preventScroll: true }));
      }
      if (opts.banner) scrub(opts.banner, { column: opts.column ?? 'main' });
      if (opts.title) rise(opts.title, { delay: opts.banner ? 0.35 : 0.1 });
      const intro = $$(opts.intro ?? []);
      if (intro.length) {
        gsap.fromTo(intro, { y: 24, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.8, stagger: 0.08, delay: opts.title ? 0.75 : 0.2, clearProps: 'transform,opacity,visibility' });
      }
      $$(opts.headings ?? []).forEach((h) => rise(h, { scroll: true, stagger: 0.06 }));
      if (opts.reveal) reveal(opts.reveal);
      // Treść z API zmienia wysokość strony: przelicz pozycje, gdy zmieni się wysokość dokumentu.
      if ('ResizeObserver' in window) new ResizeObserver(refresh).observe(document.body);
      addEventListener('load', refresh);
    }
    if (opts.spot) spotlight(opts.spot);
    if (opts.magnet) magnet(opts.magnet);
  }

  window.Motion = { on: ON, init, rise, reveal, count, refresh, splitWords, spotlight, magnet, scrub, get lenis() { return lenis; } };
})();
