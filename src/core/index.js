'use strict';

/**
 * 麦麦急救包 · 决策核心
 *
 * 这一层只做一件事：把 MCP 拉回来的原始数据，变成「可以直接说给用户听」的结论。
 *
 * 边界划得很清楚：
 *   上游 —— WorkBuddy 负责调 MCP（查门店、查菜单、查券、算价、下单）
 *   这里 —— 负责筛选、组合、排序、算性价比、把话说人话
 *   下游 —— WorkBuddy 拿着结论去问用户「行不行」，用户点头才下单
 *
 * 所以这个文件里没有一行网络请求。纯粹、可测、可以在没有 Token 的情况下跑通。
 */

const nutritionMod = require('./nutrition');
const couponMod = require('./coupon');
const pointsMod = require('./points');
const planMod = require('./plan');

/**
 * 场景一：中午吃什么。
 *
 * 输入是 MCP 三个工具的原始返回，输出是「最多 3 个待确认方案 + 该说的话」。
 * 注意：这里给出的价格是**预估**（菜单现价相加），真实价格必须再去调 calculate-price。
 * 返回值里 priceIsEstimate=true 就是在提醒上层这件事。
 */
function adviseMeal({ menu, nutrition, coupons = [], filters = {}, now = new Date() }) {
  const items = planMod.flattenMenu(menu);
  const table = nutritionMod.parseNutrition(nutrition);

  const { passed, rejected } = planMod.filterCandidates(items, table, {
    excludeFried: true,
    requireNutrition: true,
    ...filters,
  });

  const combos = planMod.buildCombos(passed, {
    kcalBudget: filters.maxKcal ?? Infinity,
    proteinFloor: filters.minProtein ?? 0,
    maxCombos: filters.maxCombos ?? 8,
  });

  // --- 把券挂到方案上 -------------------------------------------------------
  //
  // 不挂券的方案是不完整的：需求明确要求「每个方案一行字说清楚：吃什么、多少钱、
  // **用哪张券**、大概多少卡」。所以这里反过来，先看手里有什么券能用，
  // 再看这张券能买的那道菜本身合不合条件，合就单独给它一个方案。
  //
  // 为什么会多出方案：券通常限定某道具体的菜（比如「巨无霸三件套立减5元」），
  // 而那道菜未必会自然出现在「按蛋白质性价比排序」的前几名里。
  // 有券能把它拉到划算区间，就得让它有机会露脸。
  const usableCoupons = couponMod.rankCouponsByUrgency(coupons, now).filter((c) => c.status !== 'expired');

  const couponPlans = [];
  for (const c of usableCoupons) {
    if (!c.products || c.products.length === 0) continue; // 通用券没法定位到具体菜，交给下单时校验
    for (const p of c.products) {
      const cand = passed.find(
        (x) => x.code === String(p.productCode) || (p.productName && x.name === p.productName)
      );
      if (!cand) continue; // 券限定的这道菜今天没有，或者不合条件 —— 不硬推
      couponPlans.push({
        key: `coupon:${c.couponId}:${cand.code}`,
        label: cand.name,
        items: [cand],
        estKcal: cand.nutrition?.kcal ?? 0,
        estProtein: cand.nutrition?.protein ?? 0,
        estPrice: cand.price ?? 0,
        coupon: c,
      });
    }
  }

  // 用菜单现价做初筛，真正的价格留给 calculate-price
  const prelim = combos.map((combo) => {
    const score = planMod.scoreQuote({ data: { price: Math.round(combo.estPrice * 100) } }, combo);
    return { combo, score, coupon: null };
  });

  for (const combo of couponPlans) {
    const score = planMod.scoreQuote({ data: { price: Math.round(combo.estPrice * 100) } }, combo);
    prelim.push({ combo, score, coupon: combo.coupon });
  }

  // 同一道菜既有「带券」又有「不带券」的版本时，留带券的那个 —— 一样的菜，更便宜
  const byKey = new Map();
  for (const p of prelim) {
    const itemKey = p.combo.items.map((i) => i.code).sort().join('+');
    const prev = byKey.get(itemKey);
    if (!prev || (!prev.coupon && p.coupon)) byKey.set(itemKey, p);
  }

  const plans = planMod.pickTopPlans([...byKey.values()], filters.maxPlans ?? 3);

  const notes = [];
  if (filters.excludeFried) {
    const fried = rejected.filter((r) => r.reason === 'fried');
    if (fried.length) {
      notes.push(`按你说的，把 ${fried.length} 个油炸的踢掉了（${fried.slice(0, 3).map((r) => r.item.name).join('、')}${fried.length > 3 ? ' 等' : ''}）`);
    }
  }
  const noNutrition = rejected.filter((r) => r.reason === 'nutrition');
  if (noNutrition.length) {
    notes.push(`另外 ${noNutrition.length} 个餐品在麦当劳的营养表里查不到数据，我没敢给你算热量，也一起排除了`);
  }
  const amb = rejected.filter((r) => r.reason === 'nutrition' && String(r.detail).includes('歧义'));
  if (amb.length) {
    notes.push(`有 ${amb.length} 个是营养表里有多个规格对不上（比如麦乐鸡有 4 块/5 块两版），这个得你说了算`);
  }
  if (usableCoupons.length === 0) {
    notes.push('你卡包里没券，所以方案里不会有「用哪张券」这一项');
  }

  return {
    scenario: 'meal',
    plans: plans.map((p) => ({ ...p, priceIsEstimate: true })),
    notes,
    usableCoupons,
    rejectedSummary: rejected.reduce((acc, r) => {
      acc[r.reason] = (acc[r.reason] || 0) + 1;
      return acc;
    }, {}),
  };
}

