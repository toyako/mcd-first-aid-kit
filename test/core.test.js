'use strict';

/**
 * 自测：把「麦麦急救包」的决策核心跑一遍。
 *
 * 跑法：node --test test/
 *
 * 测试数据分两类，别混：
 *   - 真实抓包（nutrition.txt / menu.json / account.json / mall-products.json）
 *     断言的是「麦当劳真的会返回这么个东西，我的代码真的算对了」
 *   - 构造数据（coupons.sample.json 以及测试里现场造的券）
 *     断言的是「这种边界情况我的代码不会崩、不会瞎给结论」
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../src/core');

const FIXTURES = path.join(__dirname, 'fixtures');
const readText = (f) => fs.readFileSync(path.join(FIXTURES, f), 'utf8');
const readJson = (f) => JSON.parse(readText(f));

const nutritionRaw = readText('nutrition.txt');
const menu = readJson('menu.json');
const account = readJson('account.json');
const mallProducts = readJson('mall-products.json');
const couponsSample = readJson('coupons.sample.json');

/** 固定「现在」，不然测试会随着真实日期漂移 */
const NOW = new Date('2026-10-10T12:00:00');

// ---------------------------------------------------------------------------
// 营养表解析
// ---------------------------------------------------------------------------

test('营养表：能解析出全部条目，字段名按接口原文', () => {
  const rows = core.parseNutrition(nutritionRaw);
  assert.ok(rows.length >= 155, `应该解析出 150+ 条，实际 ${rows.length} 条`);

  const bigMac = rows.find((r) => r.name === '巨无霸');
  assert.ok(bigMac, '应该能找到巨无霸');
  assert.equal(bigMac.kcal, 513);
  assert.equal(bigMac.protein, 27);
  assert.equal(bigMac.fat, 26);
  assert.equal(bigMac.sodium, 961);

  // 表头行不能被当成数据
  assert.ok(!rows.some((r) => r.name.includes('{productName')), '表头行混进数据里了');
});

test('营养表：带描述的条目也能正常解析', () => {
  const rows = core.parseNutrition(nutritionRaw);
  const cheese = rows.find((r) => r.name === '芝士安格斯厚牛堡');
  assert.equal(cheese.kcal, 696);
  assert.equal(cheese.description, '能量约鲈鱼1条');
});

// ---------------------------------------------------------------------------
// 名称匹配 —— 整个项目最容易出错的环节
// ---------------------------------------------------------------------------

test('名称归一化：全角半角、括号、引号都能对齐', () => {
  assert.equal(core.normalizeName('纯牛奶（盒装）'), core.normalizeName('纯牛奶(盒装)'));
  assert.equal(core.normalizeName('１００％ 苹果汁'), core.normalizeName('100%苹果汁'));
  // 方括号统一成圆括号，引号直接抹掉；两边名字都能归一到同一个形态才是重点
  assert.equal(core.normalizeName('【美汁源】“黄金橙橙”'), '(美汁源)黄金橙橙');
  assert.equal(
    core.normalizeName('【美汁源】“黄金橙橙”'),
    core.normalizeName('【美汁源】"黄金橙橙"'),
    '全角引号和半角引号应该归一化到一样'
  );
  // 商标符号要去掉，「麦咖啡™奶铁」和「麦咖啡奶铁」得能对上
  assert.equal(core.normalizeName('麦咖啡™奶铁'), '麦咖啡奶铁');
});

test('名称匹配：同名直接命中', () => {
  const table = core.parseNutrition(nutritionRaw);
  const r = core.matchNutrition('巨无霸', table);
  assert.equal(r.status, 'ok');
  assert.equal(r.strategy, 'exact');
  assert.equal(r.entry.kcal, 513);
});

test('名称匹配：菜单叫「薯条」、营养表叫「中薯条」，走默认规格并标记置信度', () => {
  const table = core.parseNutrition(nutritionRaw);
  const r = core.matchNutrition('薯条', table);
  assert.equal(r.status, 'ok');
  assert.equal(r.entry.name, '中薯条');
  // 这一点被 calculate-price 证实过：传 4810 进去，返回的商品名就是「中薯条」
  assert.equal(r.strategy, 'default-size');
  assert.equal(r.confidence, 'medium', '默认规格属于推断，不能标成 high');
  assert.ok(r.note && r.note.includes('默认规格'), '必须留下说明，方便告诉用户我们按哪个规格算的');
});

