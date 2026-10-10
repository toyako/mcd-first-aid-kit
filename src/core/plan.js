'use strict';

const nutrition = require('./nutrition');

/**
 * 组合规划模块 —— 「中午吃什么」这一场景的算力所在。
 *
 * 设计上有一条硬约束，值得单独说清楚：
 *
 *   **价格不由本地代码算，一律走 MCP 的 calculate-price。**
 *
 * 本地只负责「哪些商品值得放进购物车」，价格、优惠、运费全交给麦当劳自己算。
 * 理由很实在：麦当劳的券规则、麦金卡、随单购、特调加价，本地复刻一遍必然算错，
 * 而且一旦算错，用户在下单页看到的数字跟我们对不上，信任直接归零。
 *
 * 另一个取舍：只输出「营养数据能查全」的组合。
 * 因为「减脂」这个需求，靠的就是热量数；一个查不到热量的套餐，推荐了等于没说。
 * 宁可给 2 个准的，不给 10 个含糊的。（需求文档：最多给 3 个方案，别啰嗦）
 */

/** 分类：优先用菜单自带分类名，兜底用关键词 */
const CATEGORY_RULES = [
  { type: 'drink', keywords: ['饮品', '麦咖啡'] },
  { type: 'dessert', keywords: ['小食甜品', '冰淇淋'] },
  { type: 'main', keywords: ['汉堡', '牛鱼肉堡', '厚牛堡', '鸡肉汉堡', '大堡口福'] },
];

const NAME_RULES = [
  {
    type: 'drink',
    keywords: ['可乐', '雪碧', '美式', '拿铁', '奶铁', '牛奶', '红茶', '果汁', '豆浆', '橙', '柠檬', '咖啡', '怡泉', '酸奶', '奶茶', '水'],
  },
  { type: 'dessert', keywords: ['冰淇淋', '圆筒', '新地', '麦旋风', '派', '阿芙佳朵', '拉明顿'] },
  // 汉堡类不一定带「堡」字，麦当劳的招牌就叫「巨无霸」，得单独列出来
  { type: 'main', keywords: ['堡', '卷', '麦满分', '巨无霸', '不素之霸', '麦香鸡', '麦香鱼'] },
  { type: 'side', keywords: ['薯条', '薯饼', '玉米杯', '苹果片', '麦乐鸡', '鸡块', '鸡翅', '鸡排', '鸡柳', '鸡球', '鸡', '油条', '香肠'] },
];

/**
 * 「炸的」判定。需求原文是「别给我推荐炸的」，所以这里要能识别出来并**说明白拒了谁**。
 * 刻意没有把「麦香鱼」「巨无霸」算进来 —— 它们的蛋白质不错，
 * 把牛肉饼和板烧鸡腿一刀切掉，减脂的人就没得吃了。宁窄勿宽。
 */
const FRIED_KEYWORDS = [
  '炸',
  '脆汁鸡',
  '麦辣鸡翅',
  '麦辣鸡腿汉堡',
  '鸡翅',
  '鸡排',
  '鸡柳',
  '鸡块',
  '鸡球',
  '蘸酱',
  '薯条',
  '薯饼',
  '油条',
  '双翅',
  '薄皮脆',
  '那么大鸡排',
];

/**
 * 分类：**先看名字，再看分类**。
 *
 * 顺序不能反。实测踩过：`query-meals` 把薯条归在「小食甜品/其他」这一栏，
 * 如果先看分类，薯条会被当成甜品，套餐里就会出现「汉堡 + 薯条 + 冰淇淋」这种
 * 三样甜品凑一块的怪组合。名字里的信息比分类桶更准。
 * 名字认不出来时，才退回用分类兜底。
 */
function classifyMeal(mealName, categoryName) {
  const name = mealName || '';
  for (const rule of NAME_RULES) {
    if (rule.keywords.some((k) => name.includes(k))) return rule.type;
  }
  const cat = categoryName || '';
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((k) => cat.includes(k))) return rule.type;
  }
  return 'other';
}

