#!/usr/bin/env node
'use strict';

/**
 * 麦麦急救包 · 命令行入口
 *
 * 它是「决策核心」和「WorkBuddy 对话」之间的那根线：
 * WorkBuddy 负责把 MCP 拉回来的原始 JSON 喂进来，这里负责算，
 * 算完把结论交回给 WorkBuddy 去跟用户说话。
 *
 * 用法（MCP 返回的 JSON 直接管道进来）：
 *   node scripts/maimai.js meal    --menu m.json --nutrition n.txt --max-price 40 --exclude-fried
 *   node scripts/maimai.js coupons --coupons c.json
 *   node scripts/maimai.js hidden  --menu m.json --nutrition n.txt --want 薯条,圆筒冰淇淋
 *   node scripts/maimai.js points  --account a.json --mall mall.json
 *
 * 不想配 Token 就想看看它长什么样：
 *   node scripts/maimai.js demo
 *
 * 加 --text 输出人话版，默认输出 JSON（给上层程序读）。
 */

const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/core');

// --- 参数解析（够用就行，不引依赖）-----------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const readInput = (p) => (p ? fs.readFileSync(p, 'utf8') : null);
const readJson = (p) => (p ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);

/** MCP 的返回是 {success, code, message, data}，也可能被工具包了一层，都兜住 */
function unwrap(raw) {
  if (raw && typeof raw === 'object' && 'success' in raw && 'data' in raw) return raw;
  return raw;
}

// --- 人话输出 ---------------------------------------------------------------

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));

function textMeal(res) {
  const lines = [];
  if (!res.plans.length) {
    lines.push('没找到符合条件的组合。要么把条件放宽点，要么直接问我别的搭配。');
  } else {
    lines.push(`给你 ${res.plans.length} 个方案：`);
    res.plans.forEach((p, i) => {
      lines.push(`  ${i + 1}. ${core.formatPlanLine(p, p.coupon ? p.coupon.title : null)}`);
    });
  }
  if (res.notes.length) {
    lines.push('');
    res.notes.forEach((n) => lines.push(`  · ${n}`));
  }
  return lines.join('\n');
}

function textCoupons(res) {
  const lines = [];
  if (!res.expiring.length) {
    lines.push('近期没有要过期的券。');
  } else {
    lines.push(`有 ${res.expiring.length} 张券撑不了多久了：`);
    res.expiring.forEach((c) => {
      lines.push(`  · ${c.title}｜${c.timing}｜${c.action}`);
    });
  }
  if (res.expired.length) {
    lines.push('');
    res.expired.forEach((c) => lines.push(`  ✗ ${c.title} 已经过期了`));
  }
  res.notes.forEach((n) => lines.push(`  · ${n}`));
  return lines.join('\n');
}

function textHidden(res) {
  const lines = [];
  if (!res.items.length) {
    lines.push(`${res.recipeName}：这个吃法今天做不了。`);
  } else {
    lines.push(`${res.recipeName}：`);
    res.items.forEach((i) => {
      lines.push(`  ${pad(i.name, 14)} ${pad(i.price + ' 元', 8)} ${i.nutrition ? i.nutrition.kcal + ' 大卡' : '热量未知'}`);
    });
    lines.push(`  合计 ${res.totalPrice} 元${res.totalKcal !== null ? `，约 ${res.totalKcal} 大卡` : ''}`);
  }
  if (res.howToOrder) lines.push('');
  if (res.howToOrder) lines.push(`怎么点：${res.howToOrder}`);
  res.notes.forEach((n) => lines.push(`  · ${n}`));
  return lines.join('\n');
}

function textPoints(res) {
  const lines = [];
  lines.push(`可用积分：${res.account.available} 分`);
  res.expiring.forEach((e) => lines.push(`  ! ${e.sentence}`));
  if (res.recommended.length) {
    lines.push('');
    lines.push('最划算的换法：');
    res.recommended.forEach((r) => {
      lines.push(`  · ${r.spuName}｜${r.costNote}｜100 分能抵 ${r.yuanPerHundredPoints} 元｜${r.reason}`);
    });
  }
  lines.push('');
  res.notes.forEach((n) => lines.push(`  · ${n}`));
  return lines.join('\n');
}

// --- 各子命令 ---------------------------------------------------------------

function cmdMeal(args) {
  const menu = unwrap(readJson(args.menu));
  const nutrition = readInput(args.nutrition);
  const coupons = args.coupons ? core.parseCoupons(unwrap(readJson(args.coupons))) : [];

  const filters = {
    maxPrice: args['max-price'] ? Number(args['max-price']) : Infinity,
    maxKcal: args['max-kcal'] ? Number(args['max-kcal']) : Infinity,
    minProtein: args['min-protein'] ? Number(args['min-protein']) : 0,
    excludeFried: !!args['exclude-fried'],
    maxPlans: 3,
  };

  return core.adviseMeal({ menu, nutrition, coupons, filters });
}