test('名称匹配：麦乐鸡有 4 块/5 块两版，必须报歧义而不是替用户选', () => {
  const table = core.parseNutrition(nutritionRaw);
  const r = core.matchNutrition('麦乐鸡', table);
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.candidates.length, 2);
  // 歧义时要把候选都摆出来让用户自己判断，而不是闷声挑一个
  const names = r.candidates.map((c) => c.name).join(' ');
  assert.ok(names.includes('麦乐鸡4块') && names.includes('麦乐鸡5块'), `候选没列全：${names}`);
  assert.ok(!r.entry, '歧义时不能给出一个 entry，给了就等于替用户拍板了');
});

test('名称匹配：查不到就老实说查不到', () => {
  const table = core.parseNutrition(nutritionRaw);
  const r = core.matchNutrition('宇宙无敌超级汉堡', table);
  assert.equal(r.status, 'missing');
});

test('名称匹配：菜单只写「可乐」，营养表分中/大/小杯，按默认中杯算并标记', () => {
  const table = core.parseNutrition(nutritionRaw);
  const r = core.matchNutrition('可乐', table);
  assert.equal(r.status, 'ok');
  assert.equal(r.entry.name, '可乐中杯');
  // 这条很关键：不能标成高置信度，因为我们其实不知道用户买的是哪个杯型
  assert.equal(r.strategy, 'default-size');
  assert.equal(r.confidence, 'medium');
});

test('名称匹配：别名表只收「名字真的不一样」的，不收「规格没写全」的', () => {
  assert.ok(core.ALIAS['纯牛奶'], '菜单「纯牛奶」和营养表「纯牛奶（盒装）」是两种写法，该收');
  assert.ok(core.ALIAS['苹果汁'], '菜单「苹果汁」和营养表「100%苹果汁」也是两种写法');
  assert.equal(core.ALIAS['薯条'], undefined, '薯条只是规格没写全，应该交给 default-size 逻辑，不该混进别名表');
  assert.equal(core.ALIAS['可乐'], undefined, '同理');
});

// ---------------------------------------------------------------------------
// 菜单解析与分类
// ---------------------------------------------------------------------------

test('菜单：分类信息与商品详情能合到一起', () => {
  const items = core.flattenMenu(menu);
  assert.ok(items.length > 40, `应该解析出 40+ 个商品，实际 ${items.length}`);

  const bigMac = items.find((i) => i.code === '1100');
  assert.equal(bigMac.name, '巨无霸');
  assert.equal(bigMac.price, 26.5);

  // 同一个商品出现在多个分类里，不能变成两条
  const codes = items.map((i) => i.code);
  assert.equal(new Set(codes).size, codes.length, '同一个 code 出现了两次');
});

test('菜单：商品能按用途分类', () => {
  const items = core.flattenMenu(menu);
  const typeOf = (code) => items.find((i) => i.code === code).type;

  assert.equal(typeOf('1100'), 'main', '巨无霸是主食');
  assert.equal(typeOf('4810'), 'side', '薯条是小食');
  assert.equal(typeOf('9900008751'), 'drink', '可乐是饮品');
  assert.equal(typeOf('515837'), 'dessert', '圆筒冰淇淋是甜品');
});

test('菜单：油炸判定要能认出来，但不能误伤牛肉饼和板烧', () => {
  assert.equal(core.isFried({ name: '麦辣鸡腿汉堡', tags: [] }), true);
  assert.equal(core.isFried({ name: '薯条', tags: [] }), true);
  assert.equal(core.isFried({ name: '麦辣鸡翅', tags: [] }), true);
  // 这两个刻意不判成油炸，否则减脂的人就没得吃了
  assert.equal(core.isFried({ name: '巨无霸', tags: [] }), false);
  assert.equal(core.isFried({ name: '板烧鸡腿堡', tags: [] }), false);
});

// ---------------------------------------------------------------------------
// 筛选
// ---------------------------------------------------------------------------

