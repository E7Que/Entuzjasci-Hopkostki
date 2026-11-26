#!/usr/bin/env node
// Buduje panel/public/icons.svg: jeden plik z ikonami Lucide (https://lucide.dev, licencja ISC).
// Lista ikon jest w scripts/icons.json. Ikony bierzemy z paczki lucide-static z rejestru npm,
// więc nie trzeba niczego instalować w projekcie.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucide-'));
try {
  const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: tmp, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' });
  const tarball = run('npm', ['pack', `lucide-static@${config.version}`, '--silent']).toString().trim().split('\n').pop();
  const wanted = ['package/LICENSE', ...config.icons.map((name) => `package/icons/${name}.svg`)];
  try {
    run('tar', ['-xzf', tarball, ...wanted]);
  } catch {
    const missing = config.icons.filter((name) => {
      try {
        run('tar', ['-xzf', tarball, `package/icons/${name}.svg`]);
        return false;
      } catch {
        return true;
      }
    });
    throw new Error(`Lucide ${config.version} nie ma ikon: ${missing.join(', ')} (nazwy z https://lucide.dev/icons)`);
  }
  const license = fs.readFileSync(path.join(tmp, 'package', 'LICENSE'), 'utf8').replace(/-{2,}/g, '_').trim();
  const symbols = config.icons.map((name) => {
    const svg = fs.readFileSync(path.join(tmp, 'package', 'icons', `${name}.svg`), 'utf8');
    const body = svg
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^[\s\S]*?<svg[^>]*>/, '')
      .replace(/<\/svg>\s*$/, '')
      .replace(/\s*\n\s*/g, '')
      .trim();
    return `<symbol id="${name}" viewBox="0 0 24 24">${body}</symbol>`;
  });
  const out = [
    `<!-- Ikony Lucide ${config.version} (https://lucide.dev). Plik generuje scripts/icons.mjs, nie edytuj ręcznie.`,
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
  console.log(`icons.svg: ${config.icons.length} ikon, ${Math.round(out.length / 1024)} KB`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
