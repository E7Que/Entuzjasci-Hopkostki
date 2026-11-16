// Podium 3D na stronie rankingu (three.js): trzy kolumny z metalowymi numerami, medaliony z avatarami,
// reflektory z wolumetrycznym światłem, kurz w świetle, mgła i dym przy podłodze, bloom. Napisy (nick, XP,
// poziom) to zwykły HTML nad sceną — ten moduł tylko ustawia je nad kolumnami. Gdy przeglądarka nie ma WebGL,
// strona zostaje przy podium w CSS.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

const FONT_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/fonts/helvetiker_bold.typeface.json';
const BG = 0x0b1114;
// Kolejność jak w HTML: 0 = 1. miejsce (środek), 1 = 2. (lewo), 2 = 3. (prawo).
const MEDAL = [0xe3b341, 0xb7c3cb, 0xcd8a55];
const LIGHT = [0xfff0cc, 0xe4f0ff, 0xffd8b5];
const PODIUM = [
  { x: 0, h: 2.05, w: 2.45, r: 0.8 },
  { x: -2.72, h: 1.4, w: 2.25, r: 0.66 },
  { x: 2.72, h: 0.95, w: 2.25, r: 0.66 },
];
const DEPTH = 2.1;
const ENTER_DELAY = [0.5, 0.24, 0.04]; // jak w CSS: najpierw 3., potem 2., na końcu 1.
const TAU = Math.PI * 2;
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const easeOutBack = (t) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeInCubic = (t) => t ** 3;