function cmdCoupons(args) {
  const coupons = core.parseCoupons(unwrap(readJson(args.coupons)));
  return core.adviseCoupons({ coupons });
}

function cmdHidden(args) {
  const menu = unwrap(readJson(args.menu));
  const nutrition = readInput(args.nutrition);
  const items = String(args.want || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!items.length) throw new Error('得用 --want 告诉我要拼什么，比如 --want 薯条,圆筒冰淇淋');
  return core.adviseHiddenCombo({
    menu,
    nutrition,
    recipe: { name: args.name || items.join(' + '), items },
  });
}

function cmdPoints(args) {
  const account = readJson(args.account);
  const mallProducts = unwrap(readJson(args.mall));
  return core.advisePoints({ account, mallProducts });
}

/** 用自带夹具跑一遍 —— 没 Token 也能看效果 */
function cmdDemo(args) {
  const dir = path.join(__dirname, '..', 'test', 'fixtures');
  const menu = readJson(path.join(dir, 'menu.json'));
  const nutrition = readInput(path.join(dir, 'nutrition.txt'));
  const coupons = core.parseCoupons(readJson(path.join(dir, 'coupons.sample.json')));
  const account = readJson(path.join(dir, 'account.json'));
  const mall = readJson(path.join(dir, 'mall-products.json'));

  const now = new Date('2026-10-10T12:00:00');

  const out = {
    _note: '这是用仓库自带的真实抓包夹具跑出来的，没有连 MCP。想跑真实的，配好 Token 后把 MCP 返回喂给对应的子命令。',
    '场景1 中午吃什么（减脂 / 40 元内 / 不要炸的）': core.adviseMeal({
      menu,
      nutrition,
      coupons,
      filters: { maxPrice: 40, maxKcal: 600, minProtein: 15, excludeFried: true },
      now,
    }),
    '场景2 券快过期了': core.adviseCoupons({ coupons, now }),
    '场景3 薯条蘸冰淇淋': core.adviseHiddenCombo({
      menu,
      nutrition,
      recipe: { name: '薯条蘸冰淇淋', items: ['薯条', '圆筒冰淇淋'], assembly: '拿薯条蘸着吃' },
      now,
    }),
    '场景4 积分快过期了': core.advisePoints({ account, mallProducts: mall, now }),
  };

  if (args.text) {
    return [
      '=== 场景1 中午吃什么（减脂 / 40 元内 / 不要炸的）===',
      textMeal(out['场景1 中午吃什么（减脂 / 40 元内 / 不要炸的）']),
      '',
      '=== 场景2 券快过期了 ===',
      textCoupons(out['场景2 券快过期了']),
      '',
      '=== 场景3 薯条蘸冰淇淋 ===',
      textHidden(out['场景3 薯条蘸冰淇淋']),
      '',
      '=== 场景4 积分快过期了 ===',
      textPoints(out['场景4 积分快过期了']),
    ].join('\n');
  }

  return out;
}

// --- main -------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const handlers = { meal: cmdMeal, coupons: cmdCoupons, hidden: cmdHidden, points: cmdPoints, demo: cmdDemo };

  if (!cmd || !handlers[cmd]) {
    process.stderr.write(
      [
        '麦麦急救包 —— 用法：',
        '',
        '  node scripts/maimai.js meal    --menu <query-meals结果> --nutrition <list-nutrition-foods结果> [--coupons <query-store-coupons结果>] [--max-price 40] [--max-kcal 600] [--min-protein 15] [--exclude-fried]',
        '  node scripts/maimai.js coupons --coupons <query-store-coupons结果>',
        '  node scripts/maimai.js hidden  --menu <菜单> --nutrition <营养表> --want 薯条,圆筒冰淇淋 [--name 薯条蘸冰淇淋]',
        '  node scripts/maimai.js points  --account <query-my-account结果> --mall <mall-points-products结果>',
        '  node scripts/maimai.js demo    [--text]     # 没 Token 也能跑，用仓库自带夹具',
        '',
      ].join('\n')
    );
    process.exit(1);
  }

  let result;
  try {
    result = handlers[cmd](args);
  } catch (err) {
    process.stderr.write(`出错了：${err.message}\n`);
    process.exit(2);
  }

  if (typeof result === 'string') {
    process.stdout.write(result + '\n');
    return;
  }

  if (args.text) {
    const texts = { meal: textMeal, coupons: textCoupons, hidden: textHidden, points: textPoints };
    process.stdout.write((texts[cmd] ? texts[cmd](result) : JSON.stringify(result, null, 2)) + '\n');
    return;
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main();
