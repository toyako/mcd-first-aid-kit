# MCP 接入说明

这份文件说清楚三件事：用了麦当劳哪个 MCP Server、具体调了哪些 Tool、以及每个 Tool 为什么非用不可。

## 1. 使用的 MCP Server

| 项 | 值 |
|---|---|
| Server 名称 | 麦当劳中国 MCP Server（`mcd-mcp`） |
| 接入地址 | `https://mcp.mcd.cn` |
| 传输协议 | Streamable HTTP |
| 身份认证 | 请求头 `Authorization: Bearer <MCD_MCP_TOKEN>` |
| Token 申请 | <https://open.mcd.cn/mcp> → 登录 → 控制台 → 激活 |
| 官方使用指南 | <https://github.com/M-China/mcd-mcp-server> |
| 限流 | 每个 Token 每分钟最多 600 次请求（超出返回 429） |

脱敏配置示例见仓库根目录的 [`mcp-config.example.json`](./mcp-config.example.json)，里面只写环境变量占位符 `${MCD_MCP_TOKEN}`，**不含任何真实凭证**。

## 2. 实际调用的 Tool 清单

下面这些是本项目真实调用过的工具，括号里是调用它的原因。

### 定位与时间

| Tool | 用在哪 | 为什么必须用它 |
|---|---|---|
| `now-time-info` | 全部四个场景 | 券的剩余天数和积分的过期窗口都得拿真实时间算，不能拿本地时钟硬编码 |
| `query-nearby-stores` | 场景一、二 | 到店场景必须先拿到 `storeCode`，后面所有工具都要靠它；`beType=1` 到店自取、`beType=5` 得来速 |
| `delivery-query-stores` | 外送分支 | 用户要麦乐送时改用这个，`beCode` 必传 |

### 菜单与营养

| Tool | 用在哪 | 为什么必须用它 |
|---|---|---|
| `query-meals` | 场景一、三 | 门店在售菜单、价格、标签、分类。**商品编码（`code`）只能从这里拿**，是后续所有下单调用的钥匙 |
| `query-meal-detail` | 场景一（按需） | 套餐里到底包含什么、能不能换。判断"这个套餐值不值"要用 |
| `list-nutrition-foods` | 场景一、三 | 热量、蛋白质、脂肪、碳水、钠。**减脂筛选完全依赖它** |

### 券

| Tool | 用在哪 | 为什么必须用它 |
|---|---|---|
| `query-store-coupons` | 场景一、二 | **这是唯一能回答"这张券在我要去的店能不能用"的工具**。它同时给出有效期（`tradeDateTime`）和适用商品（`products[].productCode`），场景二要求的"每张券告诉用户还能买什么"只能靠它 |
| `query-my-coupons` | 场景二（卡包总览） | 看卡包里一共有什么券。**注意它不做门店/渠道校验**，所以只用于展示，不用于判断可用性 |
| `available-coupons` | 场景一（可选） | 看还能领什么券 |
| `auto-bind-coupons` | 场景一（可选） | 一键把能领的券领了。这是"自动领券"这一步的实现方式 |

### 积分

| Tool | 用在哪 | 为什么必须用它 |
|---|---|---|
| `query-my-account` | 场景四 | 可用积分、累计积分、**本月/下月将过期积分** |
| `mall-points-products` | 场景四 | 积分商城可兑换商品清单，含所需积分、兑换起止时间、商品状态 |

### 结算

| Tool | 用在哪 | 为什么必须用它 |
|---|---|---|
| `calculate-price` | 场景一、二、三 | **所有金额的唯一权威来源**。本地只做估算排序，真实价格（含券优惠、运费、打包费）一律以它返回的为准。返回单位是分，除以 100 才是元 |
| `create-order` | 全场景 | 真正下单。**只有在用户明确确认后才允许调用** |

没有用到的工具（如 `draw-lottery`、`party-order-create`、`query-lottery-info` 等）本项目不涉及，不在 SKILL.md 的工具地图里，避免模型误调。

## 3. 调用流程

### 场景一：中午吃什么

```
now-time-info                        拿当前时间
      ↓
query-nearby-stores (beType=1)       定位门店 → storeCode
      ↓
      ├─ query-meals                 菜单（含商品编码、价格）
      ├─ list-nutrition-foods        营养表
      └─ query-store-coupons         本店可用券（含有效期 + 适用商品）
      ↓
scripts/maimai.js meal               本地决策核心：筛选 → 组合 → 排序 → 出 3 个方案
      ↓
calculate-price                      对入围方案逐个核真实价格（脚本已把候选压到 8 个以内）
      ↓
      ⛔ 停下来问用户：「就这个？」
      ↓
create-order                         用户确认后才调
```

### 场景二：券快过期了