/**
 * 场景二：券快过期了。
 * 每张券配一句「还能买什么、什么时候用」，这是需求原话。
 */
function adviseCoupons({ coupons = [], now = new Date() }) {
  const ranked = couponMod.rankCouponsByUrgency(coupons, now);
  const expiring = ranked.filter((c) => c.status === 'today' || c.status === 'soon');

  const advice = expiring.map((c) => {
    let action;
    if (c.status === 'expired') {
      action = '已经过期了，别惦记了';
    } else if (c.products.length > 0) {
      const names = c.products.map((p) => p.productName).filter(Boolean).join(' / ');
      action = `能买：${names}`;
    } else {
      action = '没写明限定商品，大概是通用券，下单时才知道能不能用';
    }

    let timing;
    if (c.daysLeft === null) timing = '有效期没读到，下单前你在 APP 里再瞄一眼';
    else if (c.daysLeft === 0) timing = '今天就到期，今天中午就得用';
    else timing = `还剩 ${c.daysLeft} 天，${c.daysLeft <= 2 ? '尽快用' : '这周内安排掉'}`;

    return { ...c, action, timing };
  });

  return {
    scenario: 'coupons',
    expiring: advice,
    total: ranked.length,
    expired: ranked.filter((c) => c.status === 'expired'),
    notes: ranked.length === 0 ? ['卡包里一张券都没有（要么真没有，要么得先去麦麦省领）'] : [],
  };
}

/**
 * 场景三：网上说的隐藏吃法（薯条蘸冰淇淋）。
 *
 * 这个场景的价值不在算数，在于**把「怎么点出来」讲清楚**：
 * 麦当劳没有「薯条蘸冰淇淋」这个商品，得分开点两份，取餐了自己蘸。
 * 顺便把总热量算给用户，让人心里有数 —— 需求原话。
 */
