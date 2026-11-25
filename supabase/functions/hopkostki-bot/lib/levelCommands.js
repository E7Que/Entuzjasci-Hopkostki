// Komendy poziomów (jak w Arcane): /rank — karta poziomu, /ranking — tabela najlepszych (łącznie, w tym
// tygodniu albo miesiącu), /xp — ręczne zmiany XP (Zarządzanie serwerem; w panelu można zostawić /xp i
// resetowanie tylko właścicielowi serwera).

import { P } from './permissions.js';
import * as embeds from './embeds.js';
import { ActionError } from './moderation.js';
import { PANEL_SITE } from './access.js';
import { LEVEL_COLOR, canManageXp, changeXp, levelProgress, monthKey, rankCardEmbed, weekKey } from './levels.js';

const T = { SUB: 1, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6 };
const GUILD_ONLY = { contexts: [0] };
const PAGE = 10;
const pl = (n) => Number(n).toLocaleString('pl-PL');

async function levelsConfig(bot) {
  const { levels } = await bot.store.getConfig();
  if (!levels.enabled) throw new ActionError('Poziomy są wyłączone — administrator może je włączyć w panelu (zakładka Poziomy).');
  return levels;
}

const rank = {
  permission: null,
  defer: 'public',
  data: {
    name: 'rank',
    description: '📈 Karta poziomu — Twoja albo innej osoby',
    ...GUILD_ONLY,
    options: [{ type: T.USER, name: 'uzytkownik', description: '👤 Czyja karta (puste = Twoja)' }],
  },
  async execute(ix, bot) {
    const config = await levelsConfig(bot);
    const user = ix.getUser('uzytkownik') ?? ix.user;
    if (user.bot) throw new ActionError('Boty nie zdobywają poziomów.');
    return ix.edit({ embeds: [await rankCardEmbed(bot, config, user, { self: user.id === ix.user.id })] });
  },
};

const PERIODS = { wszystko: 'łącznie', tydzien: 'w tym tygodniu', miesiac: 'w tym miesiącu' };

const ranking = {
  permission: null,
  defer: 'public',
  data: {
    name: 'ranking',
    description: '🏆 Ranking poziomów — łącznie, w tym tygodniu albo miesiącu',
    ...GUILD_ONLY,
    options: [
      {
        type: T.STRING,
        name: 'okres',
        description: '📅 Za jaki czas',
        choices: Object.entries(PERIODS).map(([value, name]) => ({ name, value })),
      },
      { type: T.INTEGER, name: 'strona', description: '📄 Która strona (po 10 osób)', min_value: 1, max_value: 100 },
    ],
  },
  async execute(ix, bot) {
    const config = await levelsConfig(bot);
    const period = ix.opt('okres') ?? 'wszystko';
    const page = ix.opt('strona') ?? 1;
    let rows;
    if (period === 'wszystko') rows = await bot.store.levelLeaderboard({ limit: PAGE, offset: (page - 1) * PAGE });
    else {
      const top = await bot.store.levelPeriodTop({ period: period === 'tydzien' ? 'week' : 'month', key: period === 'tydzien' ? weekKey() : monthKey(), limit: page * PAGE });
      rows = top.slice((page - 1) * PAGE).map((r, i) => ({ ...r, rank: (page - 1) * PAGE + i + 1 }));
    }
    const lines = rows.map((r) => {
      const xp = period === 'wszystko' ? r.xp : r.periodXp;
      return `**${r.rank}.** <@${r.userId}> — poziom **${levelProgress(r.xp, config.formula).level}** · ${pl(xp)} XP`;
    });
    const link = config.publicLeaderboard ? `\n\n[Pełny ranking](${PANEL_SITE}ranking)` : '';
    return ix.edit({
      embeds: [
        {
          color: config.card.autoColor === false ? embeds.colorInt(config.card.color, LEVEL_COLOR) : LEVEL_COLOR,
          title: `🏆 Ranking poziomów — ${PERIODS[period]}`,
          description: (lines.length ? lines.join('\n') : 'Na tej stronie nikogo jeszcze nie ma.') + link,
          footer: { text: `Strona ${page} • ${embeds.BRAND}` },
        },
      ],
      allowed_mentions: { parse: [] },
    });
  },
};

const user = (description) => ({ type: T.USER, name: 'uzytkownik', description, required: true });
const amount = (description) => ({ type: T.INTEGER, name: 'ilosc', description, required: true, min_value: 0, max_value: 10_000_000 });