/**
 * 把 query-meals 的返回压平成一条条商品。
 * 菜单结构是 categories[].meals[]{code,tags} + meals{code:{name,currentPrice,...}}，
 * 分类信息和商品详情是分开的两块，这里合到一起。
 */
function flattenMenu(raw) {
  const data = raw && raw.data ? raw.data : raw || {};
  const categories = Array.isArray(data.categories) ? data.categories : [];
  const details = data.meals && typeof data.meals === 'object' ? data.meals : {};

  const items = [];
  const seen = new Set();

  for (const cat of categories) {
    for (const m of cat.meals || []) {
      const code = String(m.code);
      const d = details[code];
      if (!d) continue;
      if (seen.has(code)) {
        // 同一商品可能出现在多个分类里，合并分类标签，不重复成两条
        const existed = items.find((i) => i.code === code);
        if (existed && !existed.categories.includes(cat.name)) existed.categories.push(cat.name);
        continue;
      }
      seen.add(code);
      items.push({
        code,
        name: d.name ?? '(未命名)',
        price: d.currentPrice !== undefined && d.currentPrice !== null && d.currentPrice !== '' ? Number(d.currentPrice) : null,
        originalPrice: d.originalPrice !== undefined && d.originalPrice !== null && d.originalPrice !== '' ? Number(d.originalPrice) : null,
        tags: Array.isArray(m.tags) ? m.tags : [],
        categories: [cat.name],
        discountType: d.discountType ?? null,
        canWithOrder: !!d.canWithOrder,
        image: d.image ?? null,
        type: classifyMeal(d.name, cat.name),
      });
    }
  }
  return items;
}

function isFried(item) {
  const haystack = `${item.name} ${(item.tags || []).join(' ')}`;
  return FRIED_KEYWORDS.some((k) => haystack.includes(k));
}

/**
 * 按条件筛商品。
 *
 * 返回里 `rejected` 是有意保留的 —— 需求文档第 4 条要求「遇到了不合适要直接告诉用户」，
 * 所以「因为炸被拒了 3 个」「因为查不到热量被拒了 5 个」这些都要能说出口。
 */
function filterCandidates(items, nutritionTable, filters = {}) {
  const {
    maxPrice = Infinity,
    maxKcal = Infinity,
    minProtein = 0,
    excludeFried = false,
    excludeKeywords = [],
    types = null,
    requireNutrition = true,
  } = filters;

  const passed = [];
  const rejected = [];

  for (const item of items) {
    const reject = (reason, detail) => rejected.push({ item, reason, detail });

    if (types && !types.includes(item.type)) {
      reject('type', `不属于本次要找的类型（${item.type}）`);
      continue;
    }
    if (excludeFried && isFried(item)) {
      reject('fried', '是油炸类，按你的要求排除了');
      continue;
    }
    if (excludeKeywords.some((k) => item.name.includes(k))) {
      reject('keyword', '命中你要排除的关键词');
      continue;
    }
    if (item.price !== null && item.price > maxPrice) {
      reject('price', `单价 ${item.price} 元，超预算`);
      continue;
    }

    const match = nutritionTable ? nutrition.matchNutrition(item.name, nutritionTable) : null;

    if (!match || match.status !== 'ok') {
      if (requireNutrition) {
        reject(
          'nutrition',
          match && match.status === 'ambiguous' ? `营养数据有歧义：${match.reason}` : '查不到营养数据'
        );
        continue;
      }
      passed.push({ ...item, nutrition: null, nutritionMatch: match });
      continue;
    }

    const n = match.entry;
    if (n.kcal !== null && n.kcal > maxKcal) {
      reject('kcal', `单份 ${n.kcal} 大卡，超热量上限`);
      continue;
    }
    if (n.protein !== null && n.protein < minProtein) {
      reject('protein', `蛋白质只有 ${n.protein}g，不达标`);
      continue;
    }

    passed.push({
      ...item,
      nutrition: n,
      nutritionMatch: { strategy: match.strategy, confidence: match.confidence, note: match.note },
    });
  }

  return { passed, rejected };
}

