'use strict';

/**
 * 营养数据模块
 *
 * 背景（踩过的坑，写下来免得下次又踩）：
 * McDonald's MCP 的 list-nutrition-foods 返回的是一张「菜名 → 营养」的表，
 * 只有名字，**没有任何商品编码**。而 query-meals 返回的菜单只有编码+名字。
 * 所以「按热量筛选」这件事，卡在了名称匹配上，而不是在营养数据本身。
 *
 * 更烦的是两边的名字对不上：
 *   菜单里叫「薯条」            → 营养表里叫「中薯条 / 大薯条 / 小薯条 / 脆脆薯条」
 *   菜单里叫「麦乐鸡」          → 营养表里叫「麦乐鸡4块 / 麦乐鸡5块」
 *   菜单里叫「圆筒冰淇淋」      → 营养表里同名，这个能对上
 *
 * 所以这里做的事是：把匹配策略、默认规格、歧义处理，全部写成确定性的纯函数。
 * 匹配不上就老实返回 missing，绝不给一个瞎猜的热量。
 */

/** 营养表字段顺序（MCP 返回的原始 TSV 就是这个顺序，别改） */
const NUTRITION_FIELDS = [
  'productName',
  'nutritionDescription',
  'energyKj',
  'energyKcal',
  'protein',
  'fat',
  'carbohydrate',
  'sodium',
  'calcium',
];

/**
 * 规格优先级。麦当劳默认规格是「中」，这是被 calculate-price 实测证实过的：
 * 传 productCode=4810（菜单名「薯条」）进去，返回的商品名是「中薯条」。
 * 所以当营养表里出现 中/大/小 三个候选时，默认取「中」，但必须标记为中等置信度，
 * 让上层如实告诉用户「我按中薯条算的」。
 */
const SIZE_PREFERENCE = ['中', '标准', '常规'];

/**
 * 明确的别名表：左 = 菜单里的名字关键词，右 = 营养表里的完整名。
 *
 * 放什么、不放什么，有条界线：
 *   放 —— 名字真的不一样（菜单「纯牛奶」vs 营养表「纯牛奶（盒装）」，「苹果汁」vs「100%苹果汁」）
 *   不放 —— 只是规格没写全的（「薯条」vs「中薯条」）
 *
 * 第二种情况交给下面的 default-size 逻辑处理，因为它是**推断**，得标成中等置信度；
 * 混进这张表里会被当成高置信度的确定答案，反而更容易骗到用户。
 */
const ALIAS = {
  // 美式咖啡：冰/热只差 1 大卡，这种量级下给个默认值没有风险
  冰美式: '冰美式中杯',
  热美式: '热美式中杯',
  美式: '热美式中杯',
  // 奶铁系列：燕麦奶和牛奶的热量差得多，所以两张都要列，不能合并
  奶铁: '热奶铁中杯',
  燕麦奶铁: '热燕麦奶铁中杯',
  纯牛奶: '纯牛奶（盒装）',
  苹果汁: '100%苹果汁',
  豆浆: '优品豆浆小杯',
};

/**
 * 别名查找。先找完全命中的键，再退一步找「被包含」的键（长键优先）。
 *
 * 为什么要退一步：菜单上写「麦咖啡™奶铁」，别名表里只有「奶铁」这个键。
 * 长键优先是为了别把「燕麦奶铁」错当成「奶铁」—— 前者是燕麦奶做的，热量差一截。
 *
 * 但「被包含」匹配出来的结果属于推断，置信度给 medium，不能跟完全命中一个待遇。
 */
function lookupAlias(name) {
  const target = normalizeName(name);
  if (ALIAS[name]) return { value: ALIAS[name], exact: true };
  if (ALIAS[target]) return { value: ALIAS[target], exact: true };

  const keys = Object.keys(ALIAS)
    .filter((k) => target.includes(normalizeName(k)))
    .sort((a, b) => b.length - a.length);
  if (keys.length) return { value: ALIAS[keys[0]], exact: false, matchedKey: keys[0] };
  return null;
}