test('筛选：减脂 + 40 元以内 + 不要炸的', () => {
  const items = core.flattenMenu(menu);
  const table = core.parseNutrition(nutritionRaw);

  const { passed, rejected } = core.filterCandidates(items, table, {
    maxPrice: 40,
    maxKcal: 600,
    minProtein: 15,
    excludeFried: true,
    requireNutrition: true,
  });

  assert.ok(passed.length > 0, '应该筛出东西来');
  assert.ok(passed.every((p) => p.nutrition.kcal <= 600), '有超热量的漏进来了');
  assert.ok(passed.every((p) => p.nutrition.protein >= 15), '有蛋白质不达标的漏进来了');

  // 被拒的原因要能说清楚，这是需求里「遇到了不合适要直接告诉用户」的基础
  const reasons = new Set(rejected.map((r) => r.reason));
  assert.ok(reasons.has('fried'), '油炸的应该被单独归类');
  assert.ok(reasons.has('nutrition'), '查不到营养的应该被单独归类');
});

test('筛选：单份热量上限卡得死，超标的不能出现', () => {
  const items = core.flattenMenu(menu);
  const table = core.parseNutrition(nutritionRaw);
  const { passed } = core.filterCandidates(items, table, {
    maxPrice: 100,
    maxKcal: 250,
    excludeFried: false,
  });
  for (const p of passed) {
    assert.ok(p.nutrition.kcal <= 250, `${p.name} 是 ${p.nutrition.kcal} 大卡，超了`);
  }
});

// ---------------------------------------------------------------------------
// 组合生成
// ---------------------------------------------------------------------------

test('组合：数量有硬上限，不能把 MCP 请求配额烧光', () => {
  const items = core.flattenMenu(menu);
  const table = core.parseNutrition(nutritionRaw);
  const { passed } = core.filterCandidates(items, table, { maxPrice: 40, excludeFried: true });
  const combos = core.buildCombos(passed, { maxCombos: 8 });

  assert.ok(combos.length <= 8, `最多 8 个组合，实际 ${combos.length}`);
  assert.ok(combos.length > 0, '应该能拼出组合');

  // 每个组合里的商品不能重复
  for (const c of combos) {
    const codes = c.items.map((i) => i.code);
    assert.equal(new Set(codes).size, codes.length, '组合里有重复商品');
  }

  // 热量升序，减脂场景默认就该这么排
  for (let i = 1; i < combos.length; i++) {
    assert.ok(combos[i].estKcal >= combos[i - 1].estKcal, '组合没有按热量升序');
  }
});

test('组合：热量预算会被严格执行', () => {
  const items = core.flattenMenu(menu);
  const table = core.parseNutrition(nutritionRaw);
  const { passed } = core.filterCandidates(items, table, { maxPrice: 60, excludeFried: true });
  const combos = core.buildCombos(passed, { maxCombos: 20, kcalBudget: 500 });
  for (const c of combos) {
    assert.ok(c.estKcal <= 500, `${c.label} 热量 ${c.estKcal}，超预算了`);
  }
});

// ---------------------------------------------------------------------------
// 方案呈现
// ---------------------------------------------------------------------------

test('方案：最多 3 个，且每个只占一行', () => {
  const res = core.adviseMeal({
    menu,
    nutrition: nutritionRaw,
    coupons: core.parseCoupons(couponsSample),
    filters: { maxPrice: 40, maxKcal: 600, minProtein: 15, excludeFried: true },
    now: NOW,
  });

  assert.equal(res.scenario, 'meal');
  assert.ok(res.plans.length <= 3, `最多 3 个方案，实际 ${res.plans.length}`);

  for (const p of res.plans) {
    const line = core.formatPlanLine(p, null);
    assert.ok(!line.includes('\n'), '方案描述不能换行');
    assert.ok(line.length < 120, `一行话太长了：${line}`);
  }
});

