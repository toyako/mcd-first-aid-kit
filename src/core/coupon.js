'use strict';

/**
 * 优惠券模块
 *
 * 用到的两个工具返回结构不一样，别搞混：
 *   - query-my-coupons   : 卡包里的券，**不校验**门店/渠道，不代表当前门店能用
 *   - query-store-coupons: 指定门店+订单类型下**真正能用**的券，字段含 tradeDateTime（有效期）
 *                         和 products[]（这张券限定哪些商品）
 *
 * 场景二的「券快过期了」要的是后者，因为只有它才带适用商品，
 * 才能回答「这张券还能买什么」。
 *
 * 现实提醒：MCP 会把结果渲染成 Markdown 表格给模型看，所以这里同时支持
 * 「结构化 JSON」和「Markdown 表格文本」两种输入，免得模型拿到的是一张表而解析不了。
 */

/** 券的临期阈值（天）。7 天以内算「快过期」，跟需求文档一致 */
const EXPIRING_SOON_DAYS = 7;

/**
 * 解析有效期字段。麦当劳 MCP 里有效期字段叫 tradeDateTime。
 *
 * 实现方式：**用正则把字符串里所有日期都扫出来，取最后一个。**
 * 之前是"按 ~ / ～ / 至 切分再取后半段"，结果漏了一种真实格式 ——
 * 门店券返回的是半角连字符写的区间：
 *
 *   "2026-10-10 00:00:00-2026-10-16 23:59:59"
 *
 * 旧写法认不出这个分隔符，会把整串当成一个日期解析，只取到前半段，
 * 于是 10-16 到期的券被误判成"今天到期"。这是实测踩出来的（见 workbuddy.md 第 8.3 节）。
 *
 * 改成"扫全部日期取最后一个"之后，分隔符是 ~ 还是 - 还是 至、有没有前后空格，
 * 全都不用管了。而且不会误伤字符串里本身带连字符的日期（如 "2026-10-20"）。
 *
 * 已知支持：
 *   "2026-10-20 23:59:59" / "2026-10-20" / "2026/10/20 23:59"
 *   "2026-10-10 00:00:00-2026-10-16 23:59:59"  （半角连字符区间）
 *   "2026-10-20~2026-11-05"                     （波浪号区间）
 *   1791639886474                                （毫秒时间戳）
 */
const DATE_PATTERN = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/g;

function parseExpiry(value) {
  if (value === null || value === undefined || value === '' || value === 'null') return null;

  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const s = String(value).trim();

  // 纯数字：时间戳
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000);
  if (/^\d{13}$/.test(s)) return new Date(Number(s));

  const found = [...s.matchAll(DATE_PATTERN)];
  if (found.length === 0) return null;

  // 区间取最后一段 = 截止时间；只有一个日期时就是它本身
  const m = found[found.length - 1];
  const [, y, mo, d, hh = '23', mm = '59', ss = '59'] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 距离过期还有几天（按自然日算，今天到期 = 0） */
function daysLeft(expireAt, now = new Date()) {
  if (!expireAt) return null;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = startOfDay(expireAt) - startOfDay(now);
  return Math.round(diff / 86400000);
}

/**
 * 把券放到「过期紧急度 + 能否用掉」两个维度上看。
 * status:
 *   expired  —— 已经过期，直接告诉用户，别装看不见
 *   today    —— 今天到期
 *   soon     —— 7 天内到期
 *   valid    —— 还早
 */
function classifyCoupon(coupon, now = new Date()) {
  const expireAt = parseExpiry(coupon.expiry);
  const left = daysLeft(expireAt, now);
  let status = 'valid';
  if (left === null) status = 'unknown-expiry';
  else if (left < 0) status = 'expired';
  else if (left === 0) status = 'today';
  else if (left <= EXPIRING_SOON_DAYS) status = 'soon';

  return { ...coupon, expireAt, daysLeft: left, status };
}

/**
 * 解析券列表。优先吃结构化 JSON；喂进来的是 Markdown 表格也能兜住。
 *
 * 输入可以是：
 *   - 数组: [{title, couponId, couponCode, tradeDateTime, products:[{productName, productCode}]}]
 *   - MCP 包装: { success:true, data:[...] }
 *   - 字符串: 直接是工具渲染出来的 Markdown 表格
 */
