// Pauzy (U+2014) i półpauzy (U+2013) zamieniamy na zwykły myślnik „-” we wszystkim, co bot wysyła na Discorda
// (wiadomości, edycje, odpowiedzi na komendy, tickety, Serwer info) i w ustawieniach (odczyt i zapis z panelu).
// Prośba właściciela serwera: nigdzie długich myślników.
const DASHES = /[\u2013\u2014]/g;

export function plainDashes(value) {
  if (typeof value === 'string') return DASHES.test(value) ? value.replace(DASHES, '-') : value;
  if (Array.isArray(value)) return value.map(plainDashes);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = plainDashes(v);
    return out;
  }
  return value;
}