test('方案：被排除的东西要写进 notes，不能闷声吞掉', () => {
  const res = core.adviseMeal({
    menu,
    nutrition: nutritionRaw,
    filters: { maxPrice: 40, maxKcal: 600, minProtein: 15, excludeFried: true },
    now: NOW,
  });
  const joined = res.notes.join(' ');
  assert.ok(joined.includes('油炸'), '应该说明排除了多少油炸的');
  assert.ok(joined.includes('营养表'), '应该说明有多少个因为查不到营养被排除');
});

test('方案：没有券的时候不会硬推', () => {
  const res = core.adviseMeal({ menu, nutrition: nutritionRaw, filters: {}, now: NOW });
  assert.equal(res.usableCoupons.length, 0);
  for (const p of res.plans) {
    assert.equal(core.formatPlanLine(p, null).includes('用「'), false);
  }
});

test('方案：券能对上菜时会被挂进方案，方案行里说清用哪张券', () => {
  const coupon = {
    title: '巨无霸立减5元',
    couponId: 'CPN-X',
    couponCode: 'X1',
    expiry: '2026-10-31 23:59:59',
    products: [{ productName: '巨无霸', productCode: '1100' }],
  };

  const res = core.adviseMeal({
    menu,
    nutrition: nutritionRaw,
    coupons: [coupon],
    filters: { maxPrice: 40, excludeFried: true },
    now: NOW,
  });

  const withCoupon = res.plans.find((p) => p.coupon);
  assert.ok(withCoupon, '「巨无霸立减5元」能对上巨无霸，应该有一个方案挂上它');
  assert.equal(withCoupon.combo.items[0].name, '巨无霸');

  const line = core.formatPlanLine(withCoupon, withCoupon.coupon.title);
  assert.ok(line.includes('巨无霸立减5元'), `方案行没说用哪张券：${line}`);
  assert.ok(!line.includes('\n'), '方案还是一行');
});

test('方案：券限定的菜门店没有，就不硬推（需求第 4 条）', () => {
  const coupon = {
    title: '香芋派免费券',
    couponId: 'CPN-Y',
    couponCode: 'Y1',
    expiry: '2026-10-31 23:59:59',
    // 门店菜单里没有「香芋派」这个商品，编码也是假的
    products: [{ productName: '香芋派', productCode: '999999' }],
  };

  const res = core.adviseMeal({ menu, nutrition: nutritionRaw, coupons: [coupon], filters: {}, now: NOW });
  assert.equal(res.plans.some((p) => p.coupon), false, '门店没有的菜，不能靠券把它变出来');
});

test('隐藏吃法：营养表里对到别的规格时，要说清楚按哪种算的', () => {
  const res = core.adviseHiddenCombo({
    menu,
    nutrition: nutritionRaw,
    recipe: { name: '薯条蘸冰淇淋', items: ['薯条', '圆筒冰淇淋'] },
    now: NOW,
  });
  // 菜单写「薯条」，营养表只有「中薯条」，这个推断必须说出来
  assert.ok(
    res.notes.some((n) => n.includes('中薯条')),
    `应该交代按中薯条算的，实际备注：${res.notes.join(' / ')}`
  );
});

// ---------------------------------------------------------------------------
// 场景三：隐藏吃法
// ---------------------------------------------------------------------------

test('隐藏吃法：薯条蘸冰淇淋，价格按菜单现价算，并说明怎么点', () => {
  const res = core.adviseHiddenCombo({
    menu,
    nutrition: nutritionRaw,
    recipe: { name: '薯条蘸冰淇淋', items: ['薯条', '圆筒冰淇淋'], assembly: '拿薯条蘸着吃' },
    now: NOW,
  });

  assert.equal(res.items.length, 2);
  assert.equal(res.totalPrice, 19, '薯条 14 + 圆筒 5 = 19');
  // 中薯条 289 + 圆筒 93 = 382
  assert.equal(res.totalKcal, 382);
  assert.ok(res.howToOrder.includes('两次点'), '必须说清楚是分开点两份');
});

test('隐藏吃法：店里没有的料要直接说没有', () => {
  const res = core.adviseHiddenCombo({
    menu,
    nutrition: nutritionRaw,
    recipe: { name: '薯条蘸宇宙酱', items: ['薯条', '宇宙酱'] },
    now: NOW,
  });
  assert.deepEqual(res.missing, ['宇宙酱']);
  assert.ok(res.notes.some((n) => n.includes('宇宙酱')), '应该明说门店没有');
});