const xp = {
  permission: P.MANAGE_GUILD,
  defer: 'ephemeral',
  data: {
    name: 'xp',
    description: '⭐ Zmień XP lub poziom osoby (poziomy)',
    ...GUILD_ONLY,
    options: [
      { type: T.SUB, name: 'dodaj', description: '➕ Dodaj XP', options: [user('👤 Komu'), amount('🔢 Ile XP')] },
      { type: T.SUB, name: 'odejmij', description: '➖ Odejmij XP', options: [user('👤 Komu'), amount('🔢 Ile XP')] },
      { type: T.SUB, name: 'ustaw', description: '✏️ Ustaw łączne XP', options: [user('👤 Komu'), amount('🔢 Ile XP łącznie')] },
      {
        type: T.SUB,
        name: 'poziom',
        description: '🎚️ Ustaw poziom (XP = próg tego poziomu)',
        options: [user('👤 Komu'), { type: T.INTEGER, name: 'poziom', description: '🔢 Który poziom', required: true, min_value: 0, max_value: 1000 }],
      },
      { type: T.SUB, name: 'reset', description: '🗑️ Wyzeruj XP i poziom osoby', options: [user('👤 Komu')] },
      {
        type: T.SUB,
        name: 'reset-wszystkich',
        description: '⚠️ Wyzeruj XP i poziomy wszystkich (ranking od zera)',
        options: [{ type: T.BOOLEAN, name: 'potwierdz', description: '✅ Tak, wyzeruj wszystkich', required: true }],
      },
    ],
  },
  async execute(ix, bot) {
    await levelsConfig(bot);
    const reset = ix.sub === 'reset' || ix.sub === 'reset-wszystkich';
    const member = { ...ix.member, id: ix.user.id };
    if (!(await canManageXp(bot, member, { reset }))) {
      throw new ActionError(reset ? 'Resetowanie XP jest zablokowane — może to zrobić tylko właściciel serwera.' : '/xp jest zablokowane — może jej używać tylko właściciel serwera.');
    }
    if (ix.sub === 'reset-wszystkich') {
      if (ix.opt('potwierdz') !== true) throw new ActionError('Nic nie zmieniono — zaznacz potwierdz: True.');
      const count = await bot.store.resetLevels();
      return ix.edit({ embeds: [embeds.successEmbed(`Wyzerowano XP i poziomy (${count} osób). Statystyki zostały.`)] });
    }
    const target = ix.getUser('uzytkownik');
    if (target.bot) throw new ActionError('Boty nie zdobywają poziomów.');
    const n = ix.opt('ilosc') ?? ix.opt('poziom') ?? 0;
    const modes = { dodaj: ['add', n], odejmij: ['add', -n], ustaw: ['set', n], poziom: ['level', n], reset: ['reset', 0] };
    const [mode, value] = modes[ix.sub];
    const result = await changeXp(bot, target.id, { mode, amount: value, user: target });
    return ix.edit({
      embeds: [embeds.successEmbed(`<@${target.id}>: **${pl(result.xp)} XP**, poziom **${result.level}** (wcześniej ${result.previous}).`)],
      allowed_mentions: { parse: [] },
    });
  },
};

// Prywatność: ukrycie się na publicznej stronie rankingu (na serwerze /rank i /ranking działają jak dotąd).
const prywatnosc = {
  permission: null,
  defer: 'ephemeral',
  data: {
    name: 'prywatnosc',
    description: '🔒 Ukryj się albo pokaż na publicznej stronie rankingu',
    ...GUILD_ONLY,
    options: [
      {
        type: T.STRING,
        name: 'strona-rankingu',
        description: '🌐 Czy pokazywać Twój pseudonim i avatar na stronie rankingu w internecie',
        required: true,
        choices: [
          { name: 'Ukryj mnie', value: 'ukryj' },
          { name: 'Pokaż mnie', value: 'pokaz' },
        ],
      },
    ],
  },
  async execute(ix, bot) {
    const hidden = ix.opt('strona-rankingu') === 'ukryj';
    await bot.store.setLevelHidden(ix.user.id, hidden);
    const site = `${PANEL_SITE}ranking`;
    return ix.edit({
      embeds: [
        embeds.successEmbed(
          hidden
            ? `Ukryto Cię na [stronie rankingu](${site}): zamiast pseudonimu i avatara jest tam „Ukryta osoba”, a Twojego profilu nie da się otworzyć ani wyszukać. Na serwerze (/rank, /ranking) nic się nie zmienia.`
            : `Znów jesteś widoczny(a) na [stronie rankingu](${site}).`,
        ),
      ],
    });
  },
};

export const LEVEL_COMMANDS = [rank, ranking, xp, prywatnosc];
