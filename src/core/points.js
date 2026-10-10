'use strict';

/**
 * 积分模块
 *
 * ⚠️ 一个必须说实话的限制（实测得出的，写进代码免得以后圆不回来）：
 * query-my-account 只给了「本月将过期 / 下月将过期」两个**额度**字段，
 * 没有任何精确的过期日期。字段名是接口原文的拼写：
 *   currentMouthExpirePoint —— 本月将过期积分（Mouth 是接口自己的拼写，不是笔误）
 *   nextMouthExpirePoint    —— 下月将过期积分
 *
 * 所以场景四只能说「这个月月底会过期 X 分」，**不能**编一个「10月31日 23:59 过期」出来。
 * 需求文档说「告诉我过期时间」，这里给的是能拿到的最大精度：月份 + 月底。
 */

/** 把 MCP 返回的字符串数字安全转成 number（那边所有数字都是字符串） */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 解析积分账户。
 * 入参兼容 MCP 的包装 { success, data:{...} } 或直接是 data。
 */
function parseAccount(raw) {
  const d = raw && typeof raw === 'object' && raw.data ? raw.data : raw || {};
  const available = toNumber(d.availablePoint);
  const thisMonth = toNumber(d.currentMouthExpirePoint);
  const nextMonth = toNumber(d.nextMouthExpirePoint);
  const expired = toNumber(d.expiredPoint);

  return {
    accountId: d.accountId ?? null,
    available,
    accumulative: toNumber(d.accumulativePoint),
    frozen: toNumber(d.frozenPoint),
    used: toNumber(d.usedPoint),
    expired,
    thisMonthExpiring: thisMonth,
    nextMonthExpiring: nextMonth,
    // 关键判断：这个月会过期多少，以及它占可用积分的比例
    atRiskRatio: available > 0 ? thisMonth / available : 0,
  };
}

/** 一个自然月的最后一天 */
function endOfMonth(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

/** 下个月的最后一天 */
function endOfNextMonth(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth() + 2, 0);
}

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * 生成「积分过期」提示。
 * 返回值里带着 precision 字段，明确告诉上层这个时间的精度是什么，
 * 免得模型顺手把它当精确到期日说出来。
 */
function describeExpiringPoints(account, now = new Date()) {
  const items = [];
  if (account.thisMonthExpiring > 0) {
    const end = endOfMonth(now);
    const left = Math.max(0, Math.round((end - now) / 86400000));
    items.push({
      points: account.thisMonthExpiring,
      window: '本月',
      deadline: fmt(end),
      daysLeft: left,
      precision: 'month-end',
      sentence: `${account.thisMonthExpiring} 分这个月月底（约 ${fmt(end)}）就过期了，还有 ${left} 天`,
    });
  }
  if (account.nextMonthExpiring > 0) {
    const end = endOfNextMonth(now);
    items.push({
      points: account.nextMonthExpiring,
      window: '下月',
      deadline: fmt(end),
      daysLeft: Math.max(0, Math.round((end - now) / 86400000)),
      precision: 'month-end',
      sentence: `${account.nextMonthExpiring} 分下个月月底（约 ${fmt(end)}）过期`,
    });
  }
  return items;
}

/**
 * 从麦麦商城商品里挑出「积分兑换性价比最高」的。
 *
 * 这一段是被真实数据教育出来的，跟直觉不一样，记下来：
 *
 *   mall-points-products 返回的字段是
 *     spuName / spuId / point（所需积分）/ selling / upTime / downTime / price（所需金额）/ status
 *
 *   —— 「18.8元2份麦辣鸡翅」这条，point=200，price=0。
 *      也就是说 price 不是「商品值多少钱」，而是「除积分外还要另付多少钱」。
 *      真实价值写在**商品名里的那串数字**上（18.8 元）。
 *
 *   所以性价比 = 从名字里抠出来的面值 ÷ 所需积分。
 *   抠不出来的（比如「罗技键鼠套装」6666 分、「Nike Book 2」8888 分这些实物），
 *   就老实说「没法比」，而不是拿 0 当分子算出一个虚高的第一名。
 *
 *   还有个坑：不少商品 status=2（上架）但 downTime 是半年前（比如 2026-03-21）。
 *   按状态判断会把这些早过期的券推给用户，所以必须拿 downTime 和当前时间比。
 */

const POINT_FIELDS = ['point', 'points', 'needPoints', 'pointsPrice', 'exchangePoints', 'pointCost'];
const CASH_FIELDS = ['price', 'cashPrice', 'salePrice', 'amount', 'payPrice', 'cash'];

/** 商品状态：接口原文定义 */
const STATUS = { 1: '仓库中', 2: '上架', 3: '售罄', 4: '下架', 5: '预热' };

function pickNumber(source, fields) {
  for (const f of fields) {
    if (source[f] !== undefined && source[f] !== null && source[f] !== '') {
      const n = Number(source[f]);
      if (Number.isFinite(n)) return { value: n, field: f };
    }
  }
  return { value: null, field: null };
}