// ---------------------------------------------------------------------------
// 场景二：券
// ---------------------------------------------------------------------------

test('券：有效期字段能解析出多种格式', () => {
  assert.equal(core.parseExpiry('2026-10-20 23:59:59').getFullYear(), 2026);
  assert.equal(core.parseExpiry('2026/10/20').getMonth(), 9);
  assert.equal(core.parseExpiry('2026-10-20~2026-11-05').getMonth(), 10, '区间应取截止那一段');
  assert.equal(core.parseExpiry('2026-10-20 至 2026-11-05').getMonth(), 10, '「至」也是区间分隔符');
  assert.equal(core.parseExpiry(1791639886474).getFullYear(), 2026, '毫秒时间戳也要能认');
  assert.equal(core.parseExpiry(null), null);
});

test('券：半角连字符写的有效期区间，必须取截止那天（实测踩过的坑）', () => {
  // 门店券真实返回长这样，旧实现只认 ~ / ～ / 至，会把这一串当成单一日期，
  // 只取到前半段，于是 10-16 到期的券被误判成"今天到期"
  const range = '2026-10-10 00:00:00-2026-10-16 23:59:59';
  const d = core.parseExpiry(range);

  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9, '月份必须是 10 月');
  assert.equal(d.getDate(), 16, '必须取到 16 号，而不是 10 号');
  assert.equal(d.getHours(), 23);

  // 用固定"现在"验一遍分桶：10-16 到期相对 10-10 应该是 soon（剩 6 天），绝不能是 today
  const c = core.classifyCoupon({ title: '9.9元中杯冰美式', expiry: range }, new Date('2026-10-10T22:40:00'));
  assert.equal(c.daysLeft, 6);
  assert.equal(c.status, 'soon', '这是 6 天后到期，不该被判成今天到期');
});

test('券：有效期本身带连字符的日期不会被区间逻辑误伤', () => {
  const d = core.parseExpiry('2026-10-20');
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 20);
  assert.equal(d.getHours(), 23, '没写时间时默认当天 23:59:59');
});

test('券：临期分桶 —— 过期 / 今天 / 7天内 / 还早', () => {
  const mk = (expiry) => core.classifyCoupon({ title: 't', expiry }, NOW);
  assert.equal(mk('2026-10-06 23:59:59').status, 'expired');
  assert.equal(mk('2026-10-10 23:59:59').status, 'today');
  assert.equal(mk('2026-10-13 23:59:59').status, 'soon');
  assert.equal(mk('2026-11-30 23:59:59').status, 'valid');
  assert.equal(mk(null).status, 'unknown-expiry');
  assert.equal(mk('2026-10-13 23:59:59').daysLeft, 3);
});

test('券：过期的排最前，因为要先告诉用户别惦记了', () => {
  const coupons = core.parseCoupons(couponsSample);
  const ranked = core.rankCouponsByUrgency(coupons, NOW);

  assert.equal(ranked[0].status, 'expired', '过期的应该排第一');
  assert.equal(ranked[0].title, '圆筒冰淇淋买一送一');
  assert.equal(ranked[1].status, 'soon');
});

test('券：7 天内的会被挑出来，每张带一句「还能买什么」', () => {
  const coupons = core.parseCoupons(couponsSample);
  const res = core.adviseCoupons({ coupons, now: NOW });

  assert.equal(res.expiring.length, 1, '只有巨无霸那张是 7 天内到期');
  assert.equal(res.expired.length, 1, '圆筒冰淇淋那张已经过期');

  const soon = res.expiring.find((c) => c.title === '巨无霸三件套立减5元');
  assert.ok(soon.action.includes('巨无霸三件套'), '要说明这张券能买什么');
  assert.ok(soon.timing.includes('3 天'), '要说明还剩几天');
});

