#!/usr/bin/env node
// Buduje panel/public/icons.svg: jeden plik z ikonami Phosphor (https://phosphoricons.com, licencja MIT).
// Lista ikon i grubość kreski są w scripts/icons.json. Ikony bierzemy z paczki @phosphor-icons/core
// z rejestru npm, więc nie trzeba niczego instalować w projekcie.
//
//   node scripts/icons.mjs              przebuduj icons.svg z listy
//   node scripts/icons.mjs add gift dices   dopisz ikony do listy i przebuduj
//   node scripts/icons.mjs remove gift      usuń ikony z listy i przebuduj
//
// Na stronie: <svg class="i" aria-hidden="true"><use href="icons.svg#gift"></use></svg>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST = path.join(ROOT, 'scripts', 'icons.json');
const OUT = path.join(ROOT, 'panel', 'public', 'icons.svg');
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const config = JSON.parse(fs.readFileSync(LIST, 'utf8'));
const [command, ...args] = process.argv.slice(2);
for (const name of args) {
  if (!NAME.test(name)) throw new Error(`Zła nazwa ikony: ${name}`);
}
if (command === 'add') config.icons = [...new Set([...config.icons, ...args])];
else if (command === 'remove') config.icons = config.icons.filter((name) => !args.includes(name));
else if (command) throw new Error(`Nieznane polecenie: ${command} (add, remove albo nic)`);
config.icons.sort();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-'));
try {
  const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: tmp, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' });
  const weight = config.weight ?? 'regular';
  const fileOf = (name, w) => `package/assets/${w}/${name}${w === 'regular' ? '' : `-${w}`}.svg`;
  const file = (name) => fileOf(name, weight);
  // Dodatkowe odmiany, np. "fill" dla aktywnej pozycji menu: id = nazwa-odmiana (trophy-fill).
  const variants = Object.entries(config.variants ?? {}).flatMap(([w, names]) => names.map((name) => ({ id: `${name}-${w}`, path: fileOf(name, w) })));
  const tarball = run('npm', ['pack', `@phosphor-icons/core@${config.version}`, '--silent']).toString().trim().split('\n').pop();
  const wanted = ['package/LICENSE', ...config.icons.map(file), ...variants.map((v) => v.path)];
  try {
    run('tar', ['-xzf', tarball, ...wanted]);
  } catch {
    const missing = config.icons.filter((name) => {
      try {
        run('tar', ['-xzf', tarball, file(name)]);
        return false;
      } catch {
        return true;
      }
    });
    throw new Error(`Phosphor ${config.version} nie ma ikon: ${missing.join(', ')} (nazwy z https://phosphoricons.com)`);
  }
  const license = fs.readFileSync(path.join(tmp, 'package', 'LICENSE'), 'utf8').replace(/-{2,}/g, '_').trim();
  const symbols = [...config.icons.map((name) => ({ id: name, path: file(name) })), ...variants].map(({ id, path: rel }) => {
    const svg = fs.readFileSync(path.join(tmp, rel), 'utf8');
    const body = svg
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^[\s\S]*?<svg[^>]*>/, '')
      .replace(/<\/svg>\s*$/, '')
      .replace(/\s*\n\s*/g, '')
      .trim();
    const box = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? '0 0 256 256';
    return `<symbol id="${id}" viewBox="${box}">${body}</symbol>`;
  });
  const out = [
    `<!-- Ikony Phosphor ${config.version}, grubość ${weight} (https://phosphoricons.com). Plik generuje scripts/icons.mjs, nie edytuj ręcznie.`,
    '',
    license,
    '-->',
    '<svg xmlns="http://www.w3.org/2000/svg">',
    ...symbols,
    '</svg>',
    '',
  ].join('\n');
  fs.writeFileSync(OUT, out);
  fs.writeFileSync(LIST, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`icons.svg: ${symbols.length} ikon, ${Math.round(out.length / 1024)} KB`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
