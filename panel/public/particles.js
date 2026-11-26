// Tło stron enho.pl: miękkie plamy światła w kolorach banera (glow) i punkty tsParticles
// (https://github.com/tsparticles/tsparticles, MIT), które powoli dryfują i lekko migoczą na grafitowym tle.
// Ograniczony ruch: punkty stoją. Podgląd w panelu (embed): bez tła. Karta w tle: tsParticles samo pauzuje.
(async () => {
  if (document.documentElement.classList.contains('embed')) return;
  // Kolor w tle: miękkie plamy światła (style w site.css, .glow).
  const glow = document.createElement('div');
  glow.className = 'glow';
  glow.setAttribute('aria-hidden', 'true');
  glow.innerHTML = '<i></i><i></i><i></i>';
  document.body.prepend(glow);
  if (!window.tsParticles) return;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (window.loadBasic) await loadBasic(tsParticles);
  await tsParticles.load({
    id: 'tlo',
    options: {
      fullScreen: { enable: true, zIndex: -1 },
      background: { color: { value: 'transparent' } },
      fpsLimit: 30,
      detectRetina: true,
      pauseOnBlur: true,
      pauseOnOutsideViewport: true,
      particles: {
        number: { value: 110, density: { enable: true, width: 1600, height: 900 } },
        color: { value: ['#9eacc4', '#9eacc4', '#7f8ca3', '#4cc3c8'] },
        shape: { type: 'circle' },
        opacity: { value: { min: 0.06, max: 0.38 }, animation: { enable: !still, speed: 0.35, sync: false } },
        size: { value: { min: 0.6, max: 1.8 } },
        move: { enable: !still, speed: 0.12, direction: 'none', random: true, straight: false, outModes: { default: 'out' } },
      },
      interactivity: { events: { onHover: { enable: false }, onClick: { enable: false } } },
    },
  });
})();