// ---------- Tekstury rysowane w canvasie ----------
function canvasTexture(size, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const glowTexture = () =>
  canvasTexture(128, (g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  }, false);
// Dym: miękkie plamy rysowane z zawinięciem, żeby tekstura się powtarzała bez szwów.
const smokeTexture = () => {
  const tex = canvasTexture(256, (g, s) => {
    for (let i = 0; i < 46; i++) {
      const x = Math.random() * s, y = Math.random() * s, r = rnd(28, 92), a = rnd(0.05, 0.14);
      for (const dx of [-s, 0, s]) {
        for (const dy of [-s, 0, s]) {
          const grad = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
          grad.addColorStop(0, `rgba(255,255,255,${a})`);
          grad.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = grad;
          g.fillRect(0, 0, s, s);
        }
      }
    }
  }, false);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
};
// Avatar zastępczy: pierwsza litera na kolorowym tle (gdy obrazka nie da się wczytać) i kłódka dla ukrytych osób.
function letterTexture(text, color) {
  return canvasTexture(256, (g, s) => {
    const grad = g.createLinearGradient(0, 0, s, s);
    grad.addColorStop(0, color);
    grad.addColorStop(1, '#101418');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    g.fillStyle = '#fff';
    g.font = `700 ${s * 0.5}px Rubik, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(text || '?').slice(0, 1).toUpperCase(), s / 2, s * 0.54);
  });
}
const lockTexture = () =>
  canvasTexture(256, (g, s) => {
    g.fillStyle = '#1b2226';
    g.fillRect(0, 0, s, s);
    g.strokeStyle = '#8b989e';
    g.fillStyle = '#8b989e';
    g.lineWidth = s * 0.055;
    g.beginPath();
    g.arc(s / 2, s * 0.43, s * 0.13, Math.PI, 0);
    g.stroke();
    g.beginPath();
    g.roundRect(s * 0.31, s * 0.43, s * 0.38, s * 0.29, s * 0.04);
    g.fill();
  });

// ---------- Wolumetryczny stożek światła ----------
const CONE_VERT = `
  varying vec3 vNormal;
  varying vec3 vWorld;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;
const CONE_FRAG = `
  uniform vec3 uColor;
  uniform vec3 uApex;
  uniform float uLength;
  uniform float uGain;
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vWorld;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  void main() {
    float along = clamp(distance(vWorld, uApex) / uLength, 0.0, 1.0);
    float fall = pow(1.0 - along, 1.15) * smoothstep(0.0, 0.12, along);
    vec3 n = vec3(vNormal.x, vNormal.y, abs(vNormal.z));
    float edge = pow(max(dot(n, vec3(0.0, 0.0, 1.0)), 0.0), 3.2);
    float haze = 0.72 + 0.5 * noise(vWorld * 1.4 + vec3(0.0, -uTime * 0.25, uTime * 0.12));
    float floorFade = smoothstep(0.0, 0.9, vWorld.y);
    gl_FragColor = vec4(uColor, fall * edge * haze * floorFade * uGain);
  }`;

// ---------- Kurz w świetle (punkty krążące w stożkach) ----------
const DUST_VERT = `
  attribute float aSeed;
  attribute float aSlot;
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uScale;
  uniform vec3 uGain;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec3 p = position;
    float t = uTime * (0.35 + aSeed * 0.5);
    p += vec3(sin(t + aSeed * 31.0), sin(t * 0.7 + aSeed * 17.0) * 0.7, cos(t * 0.8 + aSeed * 11.0)) * 0.16;
    p.y += sin(uTime * 0.18 + aSeed * 6.28) * 0.25;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uScale * (0.45 + aSeed * 0.9) / -mv.z;
    float gain = aSlot < 0.5 ? uGain.x : aSlot < 1.5 ? uGain.y : uGain.z;
    vAlpha = gain * (0.12 + 0.5 * pow(abs(sin(uTime * (0.5 + aSeed) + aSeed * 40.0)), 3.0));
    vColor = aColor;
  }`;
const DUST_FRAG = `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vColor, a * a * vAlpha);
  }`;

// ---------- Scena ----------
export function createPodium3D(container, { overlays = [], reduced = false, waitForEnter = false, onReady = null } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'pod3d';
  canvas.setAttribute('aria-hidden', 'true');
  container.prepend(canvas);
  const mobile = () => container.clientWidth < 560;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.FogExp2(BG, 0.052);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(30, 2, 0.1, 80);
  const lookAt = new THREE.Vector3(0, 2.35, 0);
  const camBase = new THREE.Vector3(0, 4, 14);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.5, 0.86);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  scene.add(new THREE.HemisphereLight(0x9cc7d1, 0x07090a, 0.32));
  const glow = glowTexture();
  const smoke = smokeTexture();

  // Podłoga: ciemna, lekko połyskująca, z siatką jak w tle strony i poświatą sceny pod podium.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), new THREE.MeshStandardMaterial({ color: 0x0e1518, roughness: 0.52, metalness: 0.25, envMapIntensity: 0.25 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(44, 44, 0x2e6a73, 0x1c3a40);
  grid.material.transparent = true;
  grid.material.opacity = 0.18;
  grid.position.y = 0.003;
  scene.add(grid);
  const stageGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(13, 7),
    new THREE.MeshBasicMaterial({ map: glow, color: 0x3cc3d6, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  stageGlow.rotation.x = -Math.PI / 2;
  stageGlow.position.set(0, 0.006, 0.4);
  scene.add(stageGlow);

  // Mgła przy podłodze i dym za podium — warstwy z przesuwającą się teksturą dymu.
  const hazeLayers = [];
  const hazeColor = new THREE.Color(0x8fbac3);
  for (const [y, z, opacity, w, speed] of [[0.1, 1.2, 0.26, 22, 0.012], [0.26, 0.4, 0.2, 20, -0.009], [0.48, -0.4, 0.14, 22, 0.007], [0.78, -1.2, 0.09, 24, -0.006]]) {
    const map = smoke.clone();
    map.needsUpdate = true;
    map.repeat.set(2.2, 1.1);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, 9), new THREE.MeshBasicMaterial({ map, color: hazeColor, transparent: true, opacity, depthWrite: false }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, y, z);
    mesh.renderOrder = 1;
    scene.add(mesh);
    hazeLayers.push({ mesh, map, speed, base: opacity });
  }
  for (const [z, y, opacity, speed] of [[-3.4, 2.6, 0.06, 0.005], [-6, 3.2, 0.05, -0.004]]) {
    const map = smoke.clone();
    map.needsUpdate = true;
    map.repeat.set(2.4, 1);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(26, 9), new THREE.MeshBasicMaterial({ map, color: hazeColor, transparent: true, opacity, depthWrite: false }));
    mesh.position.set(0, y, z);
    mesh.renderOrder = 1;
    scene.add(mesh);
    hazeLayers.push({ mesh, map, speed, base: opacity });
  }

  // Wspólne materiały.
  const metal = MEDAL.map((c) => new THREE.MeshStandardMaterial({ color: c, metalness: 1, roughness: 0.26, envMapIntensity: 1.25 }));
  const bodyMat = new THREE.MeshPhysicalMaterial({ color: 0x141c20, metalness: 0.35, roughness: 0.38, clearcoat: 0.7, clearcoatRoughness: 0.22, envMapIntensity: 0.55 });
  const lockTex = lockTexture();

  // Każde miejsce: grupa (wjeżdża z podłogi) z kolumną, medalionem i reflektorem.
  const slots = PODIUM.map((p, i) => {
    const group = new THREE.Group();
    group.position.x = p.x;
    scene.add(group);
    const body = new THREE.Mesh(new RoundedBoxGeometry(p.w, p.h, DEPTH, 4, 0.09), bodyMat);
    body.position.y = p.h / 2;
    body.castShadow = body.receiveShadow = true;
    group.add(body);
    const cap = new THREE.Mesh(new RoundedBoxGeometry(p.w + 0.07, 0.09, DEPTH + 0.07, 3, 0.035), metal[i]);
    cap.position.y = p.h + 0.035;
    cap.castShadow = cap.receiveShadow = true;
    group.add(cap);
    // Świecący pasek u dołu i na krawędzi blatu (łapie bloom).
    const ledMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(MEDAL[i]).multiplyScalar(2.4) });
    const led = new THREE.Mesh(new THREE.BoxGeometry(p.w * 0.86, 0.035, 0.02), ledMat);
    led.position.set(0, 0.16, DEPTH / 2 + 0.012);
    group.add(led);
    const capLed = new THREE.Mesh(new THREE.BoxGeometry(p.w * 0.92, 0.02, 0.02), ledMat);
    capLed.position.set(0, p.h - 0.035, DEPTH / 2 + 0.012);
    group.add(capLed);

    // Medalion z avatarem nad kolumną: przód (avatar), tył i krawędź z metalu, obręcz w kolorze medalu.
    const medal = new THREE.Group();
    group.add(medal);
    const spin = new THREE.Group();
    medal.add(spin);
    const avatarMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.78, metalness: 0, emissive: 0xffffff, emissiveIntensity: 0.13, envMapIntensity: 0.08 });
    const t = 0.12;
    const front = new THREE.Mesh(new THREE.CircleGeometry(p.r, 64), avatarMat);
    front.position.z = t / 2 + 0.001;
    const back = new THREE.Mesh(new THREE.CircleGeometry(p.r, 64), metal[i]);
    back.rotation.y = Math.PI;
    back.position.z = -t / 2 - 0.001;
    const edge = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r, t, 64, 1, true), metal[i]);
    edge.rotation.x = Math.PI / 2;
    const rimMat = metal[i].clone();
    const rim = new THREE.Mesh(new THREE.TorusGeometry(p.r + 0.03, 0.055, 18, 96), rimMat);
    rim.position.z = t / 2;
    for (const m of [front, back, edge, rim]) {
      m.castShadow = true;
      spin.add(m);
    }
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: MEDAL[i], transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.scale.setScalar(p.r * 3.4);
    halo.position.z = -0.25;
    medal.add(halo);

    // Reflektor: oprawa nad sceną, światło z cieniem i widoczny stożek w mgle.
    const apex = new THREE.Vector3(p.x * 0.42, 8.6, 3.3);
    const target = new THREE.Vector3(p.x, p.h + 0.9, 0);
    const spot = new THREE.SpotLight(LIGHT[i], 0, 24, 0, 0.55, 1.25);
    spot.position.copy(apex);
    spot.target.position.copy(target);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.bias = -0.0004;
    spot.shadow.radius = 5;
    scene.add(spot, spot.target);
    const len = apex.distanceTo(target) * 1.18;
    const radius = (i === 0 ? 1.85 : 1.5) * 1.18;
    spot.angle = Math.atan(radius / len) * 1.08;
    const coneGeo = new THREE.ConeGeometry(radius, len, 64, 24, true);
    coneGeo.translate(0, -len / 2, 0);
    coneGeo.rotateX(-Math.PI / 2);
    const coneMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(LIGHT[i]) }, uApex: { value: apex.clone() }, uLength: { value: len }, uGain: { value: 0 }, uTime: { value: 0 } },
      vertexShader: CONE_VERT,
      fragmentShader: CONE_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.copy(apex);
    cone.lookAt(target);
    cone.renderOrder = 2;
    scene.add(cone);
    const housing = new THREE.Group();
    housing.position.copy(apex);
    housing.lookAt(target);
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.34, 0.6, 28, 1, true), new THREE.MeshStandardMaterial({ color: 0x0b0f11, metalness: 0.8, roughness: 0.4, side: THREE.DoubleSide }));
    can.rotation.x = Math.PI / 2;
    const lensMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(LIGHT[i]).multiplyScalar(0) });
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.3, 32), lensMat);
    lens.position.z = 0.3;
    housing.add(can, lens);
    scene.add(housing);

    return {
      i, p, group, medal, spin, front, rim, rimMat, avatarMat, halo, spot, cone, coneMat, lensMat, ledMat, apex, target, len, radius,
      number: null, kind: 'vacant', key: '', tex: null, gain: 0, gainTarget: 0, lift: 0, hover: 0, selected: 0,
      medalY: p.h + 1.6, rise: 1, drop: 1, flip: null, pulse: 0,
    };
  });

  // Korona nad 1. miejscem i iskierki.
  const crown = new THREE.Group();
  {
    const gold = new THREE.MeshStandardMaterial({ color: 0xf2c14e, metalness: 1, roughness: 0.2, envMapIntensity: 1.5, side: THREE.DoubleSide });
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.37, 0.2, 40, 1, true), gold);
    crown.add(band);
    const gemColors = [0xff4f6d, 0x5ad1ff, 0xff4f6d, 0x5ad1ff, 0xff4f6d];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.3, 16), gold);
      spike.position.set(Math.sin(a) * 0.33, 0.24, Math.cos(a) * 0.33);
      spike.rotation.z = -Math.sin(a) * 0.18;
      spike.rotation.x = Math.cos(a) * 0.18;
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.048, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff2c0).multiplyScalar(2.2) }));
      tip.position.set(Math.sin(a) * 0.36, 0.41, Math.cos(a) * 0.36);
      const gem = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(gemColors[k]).multiplyScalar(1.6) }));
      gem.position.set(Math.sin(a + TAU / 10) * 0.37, 0, Math.cos(a + TAU / 10) * 0.37);
      crown.add(spike, tip, gem);
    }
    crown.traverse((m) => { if (m.isMesh) m.castShadow = true; });
    crown.scale.setScalar(1.3);
    slots[0].medal.add(crown);
  }

  // Kurz w snopach światła.
  const DUST = mobile() ? 150 : 280;
  const dustGeo = new THREE.BufferGeometry();
  {
    const pos = new Float32Array(DUST * 3), seed = new Float32Array(DUST), slotOf = new Float32Array(DUST), col = new Float32Array(DUST * 3);
    const up = new THREE.Vector3(0, 1, 0), tmp = new THREE.Vector3(), side = new THREE.Vector3(), side2 = new THREE.Vector3();
    for (let k = 0; k < DUST; k++) {
      const s = slots[k % 5 < 2 ? 0 : k % 5 < 4 ? 1 + (k % 2) : 0];
      const dir = tmp.copy(s.target).sub(s.apex).normalize();
      side.crossVectors(dir, up).normalize();
      side2.crossVectors(dir, side).normalize();
      const along = rnd(0.18, 1.08);
      const rr = s.radius * along * Math.sqrt(Math.random()) * 0.92;
      const a = rnd(0, TAU);
      const point = s.apex.clone().addScaledVector(dir, s.len * along * 0.85).addScaledVector(side, Math.cos(a) * rr).addScaledVector(side2, Math.sin(a) * rr);
      pos.set([point.x, Math.max(0.15, point.y), point.z], k * 3);
      seed[k] = Math.random();
      slotOf[k] = s.i;
      const c = new THREE.Color(LIGHT[s.i]);
      col.set([c.r, c.g, c.b], k * 3);
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    dustGeo.setAttribute('aSlot', new THREE.BufferAttribute(slotOf, 1));
    dustGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  }
  const dustMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uScale: { value: 120 }, uGain: { value: new THREE.Vector3() } },
    vertexShader: DUST_VERT,
    fragmentShader: DUST_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.renderOrder = 3;
  scene.add(dust);

  // Iskierki wokół zwycięzcy i konfetti przy wejściu (instancje małych prostokątów z fizyką na CPU).
  const starTex = canvasTexture(128, (g, size) => {
    const c = size / 2;
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.12, 'rgba(255,255,255,0.8)');
    grad.addColorStop(0.3, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU, r = k % 2 ? size * 0.07 : size * 0.48;
      g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    }
    g.closePath();
    g.fill();
  }, false);
  const sparkMat = new THREE.SpriteMaterial({ map: starTex, color: 0xfff3c4, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const sparks = Array.from({ length: 10 }, (_, k) => {
    const sp = new THREE.Sprite(sparkMat.clone());
    sp.userData = { a: (k / 10) * TAU + rnd(0, 0.5), r: rnd(1.0, 1.35), y: rnd(-0.7, 0.9), ph: rnd(0, TAU), sp: rnd(0.8, 1.6) };
    slots[0].medal.add(sp);
    return sp;
  });
  const CONFETTI = 140;
  const confetti = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.07, 0.12), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }), CONFETTI);
  confetti.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  confetti.visible = false;
  confetti.frustumCulled = false;
  scene.add(confetti);
  const confettiColors = [0xffd23f, 0xfff1b8, 0x3cc3d6, 0xff4fa3, 0x8a5cff, 0xe3b341];
  const bits = Array.from({ length: CONFETTI }, (_, k) => {
    confetti.setColorAt(k, new THREE.Color(confettiColors[k % confettiColors.length]));
    return { p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), vr: new THREE.Vector3(), life: 0 };
  });
  let confettiOn = false;
  const dummy = new THREE.Object3D();
  function burst() {
    if (reduced) return;
    const s = slots[0];
    const from = new THREE.Vector3(0, s.medalY + 0.4, 0.3);
    for (const b of bits) {
      b.p.copy(from);
      const a = rnd(0, TAU), up = rnd(4.5, 8.5), out = rnd(1.2, 4.2);
      b.v.set(Math.cos(a) * out, up, Math.sin(a) * out * 0.6 + 0.6);
      b.r.set(rnd(0, TAU), rnd(0, TAU), rnd(0, TAU));
      b.vr.set(rnd(-9, 9), rnd(-9, 9), rnd(-9, 9));
      b.life = rnd(2.4, 3.6);
    }
    confetti.visible = true;
    confettiOn = true;
  }
  function stepConfetti(dt) {
    if (!confettiOn) return;
    let alive = 0;
    bits.forEach((b, k) => {
      b.life -= dt;
      if (b.life > 0) alive += 1;
      b.v.y -= 9.5 * dt;
      b.v.multiplyScalar(Math.pow(0.35, dt));
      b.p.addScaledVector(b.v, dt);
      if (b.p.y < 0.02) { b.p.y = 0.02; b.v.set(0, 0, 0); b.vr.multiplyScalar(0.8); }
      b.r.x += b.vr.x * dt; b.r.y += b.vr.y * dt; b.r.z += b.vr.z * dt;
      dummy.position.copy(b.p);
      dummy.rotation.copy(b.r);
      dummy.scale.setScalar(b.life > 0 ? Math.min(1, b.life * 1.5) : 0);
      dummy.updateMatrix();
      confetti.setMatrixAt(k, dummy.matrix);
    });
    confetti.instanceMatrix.needsUpdate = true;
    if (!alive) { confettiOn = false; confetti.visible = false; }
  }

  // Metalowe numery na frontach kolumn (czcionka z three.js; bez niej — numer z canvasa).
  new FontLoader().load(
    FONT_URL,
    (font) => {
      slots.forEach((s) => {
        const size = s.i === 0 ? 0.95 : s.i === 1 ? 0.72 : 0.56;
        const geo = new TextGeometry(String(s.i + 1), { font, size, height: 0.12, curveSegments: 8, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.022, bevelSegments: 4 });
        geo.computeBoundingBox();
        const bb = geo.boundingBox;
        geo.translate(-(bb.max.x + bb.min.x) / 2, -(bb.max.y + bb.min.y) / 2, 0);
        const mat = metal[s.i].clone();
        mat.emissive = new THREE.Color(MEDAL[s.i]);
        mat.emissiveIntensity = 0.12;
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(0, s.p.h * 0.52, DEPTH / 2 + 0.01);
        mesh.castShadow = true;
        s.group.add(mesh);
        s.number = mesh;
      });
      requestRender();
    },
    undefined,
    () => {
      slots.forEach((s) => {
        const tex = canvasTexture(256, (g, size) => {
          g.fillStyle = `#${MEDAL[s.i].toString(16).padStart(6, '0')}`;
          g.font = `800 ${size * 0.8}px Rubik, system-ui, sans-serif`;
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText(String(s.i + 1), size / 2, size * 0.55);
        });
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
        const k = s.i === 0 ? 1.3 : s.i === 1 ? 1 : 0.8;
        plane.scale.setScalar(k);
        plane.position.set(0, s.p.h * 0.52, DEPTH / 2 + 0.02);
        s.group.add(plane);
      });
      requestRender();
    },
  );

  // ---------- Rozmiar, kamera i napisy ----------
  let width = 1, height = 1, ppu = 90, ready = false;
  const anchor = new THREE.Vector3();
  function overlayHeight(i) {
    return overlays[i]?.offsetHeight || 0;
  }
  function layout() {
    width = Math.max(1, container.clientWidth);
    height = Math.max(1, container.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, mobile() ? 1.5 : 1.75);
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    composer.setPixelRatio(dpr);
    composer.setSize(width, height);
    bloom.resolution.set(width / 2, height / 2);
    camera.aspect = width / height;
    // Kamera tak daleko, żeby zmieściły się trzy kolumny z medalionami; wysokość napisów (w px) przeliczona
    // na jednostki sceny wyznacza, jak wysoko unoszą się medaliony.
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const pitch = 0.16;
    let dist = 14;
    const place = () => {
      camBase.set(0, lookAt.y + Math.sin(pitch) * dist, Math.cos(pitch) * dist);
      camera.position.copy(camBase);
      camera.lookAt(lookAt);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
    };
    // Kilka przybliżeń: kamera → gdzie na ekranie wypadają napisy → jak wysoko muszą wisieć medaliony → kamera.
    slots.forEach((s) => { s.medalY = s.p.h + 1.2 + s.p.r; });
    for (let pass = 0; pass < 4; pass++) {
      const top = Math.max(...slots.map((s) => s.medalY + s.p.r + (s.i === 0 ? 0.85 : 0.25)));
      lookAt.set(0, top / 2 + 0.05, 0);
      dist = Math.max(4.15 / Math.tan(hFov / 2), (top / 2 + 0.35) / Math.tan(vFov / 2)) + 1.1;
      place();
      slots.forEach((s) => {
        // Górna krawędź napisów na ekranie → wysokość w scenie (w płaszczyźnie medalionu), nad nią dolny brzeg medalionu.
        const labelTop = screenY(s.p.x, s.p.h + 0.09, -DEPTH * 0.42) - overlayHeight(s.i) - 6 - 8;
        s.medalY = worldYAt(s.p.x, 0.15, labelTop) + s.p.r + 0.05;
      });
    }
    ppu = height / (2 * dist * Math.tan(vFov / 2));
    // Napisy tak szerokie jak kolumna na ekranie (długie nicki się skracają, nie nachodzą na sąsiadów).
    slots.forEach((s) => {
      const el = overlays[s.i];
      if (!el) return;
      const left = probe.set(s.p.x - s.p.w / 2, s.p.h, -DEPTH * 0.42).project(camera).x;
      const right = probe.set(s.p.x + s.p.w / 2, s.p.h, -DEPTH * 0.42).project(camera).x;
      el.style.width = `${Math.round(((right - left) / 2) * width * 1.12)}px`;
    });
    dustMat.uniforms.uScale.value = 52 * (height / 400) * Math.min(window.devicePixelRatio || 1, 1.75);
    requestRender();
  }
  const probe = new THREE.Vector3();
  function screenY(x, y, z) {
    probe.set(x, y, z).project(camera);
    return (-probe.y * 0.5 + 0.5) * height;
  }
  // Wysokość w scenie (dla danego x, z), która wypada na ekranie na wysokości py — szukanie połówkowe.
  function worldYAt(x, z, py) {
    let lo = 0, hi = 14;
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2;
      if (screenY(x, mid, z) > py) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }
  function placeOverlays() {
    slots.forEach((s) => {
      const el = overlays[s.i];
      if (!el) return;
      anchor.set(s.p.x, s.group.position.y + s.p.h + 0.09, -DEPTH * 0.42).project(camera);
      const x = (anchor.x * 0.5 + 0.5) * width;
      const y = (-anchor.y * 0.5 + 0.5) * height;
      el.style.translate = `${Math.round(x - el.offsetWidth / 2)}px ${Math.round(y - el.offsetHeight - 6)}px`;
    });
  }

  // ---------- Osoby na podium ----------
  const texCache = new Map();
  function avatarTexture(slot) {
    if (slot.kind === 'hidden') return Promise.resolve(lockTex);
    const url = slot.avatar;
    if (!url) return Promise.resolve(letterTexture(slot.name, '#2e6a73'));
    if (!texCache.has(url)) {
      texCache.set(url, new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.onload = () => {
          try {
            const tex = canvasTexture(256, (g, size) => {
              const w = img.naturalWidth || size, h = img.naturalHeight || size;
              const k = Math.max(size / w, size / h);
              g.drawImage(img, (size - w * k) / 2, (size - h * k) / 2, w * k, h * k);
            });
            tex.anisotropy = 4;
            resolve(tex);
          } catch {
            resolve(letterTexture(slot.name, '#2e6a73'));
          }
        };
        img.onerror = () => resolve(letterTexture(slot.name, '#2e6a73'));
        img.src = url;
      }));
    }
    return texCache.get(url);
  }
  function applyTexture(s, tex) {
    s.avatarMat.map = tex;
    s.avatarMat.emissiveMap = tex;
    s.avatarMat.needsUpdate = true;
    s.tex = tex;
    requestRender();
  }
  // data: [{ kind: 'person'|'hidden'|'vacant', key, avatar, name }] w kolejności 1., 2., 3. miejsce.
  function setSlots(data, { animate = true } = {}) {
    data.forEach((d, i) => {
      const s = slots[i];
      const next = d ?? { kind: 'vacant', key: '' };
      if (next.key === s.key && next.kind === s.kind) return;
      const was = s.kind;
      s.key = next.key;
      s.kind = next.kind;
      const texReady = next.kind === 'vacant' ? Promise.resolve(null) : avatarTexture(next);
      s.gainTarget = next.kind === 'vacant' ? 0.07 : 1;
      if (!animate || reduced || !ready || was === 'vacant' || next.kind === 'vacant') {
        texReady.then((tex) => {
          if (tex && s.key === next.key) applyTexture(s, tex);
        });
        s.medal.visible = next.kind !== 'vacant';
        if (animate && ready && !reduced && next.kind !== 'vacant' && was === 'vacant') s.drop = 0;
        requestRender();
        return;
      }
      // Podmiana: medalion obraca się bokiem, w połowie zmienia avatar, reflektor mruga (od 3. do 1. miejsca).
      s.flip = { t: -(2 - i) * 0.08, swapped: false, tex: null };
      texReady.then((tex) => {
        if (s.flip && s.key === next.key) s.flip.tex = tex;
        else if (tex && s.key === next.key) applyTexture(s, tex);
      });
      wake();
    });
    layout();
  }
  function setHover(i) {
    slots.forEach((s) => { s.hoverTarget = s.i === i && s.kind !== 'vacant' ? 1 : 0; });
    wake();
  }
  function setSelected(i) {
    slots.forEach((s) => { s.selected = s.i === i ? 1 : 0; });
    wake();
  }
  function flash(i) {
    if (slots[i]) slots[i].pulse = 1;
    wake();
  }
  const accent = new THREE.Color(0x3cc3d6);
  function setAccent(color) {
    try {
      accent.set(color || '#3cc3d6');
    } catch {
      accent.set(0x3cc3d6);
    }
    stageGlow.material.color.copy(accent);
    hazeColor.set(0x8fbac3).lerp(accent, 0.25);
    hazeLayers.forEach((h) => h.mesh.material.color.copy(hazeColor));
    requestRender();
  }

  // ---------- Animacja ----------
  let clock = 0, last = 0, raf = 0, visible = false, entering = null, dirty = true, idleUntil = 0;
  // Czeka na animację wejścia (strona ją uruchamia, gdy podium pojawi się na ekranie): kolumny pod podłogą, światła zgaszone.
  let held = Boolean(waitForEnter) && !reduced;
  const pointer = new THREE.Vector2(), pointerSmooth = new THREE.Vector2();
  const accentRim = new THREE.Color(0x3cc3d6);
  function enter() {
    held = false;
    if (reduced) return;
    entering = 0;
    slots.forEach((s) => { s.rise = 0; s.drop = 0; s.gain = 0; });
    wake();
  }
  function frame(now) {
    raf = 0;
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 0.016;
    last = now;
    if (!reduced) clock += dt;
    let busy = !reduced;

    if (held) {
      slots.forEach((s) => { s.rise = 0; s.drop = 0; s.gain = 0; });
    } else if (entering !== null) {
      entering += dt;
      slots.forEach((s) => {
        const t0 = ENTER_DELAY[s.i];
        s.rise = clamp01((entering - t0) / 0.75);
        s.drop = clamp01((entering - t0 - 0.62) / 0.7);
      });
      if (entering > 0.95 && entering - dt <= 0.95) {
        slots.forEach((s) => { s.gain = 0; });
      }
      if (entering > 1.9 && entering - dt <= 1.9) burst();
      if (entering > 2.6) entering = null;
    }

    slots.forEach((s) => {
      // Kolumna wjeżdża z podłogi, medalion spada z góry z odbiciem.
      s.group.position.y = -(s.p.h + 0.3) * (1 - easeOutBack(s.rise));
      if (s.drop < 1 && entering === null) s.drop = Math.min(1, s.drop + dt / 0.7);
      const drop = easeOutBack(s.drop);
      s.medal.scale.setScalar(0.55 + 0.45 * drop);
      s.medal.visible = s.kind !== 'vacant' && s.drop > 0;

      // Światło: zapala się z migotaniem po wjeździe kolumny.
      let target = s.gainTarget;
      if (held) {
        s.gain = 0;
      } else if (entering !== null) {
        const on = entering - ENTER_DELAY[s.i] - 0.58;
        target = on < 0 ? 0 : on < 0.08 ? 0.8 : on < 0.16 ? 0.1 : on < 0.27 ? 1 : on < 0.34 ? 0.35 : s.gainTarget;
        s.gain = target;
      } else {
        s.gain += (target - s.gain) * Math.min(1, dt * 5);
      }
      if (held) target = 0;
      s.hover += ((s.hoverTarget ?? 0) - s.hover) * Math.min(1, dt * 8);
      s.pulse = Math.max(0, s.pulse - dt * 0.8);
      const blink = s.flip && s.flip.t > 0 && s.flip.t < 0.45 ? 0.35 + 0.65 * Math.abs(Math.cos(s.flip.t * 14)) : 1;
      const g = s.gain * blink * (1 + s.hover * 0.3 + s.pulse * 0.6);
      s.spot.intensity = g * (s.i === 0 ? 75 : 52);
      s.coneMat.uniforms.uGain.value = g * (s.i === 0 ? 0.32 : 0.26);
      s.coneMat.uniforms.uTime.value = clock;
      s.lensMat.color.set(LIGHT[s.i]).multiplyScalar(0.4 + g * 3);
      s.ledMat.color.set(MEDAL[s.i]).multiplyScalar(0.5 + Math.min(g, 1.2) * 2);

      // Medalion: unosi się i lekko kołysze; podmiana = obrót bokiem.
      const bob = reduced ? 0 : Math.sin(clock * 1.3 + s.i * 1.7) * 0.06;
      s.medal.position.set(0, s.medalY + bob + s.hover * 0.14 + (1 - drop) * 2.2, 0.15);
      let rotY = reduced ? 0 : Math.sin(clock * 0.55 + s.i * 2.1) * 0.22 + s.hover * Math.sin(clock * 3) * 0.12;
      if (s.flip) {
        s.flip.t += dt;
        const t = s.flip.t;
        if (t < 0) {
          // czeka na swoją kolej
        } else if (t < 0.18) {
          rotY += (Math.PI / 2) * easeInCubic(t / 0.18);
        } else {
          if (!s.flip.swapped && (s.flip.tex || t > 1.2)) {
            if (s.flip.tex) applyTexture(s, s.flip.tex);
            s.flip.swapped = true;
            s.flip.t = 0.18;
          }
          if (!s.flip.swapped) rotY += Math.PI / 2;
          else {
            const k = clamp01((s.flip.t - 0.18) / 0.34);
            rotY += -(Math.PI / 2) * (1 - easeOutBack(k));
            if (k >= 1) s.flip = null;
          }
        }
      }
      s.spin.rotation.y = rotY;
      s.rimMat.color.set(MEDAL[s.i]).lerp(accentRim, s.selected * 0.65);
      s.rimMat.emissive.copy(accentRim).multiplyScalar(s.selected * 0.35);
      s.halo.material.opacity = (0.22 + s.hover * 0.18 + s.pulse * 0.3) * s.gain;
    });

    crown.rotation.y = reduced ? 0.4 : clock * 0.6;
    crown.position.set(0, slots[0].p.r + 0.2 + (reduced ? 0 : Math.sin(clock * 2) * 0.04), 0);
    sparks.forEach((sp) => {
      const u = sp.userData;
      const k = reduced ? 0.6 : Math.max(0, Math.sin(clock * u.sp + u.ph));
      sp.position.set(Math.cos(u.a + clock * 0.2) * u.r, u.y, Math.sin(u.a + clock * 0.2) * 0.3 + 0.2);
      sp.scale.setScalar(0.04 + k * 0.2);
      sp.material.opacity = k * slots[0].gain;
    });
    dustMat.uniforms.uTime.value = clock;
    dustMat.uniforms.uGain.value.set(slots[0].gain, slots[1].gain, slots[2].gain);
    hazeLayers.forEach((h, k) => {
      h.map.offset.x = clock * h.speed;
      h.map.offset.y = clock * h.speed * 0.4 * (k % 2 ? -1 : 1);
    });
    stepConfetti(dt);

    // Kamera: lekkie kołysanie i paralaksa za kursorem.
    pointerSmooth.lerp(pointer, Math.min(1, dt * 3));
    camera.position.set(
      camBase.x + (reduced ? 0 : Math.sin(clock * 0.21) * 0.25) + pointerSmooth.x * 0.7,
      camBase.y + (reduced ? 0 : Math.sin(clock * 0.17) * 0.08) - pointerSmooth.y * 0.35,
      camBase.z,
    );
    camera.lookAt(lookAt);

    composer.render(dt);
    placeOverlays();
    dirty = false;
    if (slots.some((s) => s.flip || Math.abs(s.gain - s.gainTarget) > 0.01 || Math.abs(s.hover - (s.hoverTarget ?? 0)) > 0.01 || s.pulse > 0) || entering !== null || confettiOn) busy = true;
    if (performance.now() < idleUntil) busy = true;
    if (visible && !document.hidden && (busy || dirty)) raf = requestAnimationFrame(frame);
  }
  function wake() {
    idleUntil = performance.now() + 600;
    if (!raf && visible && !document.hidden) {
      last = 0;
      raf = requestAnimationFrame(frame);
    }
  }
  function requestRender() {
    dirty = true;
    wake();
  }

  const io = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible) wake();
  });
  io.observe(container);
  const ro = new ResizeObserver(() => layout());
  ro.observe(container);
  overlays.forEach((el) => el && ro.observe(el));
  const onVisibility = () => { if (!document.hidden) wake(); };
  document.addEventListener('visibilitychange', onVisibility);
  const onPointer = (event) => {
    const r = container.getBoundingClientRect();
    pointer.set(((event.clientX - r.left) / r.width) * 2 - 1, ((event.clientY - r.top) / r.height) * 2 - 1);
    wake();
  };
  const onLeave = () => { pointer.set(0, 0); wake(); };
  if (!reduced) {
    container.addEventListener('pointermove', onPointer);
    container.addEventListener('pointerleave', onLeave);
  }
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    destroy();
    container.dispatchEvent(new CustomEvent('pod3d-lost'));
  });

  function destroy() {
    cancelAnimationFrame(raf);
    raf = 0;
    io.disconnect();
    ro.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    container.removeEventListener('pointermove', onPointer);
    container.removeEventListener('pointerleave', onLeave);
    renderer.dispose();
    canvas.remove();
    overlays.forEach((el) => { if (el) { el.style.translate = ''; el.style.width = ''; } });
  }

  layout();
  ready = true;
  slots.forEach((s) => { s.gain = 0; s.gainTarget = 0.07; s.medal.visible = false; });
  onReady?.();
  return { setSlots, setHover, setSelected, flash, setAccent, enter, layout, destroy, burst };
}