function adviseHiddenCombo({ menu, nutrition, recipe, now = new Date() }) {
  const items = planMod.flattenMenu(menu);
  const table = nutritionMod.parseNutrition(nutrition);

  const resolved = [];
  const missing = [];
  const assumptions = [];

  for (const want of recipe.items) {
    const hit = items.find((i) => i.name.includes(want));
    if (!hit) {
      missing.push(want);
      continue;
    }
    const match = nutritionMod.matchNutrition(hit.name, table);
    resolved.push({
      ...hit,
      nutrition: match.status === 'ok' ? match.entry : null,
      // 营养表里的菜名跟菜单上的不一定一样（菜单「薯条」= 营养表「中薯条」），
      // 对不上或者靠推断对上的，都留个痕，好在下单前跟用户交代清楚
      nutritionNote:
        match.status === 'ok'
          ? match.note
          : `营养数据${match.status === 'ambiguous' ? '有歧义' : '查不到'}`,
    });
    if (match.status === 'ok' && match.note) {
      assumptions.push(`${hit.name} → 按「${match.entry.name}」的营养数据算：${match.note}`);
    }
  }

  const totalPrice = resolved.reduce((s, i) => s + (i.price ?? 0), 0);
  const knownKcal = resolved.filter((i) => i.nutrition);
  const totalKcal = knownKcal.reduce((s, i) => s + (i.nutrition.kcal ?? 0), 0);

  return {
    scenario: 'hidden-combo',
    recipeName: recipe.name,
    items: resolved,
    missing,
    totalPrice: resolved.length ? Math.round(totalPrice * 100) / 100 : null,
    totalKcal: knownKcal.length === resolved.length && resolved.length ? totalKcal : null,
    // 分开点这件事必须说出来，不然用户到店会找不到这个商品
    howToOrder: resolved.length
      ? `麦当劳没有「${recipe.name}」这个商品，得分两次点：${resolved
          .map((i) => `一份${i.name}`)
          .join('、')}，取餐了${recipe.assembly || '自己动手拼'}`
      : null,
    notes: [
      missing.length ? `门店今天没有：${missing.join('、')}，这个吃法今天玩不了` : null,
      knownKcal.length !== resolved.length ? '有餐品查不到营养数据，热量只算了能查到的部分，不是全量' : null,
      ...assumptions,
      recipe.warning || null,
    ].filter(Boolean),
  };
}

/** 场景四：积分快过期了。 */
function advisePoints({ account, mallProducts = [], now = new Date() }) {
  const acc = pointsMod.parseAccount(account);
  const expiring = pointsMod.describeExpiringPoints(acc, now);
  const products = pointsMod.parseMallProducts(mallProducts);
  const { ranked, unavailable } = pointsMod.rankPointsRewards(products, { now });

  const top = ranked.slice(0, 2).map((r) => ({
    ...r,
    ...pointsMod.affordability(r, acc),
  }));

  const notes = [];

  if (acc.available === 0) {
    notes.push('可用积分是 0，现在什么也换不了。想换的话得先点餐攒分（每消费 1 元大约 1 分）');
  } else if (top.length && top.every((t) => t.affordable === false)) {
    notes.push(`手里 ${acc.available} 分，最划算的那几个都还不够，得再攒攒`);
  }
  if (acc.expired > 0) {
    notes.push(`另外你已经有 ${acc.expired} 分过期作废了，这个追不回来了`);
  }
  if (expiring.length === 0 && acc.available > 0) {
    notes.push('近期没有要过期的积分，不用急着花');
  }

  // 这两个限制必须主动交代，不然用户会以为我们没查或者查错了
  notes.push('麦当劳的积分接口只给了「本月 / 下月将过期」这个粒度，查不到精确到哪一天，所以上面写的是月底');

  return {
    scenario: 'points',
    account: acc,
    expiring,
    recommended: top,
    // 换不了 / 比不了的另放一处，理由逐条带着，方便如实说明
    unavailableCount: unavailable.length,
    unavailable: unavailable.slice(0, 5),
    rankedCount: ranked.length,
    notes,
  };
}

module.exports = {
  ...nutritionMod,
  ...couponMod,
  ...pointsMod,
  ...planMod,
  adviseMeal,
  adviseCoupons,
  adviseHiddenCombo,
  advisePoints,
};