test('券：券和餐品对不上时必须直说，不能硬推', () => {
  const coupon = {
    title: '巨无霸专属券',
    couponId: 'X',
    couponCode: 'Y',
    expiry: '2026-10-20 23:59:59',
    products: [{ productName: '巨无霸三件套', productCode: '9900005466' }],
  };

  // 这单里只有薯条和可乐，套不上
  const wrong = core.canCouponApply(coupon, ['4810', '9900008751'], ['薯条', '可乐']);
  assert.equal(wrong.canUse, false);
  assert.ok(wrong.reason.includes('巨无霸三件套'), '要说清楚这张券只认什么');

  // 这单里有巨无霸三件套，套得上
  const right = core.canCouponApply(coupon, ['9900005466'], ['巨无霸三件套']);
  assert.equal(right.canUse, true);
});

test('券：通用券（没写限定商品）不假装知道它能用', () => {
  const universal = { title: '满减券', couponId: 'A', products: [] };
  const r = core.canCouponApply(universal, ['1100'], ['巨无霸']);
  assert.equal(r.canUse, true);
  assert.equal(r.matched, false);
  assert.ok(r.reason.includes('以下单时校验为准'), '通用券要说明最终以下单校验为准');
});

// ---------------------------------------------------------------------------
// 场景四：积分
// ---------------------------------------------------------------------------

test('积分：账户字段按接口原文解析', () => {
  const acc = core.parseAccount(account);
  assert.equal(acc.available, 0);
  assert.equal(acc.accumulative, 4005.6);
  assert.equal(acc.expired, 3704.6);
  assert.equal(acc.thisMonthExpiring, 0);
});

test('积分：过期只能说到月底，不能编一个精确日期', () => {
  const acc = core.parseAccount({
    data: { availablePoint: '1200', currentMouthExpirePoint: '500', nextMouthExpirePoint: '300' },
  });
  const items = core.describeExpiringPoints(acc, NOW);

  assert.equal(items.length, 2);
  assert.equal(items[0].window, '本月');
  assert.equal(items[0].deadline, '2026-10-31', '本月月底');
  assert.equal(items[0].daysLeft, 21);
  assert.equal(items[0].precision, 'month-end');
  assert.equal(items[1].deadline, '2026-11-30', '下月月底');
});

test('积分：商城按真实数据排序，最划算的是 50 分换 6.9 元券', () => {
  const products = core.parseMallProducts(mallProducts);
  const { ranked, unavailable } = core.rankPointsRewards(products, { now: NOW });

  assert.ok(ranked.length > 0);
  // 6.9 / 50 = 0.138 元每分，是这批里最高的
  assert.equal(ranked[0].spuName, '6.9元可乐麦炫酷');
  assert.equal(ranked[0].points, 50);
  assert.equal(ranked[0].faceValueYuan, 6.9);
  assert.ok(Math.abs(ranked[0].valuePerPoint - 0.138) < 1e-9);

  // 排序必须严格递减
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i].valuePerPoint <= ranked[i - 1].valuePerPoint, '性价比没有严格递减');
  }
});

test('积分：早过期的商品即使 status=2 也不能推', () => {
  const products = core.parseMallProducts(mallProducts);
  const { ranked, unavailable } = core.rankPointsRewards(products, { now: NOW });

  // 「18.8元2份麦辣鸡翅」downTime=2026-03-21，但 status 是 2（上架）
  assert.ok(!ranked.some((r) => r.spuName === '18.8元2份麦辣鸡翅'), '过期商品混进了推荐');
  const expired = unavailable.find((u) => u.spuName === '18.8元2份麦辣鸡翅');
  assert.ok(expired, '过期商品应该出现在换不了的清单里');
  assert.ok(expired.reason.includes('兑换期已过'));
});

test('积分：看不出价值的实物不参与排序，但要说明为什么', () => {
  const products = core.parseMallProducts(mallProducts);
  const { ranked, unavailable } = core.rankPointsRewards(products, { now: NOW, includeExpired: true });

  assert.ok(!ranked.some((r) => r.spuName === 'Nike Book 2 麦当劳特别联名款'));
  const nike = unavailable.find((u) => u.spuName === 'Nike Book 2 麦当劳特别联名款');
  assert.ok(nike && nike.reason.includes('看不出值多少钱'));
});