/**
 * 把名字归一化，用来做「差不多一样」的判断。
 * 只做安全的变形：大小写、全角半角、空格、常见标点。
 * 括号**保留内容**，因为「纯牛奶（盒装）」和「纯牛奶（杯装）」是两种东西。
 */
function normalizeName(input) {
  if (input === null || input === undefined) return '';
  let s = String(input);
  // 全角 → 半角
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/\u3000/g, ' ');
  // 统一括号样式
  s = s.replace(/[（【〔「『]/g, '(').replace(/[）】〕」』]/g, ')');
  // 去掉商标符号与引号、装饰性字符（菜单里有「麦咖啡™奶铁」这种写法）
  s = s.replace(/["'`“”‘’·・™®©]/g, '');
  // 去掉所有空白
  s = s.replace(/\s+/g, '');
  return s.toLowerCase();
}

/**
 * 解析 list-nutrition-foods 的返回。
 *
 * MCP 返回的 data 是一段「TSV 被压平进一个字符串」的文本，形如：
 *   [160]{productName,nutritionDescription,energyKj,...}:
 *     猪柳麦满分,null,1288,308,16,16,24,781,213
 *     ...
 * 第二行是表头，后面每行一条。
 *
 * 也兼容「已经是数组/对象」的情况，方便测试直接喂结构化数据。
 */
function parseNutrition(raw) {
  if (Array.isArray(raw)) return raw.map(coerceRow).filter(Boolean);
  if (raw && typeof raw === 'object' && Array.isArray(raw.data)) {
    return raw.data.map(coerceRow).filter(Boolean);
  }

  const text = typeof raw === 'object' && raw !== null ? String(raw.data ?? '') : String(raw ?? '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const rows = [];
  for (const line of lines) {
    // 跳过 `[160]{...}:` 这种表头行
    if (/^\[\d+\]/.test(line) || line.startsWith('{')) continue;
    const cols = line.split(',');
    if (cols.length < 5) continue;
    const row = {};
    NUTRITION_FIELDS.forEach((field, i) => {
      row[field] = cols[i] === undefined ? null : cols[i];
    });
    const coerced = coerceRow(row);
    if (coerced) rows.push(coerced);
  }
  return rows;
}

function coerceRow(row) {
  if (!row || !row.productName) return null;
  const num = (v) => {
    if (v === null || v === undefined || v === '' || v === 'null') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    name: String(row.productName).trim(),
    // 注意：MCP 原文拼写就是 energyKcal / protein，别自作聪明改字段名
    kcal: num(row.energyKcal),
    kj: num(row.energyKj),
    protein: num(row.protein),
    fat: num(row.fat),
    carb: num(row.carbohydrate),
    sodium: num(row.sodium),
    calcium: num(row.calcium),
    description: row.nutritionDescription === 'null' ? null : row.nutritionDescription || null,
  };
}

/**
 * 去掉规格前缀/后缀，拿到「基础名」，用来判断歧义组。
 *
 * 规格词的写法在营养表里有两套，都得处理：
 *   薯条类 —— 「中薯条 / 大薯条 / 小薯条 / 迷你薯条」（前缀，不带「杯」字）
 *   饮品类 —— 「可乐中杯 / 可乐大杯 / 可乐小杯」（后缀，带「杯」字）
 * 顺序上把长词放前面，否则「中杯」会被「中」先吃掉，剩下个「杯」。
 */
const SIZE_PREFIX = /^(超大杯|中杯|大杯|小杯|迷你|超大|中|大|小)/;
const SIZE_SUFFIX = /(超大杯|中杯|大杯|小杯|超大|中|大|小)$/;

function baseName(name) {
  const n = normalizeName(name);
  return n.replace(SIZE_PREFIX, '').replace(SIZE_SUFFIX, '');
}

/**
 * 在营养表里找一条菜名对应的营养数据。
 *
 * 返回结构是刻意设计成「有话直说」的：
 *   { status: 'ok',        entry, strategy, confidence }
 *   { status: 'ambiguous', candidates, reason }   // 有多个都能对上，且没有安全默认值
 *   { status: 'missing',   reason }               // 完全找不到
 *
 * 上层拿到 ambiguous / missing 就必须如实告诉用户「这个菜我没查到营养数据」，
 * 而不是塞一个看似合理的数字。
 */
function matchNutrition(mealName, table) {
  const target = normalizeName(mealName);
  if (!target) return { status: 'missing', reason: '菜名为空' };

  // 1) 完全一致
  const exact = table.filter((r) => normalizeName(r.name) === target);
  if (exact.length === 1) {
    return { status: 'ok', entry: exact[0], strategy: 'exact', confidence: 'high' };
  }
  if (exact.length > 1) {
    return { status: 'ambiguous', candidates: exact, reason: '营养表里有重名条目' };
  }

  // 2) 别名表
  const aliasHit = lookupAlias(mealName);
  if (aliasHit) {
    const found = table.find((r) => normalizeName(r.name) === normalizeName(aliasHit.value));
    if (found) {
      return {
        status: 'ok',
        entry: found,
        strategy: aliasHit.exact ? 'alias' : 'alias-fuzzy',
        confidence: aliasHit.exact ? 'high' : 'medium',
        note: aliasHit.exact
          ? undefined
          : `菜单上叫「${mealName}」，营养表里只有「${found.name}」，按「${aliasHit.matchedKey}」这条别名对上的`,
      };
    }
  }

  // 3) 基础名一致（把规格词去掉后能对上）
  const base = baseName(mealName);
  const sameBase = table.filter((r) => baseName(r.name) === base);
  if (sameBase.length === 1) {
    return { status: 'ok', entry: sameBase[0], strategy: 'base-name', confidence: 'high' };
  }
  if (sameBase.length > 1) {
    // 多个规格：优先取默认「中」规格
    const preferred = sameBase.find((r) => SIZE_PREFERENCE.some((p) => normalizeName(r.name).includes(p)));
    if (preferred) {
      return {
        status: 'ok',
        entry: preferred,
        strategy: 'default-size',
        confidence: 'medium',
        note: `营养表有 ${sameBase.length} 个规格，按默认规格「${preferred.name}」计算`,
      };
    }
    // 比如「麦乐鸡」对应 4块/5块，没有「中」这种默认值，不能替用户决定
    return {
      status: 'ambiguous',
      candidates: sameBase,
      reason: `营养表里有多个规格（${sameBase.map((r) => r.name).join(' / ')}），无法确定是哪一种`,
    };
  }

  // 4) 包含关系：菜单名是营养名的子串，或反过来
  //
  // 这里有个刻意的保守设定：**只要有多个候选就对不上，就报歧义，不挑最像的那个。**
  // 因为「麦乐鸡」在营养表里对到 4 块和 5 块两版，热量差 40 大卡，
  // 替用户挑一个，等于给他一个错的数字。需求文档第一条就是「不能猜」。
  const contains = table.filter((r) => {
    const n = normalizeName(r.name);
    return n.includes(target) || target.includes(n);
  });
  if (contains.length === 1) {
    return {
      status: 'ok',
      entry: contains[0],
      strategy: 'contains',
      confidence: 'medium',
      note: `按包含关系对到「${contains[0].name}」`,
    };
  }
  if (contains.length > 1) {
    return {
      status: 'ambiguous',
      candidates: contains,
      reason: `有 ${contains.length} 个候选（${contains
        .slice(0, 4)
        .map((r) => r.name)
        .join(' / ')}${contains.length > 4 ? ' 等' : ''}），说不准是哪一个`,
    };
  }

  return { status: 'missing', reason: '营养表里找不到对应餐品' };
}

/** 一次匹配多个菜名，返回一一对应的结果（顺序保持不变） */
function matchAll(meals, table) {
  return meals.map((m) => {
    const name = typeof m === 'string' ? m : m.name;
    return { meal: m, name, ...matchNutrition(name, table) };
  });
}

module.exports = {
  NUTRITION_FIELDS,
  SIZE_PREFERENCE,
  ALIAS,
  normalizeName,
  baseName,
  lookupAlias,
  parseNutrition,
  matchNutrition,
  matchAll,
};
