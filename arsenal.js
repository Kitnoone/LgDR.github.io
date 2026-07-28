/* ==================================================================
   ЛЕГЕНДЫ ПОДЗЕМЕЛИЙ · арсенал
   ------------------------------------------------------------------
   Каталог статичен и одинаков для всех игроков. В Firestore хранятся
   только идентификаторы выбранных предметов.
   ================================================================== */
'use strict';

(() => {
  const ARMOR = [
    { id:'robes', name:'Робы', ac:11, rule:'Простые защитные робы. Дополнительных свойств нет.' },
    { id:'synthsuit', name:'Синтекостюм', ac:12, rule:'Проверки Скрытности совершаются с преимуществом.' },
    { id:'chaos-armor', name:'Броня Хаоса', ac:12, rule:'Атаки по возможности совершаются с преимуществом.' },
    { id:'flak', name:'Флак', ac:12, rule:'Стандартная полевая броня. Дополнительных свойств нет.' },
    { id:'carapace', name:'Панцирная броня', ac:14, rule:'Тяжёлая защитная броня. Дополнительных свойств нет.' },
    { id:'servo-armor', name:'Серво-броня', ac:15, extraHands:1, rule:'Даёт одну дополнительную руку. Персонаж может занимать до трёх рук оружием и снаряжением.' },
    { id:'sister-armor', name:'Броня Сестры Битвы', ac:15, allowedArchetypes:['sister'], restriction:'Доступна только Сестре Битвы.', rule:'Освящённая броня ордена. Доступна только Сестре Битвы.' },
    { id:'astartes-power-armor', name:'Силовая броня Астартес', ac:17, allowedArchetypes:['astartes'], restriction:'Требуется полноценный Астартес. Неофиту недоступна.', rule:'Доступна только полноценному Астартес. Неофит не может её носить.' },
    { id:'terminator-armor', name:'Броня Терминатора', ac:19, rule:'Все проверки Ловкости совершаются с помехой. Броня считается имеющей силовое поле.' },
  ];

  const FAMILY_RULES = {
    las: 'Критические провалы атаки этим оружием можно перебросить.',
    stub: 'После выстрела требуется бонусным действием зарядить оружие или дослать следующий патрон.',
    bolter: 'Критическое попадание срабатывает на 19–20. Порог критического урона на кубике снижен на 1.',
    plasma: 'Можно перегреть оружие и удвоить урон. Если на d20 атаки выпало 5 или меньше, стрелок получает 10 урона.',
    melta: 'Стреляет по огнемётному шаблону дальности, но только в одну цель. Для этой атаки броня цели снижается на 2.',
    chain: 'Бросок урона совершается с преимуществом.',
    power: 'Для этой атаки класс брони цели считается равным 12.',
  };

  const WEAPONS = [
    { id:'las-pistol', family:'las', group:'Лазерное', name:'Лазпистолет', damage:'d4', modifier:'dexterity', hands:1 },
    { id:'lasgun', family:'las', group:'Лазерное', name:'Лазган', damage:'d6', modifier:'dexterity', hands:2 },
    { id:'longlas', family:'las', group:'Лазерное', name:'Лонглаз', damage:'d6', modifier:'dexterity', modifierMultiplier:2, hands:2 },

    { id:'stub-revolver', family:'stub', group:'Пулевое', name:'Стаб-револьвер', damage:'d6', modifier:'strength', hands:1 },
    { id:'stub-automatic', family:'stub', group:'Пулевое', name:'Стаб-автоматик', damage:'3d4', hands:1 },
    { id:'autogun', family:'stub', group:'Пулевое', name:'Автоган', damage:'d8', modifier:'dexterity', hands:2 },
    { id:'heavy-stubber', family:'stub', group:'Пулевое', name:'Тяжёлый стаббер', damage:'3d6', hands:2, rule:'Перед стрельбой требуется действие, чтобы развернуть орудие.' },

    { id:'bolt-pistol', family:'bolter', group:'Болтерное', name:'Болт-пистолет', damage:'d8', modifier:'dexterity', hands:1 },
    { id:'bolter', family:'bolter', group:'Болтерное', name:'Болтер', damage:'2d6', modifier:'strength', hands:2 },
    { id:'heavy-bolter', family:'bolter', group:'Болтерное', name:'Тяжёлый болтер', damage:'2d10', modifier:'strength', hands:2, rule:'Перед стрельбой требуется действие, чтобы развернуть орудие.' },

    { id:'plasma-pistol', family:'plasma', group:'Плазменное', name:'Плазма-пистолет', damage:'d10', modifier:'intelligence', hands:1 },
    { id:'plasma-gun', family:'plasma', group:'Плазменное', name:'Плазмаган', damage:'3d6', modifier:'intelligence', hands:2 },

    { id:'meltagun', family:'melta', group:'Мельта', name:'Мельтаган', damage:'2d12', modifier:'dexterity', hands:2 },
    { id:'inferno-pistol', family:'melta', group:'Мельта', name:'Инферно-пистолет', damage:'4d4', modifier:'dexterity', hands:1 },

    { id:'grenade-launcher', group:'Взрывное', name:'Гранатомёт', damage:'Урон гранаты', hands:2, rule:'Позволяет стрелять гранатой по цели, которую персонаж не видит.' },

    { id:'chain-sword', family:'chain', group:'Цепное', name:'Цепной меч', damage:'d8', modifier:'strength', hands:1 },
    { id:'chain-axe', family:'chain', group:'Цепное', name:'Цепной топор', damage:'d10', modifier:'strength', hands:1 },
    { id:'chain-hammer', family:'chain', group:'Цепное', name:'Цепной молот', damage:'d12', modifier:'strength', hands:2 },

    { id:'power-sword', family:'power', group:'Силовое', name:'Силовой меч', damage:'d6', modifier:'dexterity', hands:1 },
    { id:'power-axe', family:'power', group:'Силовое', name:'Силовой топор', damage:'d6', modifier:'strength', hands:1 },
    { id:'power-mace', family:'power', group:'Силовое', name:'Силовая булава', damage:'d8', modifier:'strength', hands:1 },
    { id:'power-hammer', family:'power', group:'Силовое', name:'Силовой молот', damage:'2d10', modifier:'strength', hands:2 },

    { id:'knife', group:'Обычное', name:'Нож', damage:'d4', modifier:'dexterity', hands:1 },
    { id:'improvised', group:'Обычное', name:'Импровизированное оружие', damage:'d4', hands:1, rule:'Любой подходящий предмет может использоваться как импровизированное оружие.' },

    { id:'fanatic-daggers', group:'Оружие Фанатика смерти', name:'Клинки фанатика', damage:'2d4', modifier:'strength', hands:2, allowedArchetypes:['cultist'], restriction:'Доступны только Фанатику смерти.', rule:'Парные ритуальные клинки Фанатика смерти. Занимают обе руки.' },
    { id:'fanatic-crossbow', group:'Оружие Фанатика смерти', name:'Арбалет фанатика', damage:'d4', modifier:'dexterity', hands:1, allowedArchetypes:['cultist'], restriction:'Доступен только Фанатику смерти.', rule:'Ритуальный арбалет Фанатика смерти. Занимает одну руку.' },

    { id:'heretic-claws', group:'Врождённое', name:'Когти Еретика', damage:'2d4', modifier:'dexterity', hands:0, builtIn:true, allowedArchetypes:['heretic'], restriction:'Это врождённое оружие доступно только Еретику.', rule:'Когти являются руками Еретика, не занимают слоты рук и не могут быть сняты.' },
  ];

  const GEAR = [
    { id:'stimm', group:'Расходники', name:'Стимм', hands:0, stackable:true, rule:'Восстанавливает 2d4 + 2 здоровья.' },
    { id:'litany-wrath', group:'Литании', name:'Литания ярости', hands:0, stackable:true, rule:'Удваивает физический урон.' },
    { id:'litany-soul', group:'Литании', name:'Литания души', hands:0, stackable:true, rule:'Удваивает магический урон.' },
    { id:'litany-momentum', group:'Литании', name:'Литания моментума', hands:0, stackable:true, rule:'Позволяет применить ультимейт бесплатно.' },
    { id:'combat-servo-skull', group:'Механизмы', name:'Боевой сервочереп', hands:0, rule:'Считается несущим автоган и может стрелять без владения оружием.' },
    { id:'holy-scripture', group:'Святыни', name:'Святое писание', hands:1, rule:'Снимает страх с персонажа. Занимает одну руку.' },
    { id:'holy-ammo', group:'Расходники', name:'Святые боеприпасы', hands:0, stackable:true, rule:'Один раз за бой позволяют игнорировать любую сопротивляемость урону.' },
    { id:'force-field', group:'Защита', name:'Силовое поле', hands:1, rule:'Реакцией отменяет одну атаку по владельцу. Занимает одну руку.' },
    { id:'shield', group:'Защита', name:'Щит', hands:1, armorBonus:2, rule:'Повышает класс брони на 2. Занимает одну руку.' },
    { id:'loudspeaker', group:'Поддержка', name:'Громкоговоритель', hands:1, rule:'Снижает всей команде стоимость ультимейта на 1, но не ниже 1 монеты. Занимает одну руку.' },
    { id:'omnis-axe', group:'Механизмы', name:'Топор Омниссии', hands:1, rule:'Позволяет взаимодействовать с конструктами и машинами в базовом контакте. Тест Интеллекта СЛ 15 отключает простой конструкт или машину. Занимает одну руку.' },
    { id:'grenade', group:'Расходники', name:'Граната', hands:0, stackable:true, rule:'Наносит 4d6 урона в области шаблона всем, кто не прошёл тест Ловкости СЛ 15. Цель атаки должна быть видна.' },
    { id:'psyker-staff', group:'Психо-снаряжение', name:'Посох псайкера', hands:1, allowedArchetypes:['psyker'], restriction:'Доступен только Псайкеру.', rule:'Действием позволяет копить силы Варпа, снижая сложность всех последующих проверок психосил на 2. Занимает одну руку.' },
    { id:'jump-pack', group:'Перемещение', name:'Прыжковый ранец', hands:0, rule:'Позволяет летать в течение двух ходов. Если в конце второго хода персонаж не приземлился, он падает.' },
    { id:'auspex', group:'Механизмы', name:'Ауспекс', hands:0, rule:'Позволяет атаковать противника в скрытности, даже если персонаж его не видит.' },
  ];

  const DEFAULT_ARMOR = {
    guardsman:'flak',
    heretic:'robes',
    cultist:'synthsuit',
    techpriest:'servo-armor',
    priest:'carapace',
    neophyte:'carapace',
    psyker:'robes',
    sister:'sister-armor',
  };

  const STAT_LABELS = {
    strength:'Сила',
    dexterity:'Ловкость',
    toughness:'Стойкость',
    intelligence:'Интеллект',
    wisdom:'Мудрость',
    charisma:'Харизма',
  };

  const byId = list => Object.fromEntries(list.map(item => [item.id, Object.freeze(item)]));
  const armorById = byId(ARMOR);
  const weaponById = byId(WEAPONS);
  const gearById = byId(GEAR);

  const normalizeName = value => String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
  const aliases = {
    'флак на старте':'flak',
    'панцирный доспех':'carapace',
    'панцирная':'carapace',
    'серво броня':'servo-armor',
    'броня сестры битвы':'sister-armor',
    'синтекостюм':'synthsuit',
    'робы':'robes',
  };

  function findByName(list, value) {
    const key = normalizeName(value);
    if (!key) return null;
    const direct = aliases[key];
    if (direct) return list.find(item => item.id === direct) || null;
    return list.find(item => normalizeName(item.name) === key) || null;
  }

  const FANATIC_WEAPON_IDS = Object.freeze(['fanatic-daggers', 'fanatic-crossbow']);

  function allowed(item, archetype) {
    return !item?.allowedArchetypes || item.allowedArchetypes.includes(archetype);
  }

  /* Фанатик смерти использует только своё культовое оружие. Эта проверка
     вынесена отдельно от allowed(), потому что обычное оружие не имеет
     списка allowedArchetypes и в остальных случаях доступно всем. */
  function weaponAllowed(item, archetype) {
    if (!item || item.builtIn) return false;
    if (!allowed(item, archetype)) return false;
    if (archetype === 'cultist') return FANATIC_WEAPON_IDS.includes(item.id);
    return !FANATIC_WEAPON_IDS.includes(item.id);
  }

  function fullRule(item) {
    if (!item) return '';
    return [item.family ? FAMILY_RULES[item.family] : '', item.rule || ''].filter(Boolean).join(' ');
  }

  function iconFor(item) {
    if (!item || !weaponById[item.id]) return '';
    return `assets/weapons/${item.id}.webp`;
  }

  window.LegendyArsenal = Object.freeze({
    ARMOR:Object.freeze(ARMOR),
    WEAPONS:Object.freeze(WEAPONS),
    GEAR:Object.freeze(GEAR),
    DEFAULT_ARMOR:Object.freeze(DEFAULT_ARMOR),
    STAT_LABELS:Object.freeze(STAT_LABELS),
    FAMILY_RULES:Object.freeze(FAMILY_RULES),
    FANATIC_WEAPON_IDS,
    armorById:Object.freeze(armorById),
    weaponById:Object.freeze(weaponById),
    gearById:Object.freeze(gearById),
    findArmorByName:value => findByName(ARMOR, value),
    findWeaponByName:value => findByName(WEAPONS, value),
    findGearByName:value => findByName(GEAR, value),
    allowed,
    weaponAllowed,
    fullRule,
    iconFor,
  });
})();