/**
 * 组装候选组合。
 *
 * 结构是「1 个主食 + 最多 1 个小食 + 最多 1 个饮品」。
 * 不做全排列 —— 一是没意义，二是 MCP 每分钟只给 600 次请求，
 * 每个组合都要打一次 calculate-price，排列爆炸会直接把配额烧光。
 * 这里用「主食按蛋白质性价比排序 + 侧品按热量排序」的贪心法裁剪，
 * 硬上限 maxCombos（默认 8），保证一次问餐最多花 8 次价格调用。
 */
function buildCombos(candidates, options = {}) {
  const { maxCombos = 8, kcalBudget = Infinity, proteinFloor = 0, allowSide = true, allowDrink = true } = options;

  const mains = candidates.filter((c) => c.type === 'main');
  const sides = candidates.filter((c) => c.type === 'side' || c.type === 'dessert');
  const drinks = candidates.filter((c) => c.type === 'drink');

  const proteinPerYuan = (c) => (c.price && c.nutrition?.protein ? c.nutrition.protein / c.price : 0);
  const sortedMains = mains.slice().sort((a, b) => proteinPerYuan(b) - proteinPerYuan(a));
  const sortedSides = sides.slice().sort((a, b) => (a.nutrition?.kcal ?? 9999) - (b.nutrition?.kcal ?? 9999));
  const sortedDrinks = drinks.slice().sort((a, b) => (a.nutrition?.kcal ?? 9999) - (b.nutrition?.kcal ?? 9999));

  const combos = [];
  const pushCombo = (items, label) => {
    const kcal = items.reduce((sum, i) => sum + (i.nutrition?.kcal ?? 0), 0);
    const protein = items.reduce((sum, i) => sum + (i.nutrition?.protein ?? 0), 0);
    const estPrice = items.reduce((sum, i) => sum + (i.price ?? 0), 0);
    if (kcal > kcalBudget) return;
    if (protein < proteinFloor) return;
    const key = items.map((i) => i.code).sort().join('+');
    if (combos.some((c) => c.key === key)) return;
    combos.push({ key, label, items, estKcal: kcal, estProtein: protein, estPrice });
  };

  // 1) 主食单独一份 —— 减脂场景最常用，热量最小
  for (const main of sortedMains.slice(0, 4)) {
    pushCombo([main], `${main.name}（单份）`);
  }

  // 2) 主食 + 饮品 —— 比配薯条划算得多
  if (allowDrink) {
    for (const main of sortedMains.slice(0, 3)) {
      for (const drink of sortedDrinks.slice(0, 2)) {
        pushCombo([main, drink], `${main.name} + ${drink.name}`);
      }
    }
  }

  // 3) 主食 + 小食 + 饮品 —— 想吃全一点的时候
  if (allowSide && allowDrink) {
    for (const main of sortedMains.slice(0, 2)) {
      for (const side of sortedSides.slice(0, 2)) {
        for (const drink of sortedDrinks.slice(0, 1)) {
          pushCombo([main, side, drink], `${main.name} + ${side.name} + ${drink.name}`);
        }
      }
    }
  }

  // 4) 没主食可选时，退化成「小食 + 饮品」，别返回空让用户干等
  if (combos.length === 0) {
    for (const side of sortedSides.slice(0, 3)) {
      pushCombo([side], `${side.name}（单份）`);
      if (allowDrink) {
        const drink = sortedDrinks[0];
        if (drink) pushCombo([side, drink], `${side.name} + ${drink.name}`);
      }
    }
  }

  // 按预估热量升序 —— 减脂场景默认就是这个排序
  combos.sort((a, b) => a.estKcal - b.estKcal);
  return combos.slice(0, maxCombos);
}

/**
 * 给 calculate-price 的返回打个分，方便排序。
 * 这里的价格是「分」，MCP 原文就是分，除以 100 才是元。
 */