/** 从「18.8元2份麦辣鸡翅」里抠出 18.8 */
function parseFaceValue(...texts) {
  for (const t of texts) {
    if (!t) continue;
    const m = String(t).match(/(\d+(?:\.\d+)?)\s*元/);
    if (m) return Number(m[1]);
  }
  return null;
}

function parseTime(value) {
  if (!value) return null;
  const d = new Date(String(value).replace(/-/g, '/'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseMallProducts(raw) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.data) ? raw.data : [];
  return list.map((p) => {
    const pt = pickNumber(p, POINT_FIELDS);
    const cash = pickNumber(p, CASH_FIELDS);
    const upTime = parseTime(p.upTime);
    const downTime = parseTime(p.downTime);
    return {
      spuName: p.spuName ?? p.name ?? p.productName ?? '(未命名商品)',
      spuId: p.spuId ?? p.productId ?? p.id ?? null,
      points: pt.value,
      pointsField: pt.field,
      // price 是「除积分外还要另付的钱」，不是商品价值
      extraCashYuan: cash.value,
      selling: p.selling ?? null,
      catName: p.catName ?? null,
      status: p.status ?? null,
      statusText: STATUS[p.status] ?? '未知状态',
      upTime,
      downTime,
      // 面值优先取名字里的「X元」，其次取 selling
      faceValueYuan: parseFaceValue(p.spuName, p.selling),
      image: p.spuImage ?? null,
    };
  });
}

/**
 * 按性价比排序。
 *
 * 会先把「这会儿根本换不了」的挑出去 —— 过期、下架、售罄的，
 * 推荐给用户等于让他白跑一趟。挑出去的原因逐条说明，不闷声吞掉。
 */
function rankPointsRewards(products, options = {}) {
  const { now = new Date(), includeExpired = false } = options;
  const ranked = [];
  const unavailable = [];

  for (const p of products) {
    const tag = `${p.spuName}（${p.spuId}）`;

    if (!includeExpired) {
      if (p.status !== 2) {
        unavailable.push({ ...p, reason: `当前是「${p.statusText}」，换不了` });
        continue;
      }
      if (p.downTime && p.downTime < now) {
        unavailable.push({ ...p, reason: `兑换期已过（截止 ${p.downTime.toISOString().slice(0, 10)}）` });
        continue;
      }
      if (p.upTime && p.upTime > now) {
        unavailable.push({ ...p, reason: `还没开始，${p.upTime.toISOString().slice(0, 10)} 才开放` });
        continue;
      }
    }

    if (p.points === null || p.points === 0) {
      unavailable.push({ ...p, reason: '不用积分，是直接花钱买的，不在积分兑换范围内' });
      continue;
    }
    if (p.points < 0) {
      unavailable.push({ ...p, reason: '积分数是负数，数据有问题，不敢推' });
      continue;
    }

    const face = p.faceValueYuan;
    const extra = p.extraCashYuan ?? 0;

    if (face === null || face === 0) {
      unavailable.push({ ...p, reason: `看不出值多少钱（${tag}），没法跟别的比，只能你自己判断` });
      continue;
    }

    // 真·性价比：拿到手的面值 ÷ 为它付出的（积分 + 可能的加钱折算）
    // 加钱部分按 1 元 = 100 积分的常见兑换比例折算，折算规则在 note 里写明，不藏着
    const cashAsPoints = extra > 0 ? extra * 100 : 0;
    const totalCostInPoints = p.points + cashAsPoints;

    ranked.push({
      ...p,
      netFaceValueYuan: Math.round((face - extra) * 100) / 100,
      valuePerPoint: Math.round((face / totalCostInPoints) * 10000) / 10000,
      yuanPerHundredPoints: Math.round((face / totalCostInPoints) * 100 * 100) / 100,
      costNote: extra > 0 ? `需要 ${p.points} 积分 + ${extra} 元` : `纯积分，${p.points} 分`,
      daysToExpiry: p.downTime ? Math.round((p.downTime - now) / 86400000) : null,
    });
  }

  ranked.sort((a, b) => {
    if (b.valuePerPoint !== a.valuePerPoint) return b.valuePerPoint - a.valuePerPoint;
    return a.points - b.points; // 同样划算时，省积分的先来
  });

  return { ranked, unavailable };
}

/** 判断积分余额够不够换 */
function affordability(reward, account) {
  if (reward.points === null) return { affordable: null, reason: '所需积分未知' };
  const short = reward.points - account.available;
  const extra = reward.extraCashYuan ?? 0;
  const tail = extra > 0 ? `，另外还要付 ${extra} 元` : '';
  if (short <= 0) {
    return {
      affordable: true,
      remaining: account.available - reward.points,
      reason: `换完还剩 ${account.available - reward.points} 分${tail}`,
    };
  }
  return { affordable: false, short, reason: `还差 ${short} 分${tail}` };
}

module.exports = {
  toNumber,
  parseAccount,
  endOfMonth,
  endOfNextMonth,
  describeExpiringPoints,
  POINT_FIELDS,
  CASH_FIELDS,
  STATUS,
  parseFaceValue,
  parseMallProducts,
  rankPointsRewards,
  affordability,
};