```
now-time-info
      ↓
query-store-coupons                  拿到券 + tradeDateTime + 适用商品
      ↓
scripts/maimai.js coupons            按剩余天数分桶，每张券配一句「能买什么、什么时候用」
      ↓
（用户说「用掉那张」）
      ↓
query-meals + calculate-price        把券限定的商品拉进订单并核价
      ↓
      ⛔ 再次确认
      ↓
create-order
```

### 场景三：隐藏吃法

```
query-meals                          查门店有没有这两样在售
      ↓
list-nutrition-foods                 算总热量
      ↓
scripts/maimai.js hidden             算总价、给出「分开点两份」的下单方式
```

### 场景四：积分快过期

```
now-time-info
      ↓
      ├─ query-my-account            余额 + 本月/下月将过期额度
      └─ mall-points-products        可兑换清单 + 兑换截止时间
      ↓
scripts/maimai.js points             按「面值 ÷ 所需积分」排序，只推 1–2 个
```

## 4. 业务价值

一句话：**把麦当劳 APP 里那些"要来回翻、要自己算、算完还不确定对不对"的部分，换成一句人话加三个方案。**

拆开看是四块价值：

**省时间。** 用户本来要点开 APP、翻菜单、切到卡包、比对券的适用商品、再切回来下单，中间还要自己想热量。现在一句「减脂、40 以内、别推荐炸的」，直接出结论。

**省钱省得明明白白。** 券和餐品的匹配关系由 `query-store-coupons` 的 `products` 字段确定，不是猜的。能用就说能用、能省多少；用不了就直接说"这张券今天用不了"，不会让用户到柜台才发现。

**热量不靠感觉。** 热量数字全部来自 `list-nutrition-foods`，不是模型凭印象报的。查不到就说查不到。

**不越界。** 价格一律以 `calculate-price` 为准，下单前一定停下来问。这个 skill 是帮用户拿主意的，不是替他做主的。

## 5. 实测踩到的坑（对后续开发者有用）

这部分是真实调试出来的，不是推测。

**营养表没有商品编码。** `list-nutrition-foods` 只返回菜名，而 `query-meals` 只有编码加名字。所以"按热量筛选"这件事真正的难点在名称匹配，不在营养数据本身。更麻烦的是两边叫法不一致：

- 菜单 `薯条` → 营养表 `中薯条` / `大薯条` / `小薯条` / `迷你薯条`
- 菜单 `麦乐鸡` → 营养表 `麦乐鸡4块` / `麦乐鸡5块`
- 菜单 `可乐` → 营养表 `可乐中杯` / `可乐大杯` / `可乐小杯`

解决办法写在 `src/core/nutrition.js`：精确匹配 → 别名表 → 基础名匹配（规格词剥离）→ 单候选包含匹配，并按置信度分档。多候选一律报歧义，不替用户选。其中"默认中杯"这个推断被 `calculate-price` 验证过 —— 传商品编码 `4810`（菜单名「薯条」）进去，返回的商品名是「中薯条」。

**积分过期只有月度粒度。** `query-my-account` 只给了 `currentMouthExpirePoint`（本月将过期）和 `nextMouthExpirePoint`（下月将过期），**没有任何精确到日的字段**。所以场景四只能说"这个月月底"，说具体日期就是编。字段名里的 `Mouth` 是接口原文拼写（`Month` 的误写），保留原样，不要在代码里"修正"。

**积分商城的 `price` 不是商品价值。** 实测「18.8元2份麦辣鸡翅」这条：`point=200`、`price=0`。`price` 是"除积分外还要另付多少钱"，真实面值写在 `spuName` 里。另外不少商品 `status=2`（上架）但 `downTime` 已经过去半年，只按状态判断会把过期券推给用户。

**`query-my-coupons` 不校验门店。** 官方说明里写得很清楚：它返回的券不做门店、渠道、配送方式校验，不承诺可用于当前订单。要判断可用性必须用 `query-store-coupons`。这两个工具很容易用混。

**价格单位是分。** `calculate-price` 返回的 `price` / `discount` / `originalPrice` 全是分，除以 100 才是元。

**限流 600 次/分钟。** 如果对菜单里每个商品都单独报价，一轮就能把配额烧掉大半。所以本地决策核心把候选组合硬限制在 8 个以内（`buildCombos` 的 `maxCombos`）。

**`query-meal-detail` 的参数名是 `code`，不是 `productCode`。** 实测踩过：传 `productCode` 会直接参数校验失败——

```
Parameter validation failed for tool "query-meal-detail":
  root: must have required property 'code';
  root: must NOT have additional properties
```

它的必填参数是 `storeCode` + `orderType` + `beType` + `code`，而且开了 `additionalProperties: false`，多传一个字段就整条请求作废。注意跟 `calculate-price` / `query-meals` 区别开——那两个用的是 `productCode`，同一个"商品编码"在不同工具里字段名不一样，很容易串。
