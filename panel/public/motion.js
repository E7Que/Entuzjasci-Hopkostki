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
  // Animacje CSS, które ruszyły, gdy element był jeszcze schowany pod wejściem GSAP (opacity 0, visibility hidden,
  // clip-path na 100%), Chrome liczy na głównym wątku do końca i tną się przy obciążeniu. Po odsłonięciu startują
  // jeszcze raz od tego samego miejsca, więc idą płynnie na kompozytorze.
  function recomposite(targets) {
    if (typeof CSSAnimation === 'undefined') return;
    for (const el of $$(targets)) {
      for (const a of el.getAnimations?.({ subtree: true }) ?? []) {
        if (!(a instanceof CSSAnimation) || a.playState !== 'running') continue;
        const t = a.currentTime;
        a.cancel();
        a.currentTime = t;
        a.play();
      }
    }
  }

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
        clearProps: 'transform,opacity,visibility', onComplete: () => recomposite(batch),
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
    // Szerokość końcowej liczby z góry, żeby tekst obok nie przesuwał się przy każdej nowej cyfrze.
    shown.style.display = 'inline-block';
    shown.style.textAlign = 'right';
    shown.textContent = format(end);
    shown.style.minWidth = `${Math.ceil(shown.getBoundingClientRect().width)}px`;
    shown.textContent = format(from);
    const run = () => {
      const t0 = performance.now();
      const step = (now) => {
        if (el._countFrom !== end) return; // przyszła nowsza wartość
        const t = Math.min(1, (now - t0) / (duration * 1000));
        shown.textContent = format(Math.round(from + (end - from) * easeOut(t)));
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

  // TiltedCard: karta pod kursorem obraca się do 5° w jego stronę i lekko rośnie (tylko mysz, bez ograniczonego ruchu).
  function tilt(selector, { max = 5, scale = 1.015 } = {}) {
    if (!fine || reduce) return;
    let card = null;
    const rest = (el) => { if (el) { el.style.setProperty('--rx', '0deg'); el.style.setProperty('--ry', '0deg'); el.style.setProperty('--ts', '1'); } };
    addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const hit = e.target.closest?.(selector) ?? null;
      if (hit !== card) { rest(card); card = hit; if (card) card.classList.add('tilt'); }
      if (!card) return;
      const r = card.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5;
      const ny = (e.clientY - r.top) / r.height - 0.5;
      card.style.setProperty('--rx', `${(-ny * max * 2).toFixed(2)}deg`);
      card.style.setProperty('--ry', `${(nx * max * 2).toFixed(2)}deg`);
      card.style.setProperty('--ts', String(scale));
    }, { passive: true });
    root.addEventListener('pointerleave', () => { rest(card); card = null; });
  }

  // AnimatedList: wiersze listy wjeżdżają po kolei (16 px od dołu, co 0,03 s), np. ranking po przełączeniu zakładki.
  function stagger(nodes, { y = 16, each = 0.03, max = 24 } = {}) {
    const els = [...(nodes ?? [])].slice(0, max);
    if (!ON || !els.length) return;
    gsap.fromTo(els, { autoAlpha: 0, y }, { autoAlpha: 1, y: 0, duration: 0.5, ease: 'power3.out', stagger: each, overwrite: true, clearProps: 'transform,opacity,visibility' });
  }

  // ClickSpark: 8 iskier w kolorze akcentu rozbiega się z miejsca kliknięcia (0,4 s).
  function sparks({ count = 8, size = 10, radius = 18, duration = 400 } = {}) {
    if (reduce || document.querySelector('.sparks')) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'sparks';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.append(canvas);
    const ctx = canvas.getContext('2d');
    const list = [];
    let raf = 0;
    const fit = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = innerWidth * dpr;
      canvas.height = innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    addEventListener('resize', fit);
    const draw = (now) => {
      raf = 0;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      const color = getComputedStyle(root).getPropertyValue('--accent').trim() || '#2fd9e0';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      for (let i = list.length - 1; i >= 0; i--) {
        const sp = list[i];
        const t = (now - sp.start) / duration;
        if (t >= 1) { list.splice(i, 1); continue; }
        const eased = t * (2 - t);
        const dist = eased * radius;
        const len = size * (1 - eased);
        const x1 = sp.x + dist * Math.cos(sp.angle);
        const y1 = sp.y + dist * Math.sin(sp.angle);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 + len * Math.cos(sp.angle), y1 + len * Math.sin(sp.angle));
        ctx.stroke();
      }
      if (list.length) raf = requestAnimationFrame(draw);
    };
    addEventListener('pointerdown', (e) => {
      const now = performance.now();
      for (let i = 0; i < count; i++) list.push({ x: e.clientX, y: e.clientY, angle: (2 * Math.PI * i) / count, start: now });
      if (!raf) raf = requestAnimationFrame(draw);
    }, { passive: true });
  }

  // Baner przez całą szerokość: przy przewijaniu obraz przesuwa się wolniej niż strona (paralaksa), lekko się oddala
  // i ciemnieje; baner zostaje na całą szerokość. Po wczytaniu odsłania się od góry.
  // Bez paralaksy (ranking, eventy): baner nie jedzie przy przewijaniu, tylko wjeżdża z lekkim przybliżeniem.
  // Na każdej stronie po odsłonięciu obraz powoli „oddycha” (klasa .breathe w site.css).
  function scrub(target, { intro = true, parallax = true } = {}) {
    const el = $(target);
    if (!ON || !el) return null;
    el.classList.add('scrub');
    const img = el.querySelector('img');
    const settle = () => {
      img?.classList.add('breathe');
      recomposite(el);
    };
    if (parallax) {
      const trigger = { trigger: el, start: 'top top', end: 'bottom top', scrub: true };
      if (img) gsap.fromTo(img, { yPercent: 0, scale: 1.08 }, { yPercent: 24, scale: 1, ease: 'none', scrollTrigger: trigger });
      gsap.fromTo(el, { '--shade': 0 }, { '--shade': 0.65, ease: 'none', scrollTrigger: { ...trigger } });
    } else if (img) {
      gsap.fromTo(img, { scale: 1.14 }, { scale: 1, duration: 1.8, ease: 'power3.out', delay: 0.1, clearProps: 'transform' });
    }
    if (!intro) {
      settle();
      return null;
    }
    return gsap.fromTo(el, { '--intro': 1 }, { '--intro': 0, duration: 1, ease: 'power4.out', delay: 0.1, onComplete: settle });
  }

  // Tło, które lekko jedzie w górę razem ze stroną, ale nie ucieka z ekranu: data-drift="0.12" to ułamek
  // przewinięcia, najwyżej o tyle, o ile element jest wyższy od ekranu.
  function drift() {
    const els = $$('[data-drift]');
    if (!els.length || reduce) return;
    let room = [];
    let raf = 0;
    const measure = () => { room = els.map((el) => Math.max(0, el.offsetHeight - window.innerHeight)); };
    const update = () => {
      raf = 0;
      els.forEach((el, i) => {
        const y = Math.min(room[i], window.scrollY * (Number(el.dataset.drift) || 0.1));
        el.style.transform = `translate3d(0, ${-y.toFixed(1)}px, 0)`;
      });
    };
    measure();
    update();
    addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(update); }, { passive: true });
    addEventListener('resize', () => { measure(); update(); });
  }

  // Pytania (<details>): odpowiedź płynnie się rozwija i zwija zamiast skakać. Przy ograniczonym ruchu zwykłe działanie.
  function accordion(selector) {
    const ease = 'cubic-bezier(0.22, 1, 0.36, 1)';
    for (const d of $$(selector)) {
      const summary = d.querySelector('summary');
      const body = summary?.nextElementSibling;
      if (!body || 'accordion' in d.dataset) continue;
      d.dataset.accordion = '';
      let anim = null;
      const done = () => {
        anim = null;
        body.style.overflow = '';
      };
      summary.addEventListener('click', (event) => {
        if (reduce || !body.animate) return;
        event.preventDefault();
        const closing = d.open && !d.classList.contains('closing');
        const from = anim ? body.getBoundingClientRect().height : d.open ? body.offsetHeight : 0;
        anim?.cancel();
        body.style.overflow = 'hidden';
        if (closing) {
          d.classList.add('closing');
          anim = body.animate({ height: [`${from}px`, '0px'], opacity: [1, 0] }, { duration: 320, easing: ease });
          anim.onfinish = () => {
            d.open = false;
            d.classList.remove('closing');
            done();
          };
        } else {
          d.classList.remove('closing');
          d.open = true;
          const to = body.offsetHeight;
          anim = body.animate({ height: [`${from}px`, `${to}px`], opacity: [from ? 1 : 0, 1] }, { duration: 420, easing: ease });
          anim.onfinish = done;
        }
      });
    }
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
      if (opts.banner) scrub(opts.banner, { parallax: opts.bannerParallax !== false });
      if (opts.title) rise(opts.title, { delay: opts.banner ? 0.35 : 0.1 });
      const intro = $$(opts.intro ?? []);
      if (intro.length) {
        gsap.fromTo(intro, { y: 24, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.8, stagger: 0.08, delay: opts.title ? 0.75 : 0.2, clearProps: 'transform,opacity,visibility', onComplete: () => recomposite(intro) });
      }
      $$(opts.headings ?? []).forEach((h) => rise(h, { scroll: true, stagger: 0.06 }));
      if (opts.reveal) reveal(opts.reveal);
      // Treść z API zmienia wysokość strony: przelicz pozycje, gdy zmieni się wysokość dokumentu.
      if ('ResizeObserver' in window) new ResizeObserver(refresh).observe(document.body);
      addEventListener('load', refresh);
    }
    drift();
    if (opts.spot) spotlight(opts.spot);
    if (opts.magnet) magnet(opts.magnet);
    if (opts.tilt) tilt(opts.tilt);
    sparks();
  }

  // ---------- Kolory eventu na całej stronie ----------
  // Tylko strona eventów (/event): kolory wybranego eventu. Motion.paint([kolor1, kolor2]) przestawia akcent (przyciski, linki, ikony, krawędzie kart), drugi akcent,
  // odcień paska u góry, plamy światła, punkty i fale w tle. Motion.paint(null) wraca do granatu i cyjanu.
  // Akcent rozjaśniamy, aż tekst w tym kolorze ma kontrast co najmniej 4,5:1 na tle strony.
  const TYPE_COLORS = { messages: ['#3cc3d6', '#a5ecf5'], invites: ['#8b7bff', '#cfc7ff'], mixed: ['#f5a524', '#ffd88f'] };
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const rgbHex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const isHex = (v) => /^#[0-9a-f]{6}$/i.test(String(v ?? ''));
  const lum = (c) => {
    const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const PAGE_BG = [5, 11, 11];
  function eventColors(c) {
    const [base, light] = TYPE_COLORS[c?.type] ?? TYPE_COLORS.mixed;
    const c1 = isHex(c?.color) ? c.color : base;
    const c2 = isHex(c?.color2) ? c.color2 : isHex(c?.color) ? rgbHex(mixRgb(hexRgb(c1), [255, 255, 255], 0.45)) : light;
    return [c1, c2];
  }
  const PAINTED = ['--accent', '--accent-hover', '--on-accent', '--accent-2', '--tint', '--glow-1', '--glow-2', '--glow-3',
    '--bg', '--surface', '--raised', '--raised-hover', '--text', '--muted', '--faint', '--field-border'];
  // Kolor rozjaśniany, aż ma kontrast co najmniej min na danym tle.
  const lift = (c, against, min) => {
    let out = c;
    for (let t = 0.05; ratio(out, against) < min && t <= 1; t += 0.05) out = mixRgb(c, [255, 255, 255], t);
    return out;
  };
  function paint(colors) {
    const st = root.style;
    if (!colors || !isHex(colors[0])) {
      PAINTED.forEach((k) => st.removeProperty(k));
    } else {
      const c1 = colors[0];
      const c2 = isHex(colors[1]) ? colors[1] : c1;
      // Ciemne tło i karty w odcieniu eventu (zamiast turkusowo-zielonych z ogólnej palety strony).
      const hue = hexRgb(c1);
      const ink = [3, 5, 8];
      const bg = mixRgb(hue, ink, 0.93);
      const surface = mixRgb(hue, ink, 0.86);
      const raised = mixRgb(hue, ink, 0.79);
      st.setProperty('--bg', rgbHex(bg));
      st.setProperty('--surface', rgbHex(surface));
      st.setProperty('--raised', rgbHex(raised));
      st.setProperty('--raised-hover', rgbHex(mixRgb(hue, ink, 0.72)));
      st.setProperty('--text', rgbHex(mixRgb([255, 255, 255], hue, 0.06)));
      st.setProperty('--muted', rgbHex(lift(mixRgb([196, 202, 210], hue, 0.18), surface, 4.5)));
      st.setProperty('--faint', rgbHex(lift(mixRgb([166, 174, 184], hue, 0.18), raised, 4.5)));
      st.setProperty('--field-border', rgbHex(lift(mixRgb([118, 128, 140], hue, 0.3), surface, 3)));
      const a = lift(hue, bg, 4.5);
      const dark = mixRgb(a, [0, 0, 0], 0.82);
      const light = mixRgb(a, [255, 255, 255], 0.92);
      st.setProperty('--accent', rgbHex(a));
      st.setProperty('--accent-hover', rgbHex(mixRgb(a, [255, 255, 255], 0.2)));
      st.setProperty('--on-accent', rgbHex(ratio(dark, a) >= ratio(light, a) ? dark : light));
      st.setProperty('--accent-2', rgbHex(lift(hexRgb(c2), bg, 4.5)));
      st.setProperty('--tint', rgbHex(mixRgb(hexRgb(c1), PAGE_BG, 0.8)));
      st.setProperty('--glow-1', c1);
      st.setProperty('--glow-2', c2);
      st.setProperty('--glow-3', rgbHex(mixRgb(hexRgb(c1), PAGE_BG, 0.55)));
    }
    document.dispatchEvent(new Event('rb:theme'));
  }

  // ---------- Ikona i banery z panelu (Ustawienia → Wygląd strony) ----------
  // Bot podaje adresy wgranych obrazków; puste = domyślne pliki strony. Ostatni wygląd pamiętamy w przeglądarce,
  // żeby przy kolejnej wizycie od razu pokazać właściwy obrazek. Strona eventów słucha zdarzenia „site:look”.
  const SITE_API = ['localhost', '127.0.0.1'].includes(location.hostname)
    ? 'public/site'
    : 'https://ucjmbdogtzztrkorqzjq.supabase.co/functions/v1/hopkostki-bot/panel/public/site';
  const PAGE = root.dataset.page;
  let siteLook = null;
  function applySite(look) {
    if (!look || typeof look !== 'object') return;
    siteLook = look;
    const safe = (url) => (/^https:\/\/[^\s"'<>\\()]+$/.test(String(url ?? '')) ? url : '');
    const icon = safe(look.icon);
    if (icon) {
      document.querySelectorAll('.site-brand img').forEach((img) => { if (img.src !== icon) img.src = icon; });
      document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach((link) => { link.href = icon; });
    }
    const banner = safe(look.banners?.[PAGE]);
    const img = PAGE === 'home' ? $('#hero-media img') : PAGE === 'ranking' ? $('.banner img') : null;
    if (img && banner && img.dataset.site !== banner) {
      img.removeAttribute('srcset');
      img.src = banner;
      img.dataset.site = banner;
    }
    document.dispatchEvent(new CustomEvent('site:look', { detail: look }));
  }
  try { applySite(JSON.parse(localStorage.getItem('site-look') || 'null')); } catch { /* bez pamięci przeglądarki */ }
  fetch(SITE_API)
    .then((res) => (res.ok ? res.json() : null))
    .then((look) => {
      if (!look) return;
      try { localStorage.setItem('site-look', JSON.stringify(look)); } catch { /* tryb prywatny */ }
      applySite(look);
    })
    .catch(() => {});

  // Rok w stopce („© 2026 Entuzjaści Hopkostki”) zawsze bieżący.
  document.querySelectorAll('[data-year]').forEach((el) => { el.textContent = String(new Date().getFullYear()); });

  window.Motion = { on: ON, init, rise, reveal, count, refresh, splitWords, spotlight, magnet, tilt, sparks, scrub, paint, eventColors, stagger, accordion, recomposite, get site() { return siteLook; }, get lenis() { return lenis; } };
})();
