// Ochrona logowania do panelu przed zgadywaniem hasła. Nieudane próby (hasło panelu i login z /login — nie
// tokeny sesji) liczymy na adres IP; po LIMIT błędach w WINDOW_MIN minut adres jest blokowany na LOCK_MIN minut
// (także dla poprawnego hasła), a moderacja dostaje alert. Adres zapisujemy tylko jako skrót.

import { sha256Hex } from './verify.js';
import { sendModLog } from './moderation.js';

export const LOGIN_LIMIT = 10;
export const WINDOW_MIN = 15;
export const LOCK_MIN = 15;

export class RateLimitError extends Error {
  constructor(message, retryAfterSec) {
    super(message);
    this.retryAfter = retryAfterSec;
  }
}

export function clientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  return (forwarded ? forwarded.split(',')[0] : request.headers.get('cf-connecting-ip') ?? request.headers.get('x-real-ip') ?? '').trim() || 'nieznany';
}

export async function clientKey(request) {
  return `ip:${(await sha256Hex(`hopkostki-login:${clientIp(request)}`)).slice(0, 24)}`;
}

const minutesLeft = (until, now) => Math.max(1, Math.ceil((until - now) / 60_000));

// Do alertu: widać tylko ostatnią część adresu („•••.•.•••.42”).
export function maskIp(ip) {
  if (!ip || ip === 'nieznany') return 'nieznany adres';
  const parts = ip.split(/([.:])/);
  const last = parts.pop();
  return parts.map((p) => (/^[.:]$/.test(p) ? p : '•'.repeat(Math.min(p.length, 4)))).join('') + last;
}

// Przed sprawdzeniem hasła: zablokowany adres → RateLimitError. Zwraca wpis (albo null) do loginOk.
export async function guardLogin(bot, key, { now = Date.now() } = {}) {
  const attempt = await bot.store.loginAttempt(key);
  if (attempt?.lockedUntil && attempt.lockedUntil > now) {
    const minutes = minutesLeft(attempt.lockedUntil, now);
    throw new RateLimitError(`Za dużo nieudanych prób logowania. Spróbuj ponownie za ${minutes} min.`, minutes * 60);
  }
  return attempt;
}

export async function loginFailed(bot, key, { kind = 'hasło panelu', ip = null, now = Date.now() } = {}) {
  const result = await bot.store.loginFailed(key, { limit: LOGIN_LIMIT, windowMin: WINDOW_MIN, lockMin: LOCK_MIN });
  if (result.fails === LOGIN_LIMIT && result.lockedUntil) {
    const config = await bot.store.getConfig();
    const masked = maskIp(ip);
    await sendModLog(bot, config, {
      embeds: [
        {
          color: 0xe67e22,
          title: '🔐 Zablokowano logowanie do panelu',
          description: `${LOGIN_LIMIT} nieudanych prób (${kind}) w ${WINDOW_MIN} min z adresu \`${masked}\` — blokada na ${LOCK_MIN} min.\nJeśli to nie Ty, rozważ zmianę hasła panelu.`,
          timestamp: new Date(now).toISOString(),
        },
      ],
    }).catch(() => {});
  }
  return result;
}

// Po udanym logowaniu: czyścimy licznik, jeśli były wcześniej błędy.
export async function loginOk(bot, key, attempt) {
  if (attempt?.fails > 0) await bot.store.loginSucceeded(key);
}