test('积分：花钱买的派对不算积分兑换', () => {
  const products = core.parseMallProducts(mallProducts);
  const { unavailable } = core.rankPointsRewards(products, { now: NOW, includeExpired: true });
  const party = unavailable.find((u) => u.spuName === '麦当劳亲子读书会');
  assert.ok(party);
  assert.ok(party.reason.includes('不用积分'), '要说清楚这是花钱买的，不是积分兑换');
});

test('积分：场景四整体结论 —— 余额为 0 时要说实话', () => {
  const res = core.advisePoints({ account, mallProducts, now: NOW });

  assert.equal(res.scenario, 'points');
  assert.equal(res.account.available, 0);
  assert.ok(res.notes.some((n) => n.includes('可用积分是 0')), '余额为 0 要明说');
  assert.ok(res.notes.some((n) => n.includes('粒度')), '数据精度限制要主动交代');
  assert.ok(res.notes.some((n) => n.includes('3704.6')), '已经过期的分也要提一句');
});

test('积分：余额不够时明确说还差多少', () => {
  const acc = core.parseAccount({ data: { availablePoint: '30' } });
  const products = core.parseMallProducts(mallProducts);
  const { ranked } = core.rankPointsRewards(products, { now: NOW });
  const result = core.affordability(ranked[0], acc);

  assert.equal(result.affordable, false);
  assert.equal(result.short, 20, '50 - 30 = 20');
  assert.ok(result.reason.includes('还差 20 分'));
});

// ---------------------------------------------------------------------------
// 输出风格 —— 需求里专门提过「不要客服腔」
// ---------------------------------------------------------------------------

test('文案：不要出现客服腔', () => {
  // 只检查「我们自己生成的句子」。商品名是麦当劳起的，里面出现什么都不该赖我们
  // —— 比如「麦当劳亲子读书会」里就有个「亲」字。
  const banned = ['根据您的需求为您推荐', '亲', '尊敬的用户', '为您精心', '温馨提示'];

  const meal = core.adviseMeal({ menu, nutrition: nutritionRaw, filters: { excludeFried: true }, now: NOW });
  const coupons = core.adviseCoupons({ coupons: core.parseCoupons(couponsSample), now: NOW });
  const points = core.advisePoints({ account, mallProducts, now: NOW });

  const ourWords = [
    ...meal.notes,
    ...meal.plans.map((p) => core.formatPlanLine(p, null)),
    ...coupons.notes,
    ...coupons.expiring.flatMap((c) => [c.action, c.timing]),
    ...points.notes,
    ...points.expiring.map((e) => e.sentence),
  ];

  for (const word of banned) {
    const hit = ourWords.find((w) => w.includes(word));
    assert.ok(!hit, `出现了客服腔「${word}」：${hit}`);
  }
});

test('文案：说人话 —— 结论要具体到钱或者卡路里，不能是空话', () => {
  const res = core.adviseMeal({
    menu,
    nutrition: nutritionRaw,
    filters: { maxPrice: 40, excludeFried: true },
    now: NOW,
  });

  for (const p of res.plans) {
    const line = core.formatPlanLine(p, null);
    // 每个方案至少要说清「多少钱」和「多少卡」中的一件
    assert.ok(/元/.test(line), `方案没说钱：${line}`);
    assert.ok(/大卡/.test(line), `方案没说热量：${line}`);
  }
});

test('名称匹配：菜单「麦咖啡™奶铁」靠别名子串对到营养表，但要标明是推断', () => {
  const table = core.parseNutrition(nutritionRaw);
  const r = core.matchNutrition('麦咖啡™奶铁', table);

  assert.equal(r.status, 'ok');
  assert.equal(r.strategy, 'alias-fuzzy');
  assert.equal(r.confidence, 'medium', '子串对出来的是推断，不能标 high');
  assert.ok(r.note.includes('别名'), '要留下说明');
});

test('名称匹配：多个候选一律报歧义，不挑最像的那个', () => {
  const table = core.parseNutrition(nutritionRaw);
  // 「派」在营养表里有香芋派和菠萝派两个，热量差 11 大卡，不该替用户选
  const r = core.matchNutrition('派', table);
  assert.equal(r.status, 'ambiguous');
  assert.ok(r.candidates.length >= 2);
});