function parseCoupons(raw) {
  // 已经是结构化数据
  let list = null;
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object' && Array.isArray(raw.data)) list = raw.data;

  if (list) {
    return list.map((c) => ({
      title: c.title ?? c.couponName ?? c.name ?? '(未命名券)',
      couponId: c.couponId ?? null,
      couponCode: c.couponCode ?? null,
      expiry: c.tradeDateTime ?? c.expiry ?? c.validUntil ?? null,
      // 同一券 ID 下可能有多个券码，工具那层会折叠成「首个(共N张)」，这里也兼容
      codeCount: c.codeCount ?? null,
      products: Array.isArray(c.products)
        ? c.products.map((p) => ({
            productName: p.productName ?? null,
            productCode: String(p.productCode ?? ''),
          }))
        : [],
    }));
  }

  // 兜底：解析 Markdown 表格
  if (typeof raw === 'string') return parseCouponMarkdown(raw);

  return [];
}

function parseCouponMarkdown(text) {
  const coupons = [];
  // 表头形如：|券ID|券码|有效期|适用商品|商品编码|
  const rows = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  let lastTitle = null;

  for (const line of rows) {
    const cells = line.split('|').map((c) => c.trim()).filter((c, i, arr) => !(i === 0 || i === arr.length - 1));
    if (cells.length < 3) continue;
    if (/^-+$/.test(cells[0])) continue; // 分隔行
    if (cells[0] === '券ID' || cells[0] === '券码') continue; // 表头行

    const [couponId, couponCode, expiry, productName, productCode] = cells;
    if (!expiry) continue;
    coupons.push({
      title: lastTitle || '(见上方标题行)',
      couponId,
      couponCode,
      expiry,
      codeCount: null,
      products: productName ? [{ productName, productCode }] : [],
    });
  }

  // 抓 ## xxx(共N张) 这种标题作为券名，按出现顺序对应
  const titles = [...text.matchAll(/^#{2,4}\s*(.+?)(?:\(共\d+张\))?\s*$/gm)].map((m) => m[1].trim());
  coupons.forEach((c, i) => {
    if (titles[i]) c.title = titles[i];
  });

  return coupons;
}

/**
 * 主入口：把券整理成「该先处理哪张」的清单。
 * 排序规则：过期的排最前（要报警），然后按剩余天数升序，同天数内按券名稳定排序。
 */
function rankCouponsByUrgency(coupons, now = new Date()) {
  return coupons
    .map((c) => classifyCoupon(c, now))
    .sort((a, b) => {
      const order = { expired: 0, today: 1, soon: 2, 'unknown-expiry': 3, valid: 4 };
      const oa = order[a.status] ?? 9;
      const ob = order[b.status] ?? 9;
      if (oa !== ob) return oa - ob;
      const la = a.daysLeft === null ? 9999 : a.daysLeft;
      const lb = b.daysLeft === null ? 9999 : b.daysLeft;
      if (la !== lb) return la - lb;
      return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');
    });
}

/** 挑出「快过期」的那几张（含今天到期），场景二直接用它 */
function pickExpiringCoupons(coupons, now = new Date()) {
  return rankCouponsByUrgency(coupons, now).filter(
    (c) => c.status === 'today' || c.status === 'soon' || c.status === 'expired'
  );
}

/**
 * 判断一张券能不能用在给定的商品集合上。
 *
 * 这里刻意做成保守派：券带 products 白名单，就必须全部命中；
 * 券没带 products（说明是全场券/通用券），返回 canUse=true 但标明 matched。
 * 匹配不上就明确说「不能用」，需求文档第 4 条就是这么要求的 —— 别硬推。
 */
function canCouponApply(coupon, itemCodes, itemNames = []) {
  if (!coupon.products || coupon.products.length === 0) {
    return { canUse: true, matched: false, reason: '通用券（未限定商品），但以下单时校验为准' };
  }
  const codeSet = new Set(itemCodes.map(String));
  const nameSet = new Set(itemNames);

  const hit = coupon.products.filter(
    (p) => codeSet.has(String(p.productCode)) || (p.productName && nameSet.has(p.productName))
  );

  if (hit.length === 0) {
    return {
      canUse: false,
      matched: true,
      reason: `这张券只认「${coupon.products.map((p) => p.productName).filter(Boolean).join(' / ')}」，你这单里一个都没有`,
    };
  }
  // 券限定的商品里，有在售的、也有不在售的，要把不在售的点出来
  const missing = coupon.products.filter((p) => !hit.includes(p));
  return {
    canUse: true,
    matched: true,
    reason: missing.length
      ? `已命中「${hit.map((p) => p.productName).filter(Boolean).join(' / ')}」；另有「${missing
          .map((p) => p.productName)
          .filter(Boolean)
          .join(' / ')}」当前门店没有`
      : null,
    missingProducts: missing,
  };
}

module.exports = {
  EXPIRING_SOON_DAYS,
  parseExpiry,
  daysLeft,
  classifyCoupon,
  parseCoupons,
  parseCouponMarkdown,
  rankCouponsByUrgency,
  pickExpiringCoupons,
  canCouponApply,
};