function scoreQuote(quote, expected) {
  const d = quote && quote.data ? quote.data : quote || {};
  const priceYuan = d.price !== undefined && d.price !== null ? d.price / 100 : null;
  const originalYuan = d.originalPrice !== undefined && d.originalPrice !== null ? d.originalPrice / 100 : null;
  const discountYuan = d.discount !== undefined && d.discount !== null ? d.discount / 100 : null;

  const kcal = expected?.estKcal ?? null;
  const protein = expected?.estProtein ?? null;

  return {
    priceYuan,
    originalYuan,
    discountYuan,
    savedYuan: originalYuan !== null && priceYuan !== null ? Math.round((originalYuan - priceYuan) * 100) / 100 : null,
    kcal,
    protein,
    // 花同样的钱能吃到多少克蛋白质，减脂期最该看的指标
    proteinPerYuan: priceYuan && protein !== null ? Math.round((protein / priceYuan) * 100) / 100 : null,
    kcalPerYuan: priceYuan && kcal !== null ? Math.round((kcal / priceYuan) * 100) / 100 : null,
  };
}

/**
 * 从已报价的组合里挑最终方案。
 *
 * 排序权重，按重要性排：
 *   1. 带券的优先 —— 券是限期资源，过期就没了。一个能用掉快过期券的方案，
 *      对用户的价值比「蛋白质性价比高 0.05」大得多，不该被挤掉。
 *      （这些方案本身已经通过了全部筛选条件，所以不用担心券把烂菜塞进来。）
 *   2. 蛋白质性价比 —— 花同样的钱吃到多少克蛋白质，减脂期最该看的指标。
 *   3. 热量低的优先。
 *   4. 最后比价格。
 *
 * 同一主食只保留一个方案 —— 免得三条建议说的是同一件事（需求：别啰嗦）。
 */
function pickTopPlans(scoredPlans, limit = 3) {
  const sorted = scoredPlans.slice().sort((a, b) => {
    const ca = a.coupon ? 1 : 0;
    const cb = b.coupon ? 1 : 0;
    if (ca !== cb) return cb - ca;

    const pa = a.score.proteinPerYuan ?? 0;
    const pb = b.score.proteinPerYuan ?? 0;
    if (Math.abs(pa - pb) > 0.05) return pb - pa;
    const ka = a.score.kcal ?? 9999;
    const kb = b.score.kcal ?? 9999;
    if (ka !== kb) return ka - kb;
    return (a.score.priceYuan ?? 9999) - (b.score.priceYuan ?? 9999);
  });

  const usedMain = new Set();
  const out = [];
  for (const plan of sorted) {
    const mainCode = (plan.combo.items.find((i) => i.type === 'main') || plan.combo.items[0]).code;
    if (usedMain.has(mainCode)) continue;
    usedMain.add(mainCode);
    out.push(plan);
    if (out.length >= limit) break;
  }
  // 去重后不够数，就补回来，别让用户少看方案
  if (out.length < limit) {
    for (const plan of sorted) {
      if (out.includes(plan)) continue;
      out.push(plan);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** 生成一行话的方案描述 —— 需求要求「每个方案一行字说清楚：吃什么、多少钱、用哪张券、多少卡」 */
function formatPlanLine(plan, couponTitle) {
  const { combo, score } = plan;
  const parts = [];
  parts.push(combo.label);
  parts.push(score.priceYuan !== null ? `${score.priceYuan} 元` : '价格待拼单确认');
  parts.push(couponTitle ? `用「${couponTitle}」` : '没用券');
  parts.push(score.kcal !== null ? `约 ${score.kcal} 大卡` : '热量未知');
  if (score.savedYuan) parts.push(`省 ${score.savedYuan} 元`);
  return parts.join(' · ');
}

module.exports = {
  CATEGORY_RULES,
  NAME_RULES,
  FRIED_KEYWORDS,
  classifyMeal,
  flattenMenu,
  isFried,
  filterCandidates,
  buildCombos,
  scoreQuote,
  pickTopPlans,
  formatPlanLine,
};
