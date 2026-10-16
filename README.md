# 修仙小游戏 · 工程总览

2D 节点大世界（壳）+ 单局 Roguelike 修仙（核），目标平台微信小游戏 / 抖音小游戏 / H5。

---

## 一、开发环境清单

### 本机体检结果（2026-10-13 实测）

| 项目 | 实测 | 结论 |
|---|---|---|
| CPU | 12 核 | 够用 |
| 内存 | 16GB（空闲 8.6GB） | 达标线，Cocos 编辑器占用较大，建议关闭多余应用 |
| C 盘 | 151G / 空闲 91G | 够装工具，但引擎多版本会吃空间 |
| D 盘 | 327G / 空闲 290G | **Cocos 工程与引擎版本建议装这里** |
| Node.js | v22.22.2 | 达标（逻辑层与模拟工具依赖） |
| npm | 10.9.7 | 达标 |
| Git | 2.55.0 | 达标 |
| VS Code | **1.134.0**（装在 `D:\code_idea\Microsoft VS Code\`，已加入 PATH） | 达标，可直接用 `code .` 打开工程 |
| IntelliJ IDEA | 2026.2.1（`D:\code_idea\idea\`） | 本项目用不到，可忽略 |
| Cocos Dashboard | 2.2.2（`D:\Cocos\CocosDashboard\`） | **已安装** |
| Cocos Creator | **3.8.8**（`D:\Cocos\cocos\Creator\3.8.8\`，占用 3.8GB） | **已安装**，2D 模块已启用 |

### 待安装（仅剩微信 / 抖音开发者工具）

| 工具 | 版本建议 | 用途 | 下载 |
|---|---|---|---|
| ~~Cocos Dashboard + Cocos Creator~~ | 已完成：Dashboard 2.2.2 + Creator 3.8.8 | 引擎、编辑器、三端构建 | https://www.cocos.com/creator-download |
| 微信开发者工具 | 稳定版 | 微信小游戏模拟器与真机调试 | https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html |
| 抖音开发者工具 | 最新稳定版 | 抖音小游戏模拟器与真机调试 | https://developer.open-douyin.com/ |

> 说明：已扫描 C 盘默认路径、D 盘自定义软件目录（`D:\code_idea`、`D:\Cocos`、`D:\tools`、`D:\AI`、`D:\Version`）与开始菜单。截至 2026-10-13，微信开发者工具与抖音开发者工具确认未安装。

### 账号与资质（与开发并行启动，不要等上线前才办）

1. 微信小游戏账号（个人可注册，游戏类目需资质审核）
2. 抖音小游戏账号（内购需企业主体）
3. 公司注册（内购变现的前提）
4. 软件著作权登记（常规申请周期以官方为准，建议尽早启动）
5. 版号政策以平台当期规则为准，立项文档需保留复核记录

---

## 二、一分钟上手

```bash
npm run serve          # 起浏览器灰盒原型 → http://127.0.0.1:5199/prototype/
npm run check          # 提交前跑这个：生成数据 + 单测 + 万局模拟
```

原型就是当前可试玩版本，**不用等 Cocos 打包**。玩法：`WASD`/方向键走位（攻击自动），
每次清空一波做一次三选一，`` ` `` 打开开发者面板（无敌、倍速、跳波次、指定发卡）。

---

## 三、工程结构

```
video_code/
├── README.md
├── credentials.md            平台账号记录（已 .gitignore，永不入库）
├── art/style-samples/        美术风格样图（Q版 / 水墨）
├── core/                     纯逻辑层：不含 cc.* / wx.* / tt.*，可单测、可万局批跑
│   ├── src/
│   │   ├── types.js          数据契约与常量（效果类型、生存类效果定义）
│   │   ├── data.generated.js 由 cards.json 生成 —— 不要手改，改完 npm run gen
│   │   ├── rng.js            带种子的可复现随机（mulberry32）
│   │   ├── stats.js          Build 属性聚合与评分（DPS 乘区、生存乘区）
│   │   ├── deck.js           卡池、流派保底、三选一
│   │   ├── balance.js        解析式波次评估 —— 万局模拟的地基
│   │   ├── battle.js         单局实时战斗状态机（刷怪 / 走位 / 伤害数字 / 波间强化）
│   │   ├── economy.js        灵石 sources & sinks
│   │   ├── meta.js           境界与局外成长
│   │   └── save.js           存档序列化（纯函数，不碰任何平台 API）
│   └── test/                 169 项单测（node --test，零依赖，<2 秒）
├── design/numbers/
│   ├── cards.json            数值表 v0.3.2（全部 PLACEHOLDER，每项附 rationale）
│   └── sim-report.md         Monte Carlo 报告（自动生成）
├── prototype/                浏览器灰盒原型
│   ├── index.html · styles.css
│   ├── src/{main,ui,render,input,storage}.js
│   └── shots/                自动截图（视觉回归基线）
├── tools/
│   ├── gen-data.mjs          cards.json → data.generated.js，含跨段一致性校验
│   ├── serve.mjs             零依赖静态服务器
│   ├── smoke-prototype.mjs   原型接线与流程检查（假 DOM + 虚拟时钟，约 2 秒）
│   ├── browser-check.mjs     真实 Chrome：视觉核查 + 顶层命中测试
│   ├── wave-conformance.mjs  解析式模型 ↔ 实时战斗 的逐波一致性核对
│   └── sim/
│       ├── card-sim.mjs      万局抽卡与通关模拟
│       └── tune-grid.mjs     数值参数搜索器（调难度时用）
└── game/                     Cocos Creator 工程（Empty 2D 模板 · Creator 3.8.8）
```

### 四条不可妥协的约定

1. **`core/` 里不许出现 `cc.*`、`wx.*`、`tt.*`**。逻辑与表现分离，是为了让数值和概率能在引擎之外被测试；一旦逻辑写进 Cocos 组件，就只能靠人肉玩来验证概率，效率差一个数量级。
2. **所有数值只存 `design/numbers/*.json`，不写死在代码里**。改数值不需要重新编译，这是调平衡的前提。
3. **未经 playtest 的数值一律标 `PLACEHOLDER`**，并写明依据与验证路径。禁止 magic number。
4. **表现层参数不得渗进平衡结论**。`spawn.swarmPerWave`（每波摊成几个小怪）曾被当作纯表现参数，但击杀奖励按屏幕上的敌人个数发，实际产出被放大 4 倍；同类事故还有 HUD 里写死的「/ 12 波」。凡是「只影响观感」的参数，都必须有一条测试证明它对平衡真的没有影响。

---

## 四、常用命令

| 命令 | 作用 |
|---|---|
| `npm run serve` | 起原型（<http://127.0.0.1:5199/prototype/>） |
| `npm run gen` | `cards.json` → `data.generated.js`，带跨段一致性校验 |
| `npm test` | 169 项单测 |
| `npm run sim` | 万局 Monte Carlo → `design/numbers/sim-report.md` |
| `npm run check` | gen + test + sim 串跑（提交前必过） |
| `npm run smoke` | 原型接线与流程（8 条链路） |
| `npm run visual` | 真实 Chrome 截图 + 命中测试（约 30 秒） |
| `npm run conform` | 两份模型的逐波一致性核对 |
| `npm run tune` | 数值参数网格搜索（改难度用） |

### 为什么有四个验证工具，而不是一个

它们抓的是**完全不同类别**的问题，缺一类就会漏掉一整批 bug：

| 工具 | 抓什么 | 抓不到什么 |
|---|---|---|
| 单测 | 纯逻辑的正确性（169 项） | 界面、接线、观感 |
| `smoke-prototype` | 接线与流程（点击有没有接上、阶段切换、存档往返） | 像素、布局、遮挡 |
| `browser-check` | 真实浏览器里的布局、对比度、遮挡、**元素能不能点到** | 数值是否好玩 |
| `wave-conformance` | 两份模型（解析式 / 实时）的难度结论是否一致 | 玩起来爽不爽 |

`browser-check` 里的「顶层命中测试」是踩坑后加的：它遍历所有可交互元素，逐个问浏览器
`document.elementFromPoint(中心点)` 站的是谁。**元素存在 ≠ 元素可点**——DOM 查询、onclick 绑定、
元素可见性全部正常，一个没被正确隐藏的全屏浮层就能吞掉所有点击，表现为「什么都点不了」。

### 单局时长的约束放在哪

「一局 6-10 分钟」是产品级约束，但它测不到任何单个函数上——它取决于波数、波次时长、
敌人数值、玩家成长曲线四者的合力。所以它由 `npm run sim` 强制：跑出区间外直接以非零码退出，
`npm run check` 因此会失败。**别把它写成单测**，那会变成一条假绿。

---

## 五、开发者面板（工程化提速的关键）

原型里按 `` ` `` 打开，已实现：

| 功能 | 状态 | 说明 |
|---|---|---|
| 跳波次 / 直达 Boss | ✅ | 不用打 7 分钟就能看第 18 波 |
| 指定给卡 | ✅ | 直接构造目标 Build |
| 时间倍速 1x / 2x / 4x | ✅ | |
| 无敌 | ✅ | |
| 数值热改 | ✅ | 改 JSON → `npm run gen` → 刷新 |
| 固定随机种子 | ✅ | 复现 bug 的唯一可靠办法；`window.__game` 也能直接用 |
| 广告与内购沙箱 | ⬜ | 等商业化点位确定后接 |

---

## 六、当前进度

- [x] 平台与变现路线：微信 / 抖音小游戏 + H5，内购 + 广告
- [x] 设计骨架：2D 节点大世界做壳 + 单局 Roguelike 做核
- [x] 单局时长：6-10 分钟（模拟实测 7.03 分钟，已进区间并由 `npm run check` 守住）
- [x] 纯逻辑层：rng / stats / deck / balance / battle / economy / meta / save
- [x] 数值表 v0.3.2（20 张卡 / 5 流派），万局模拟收敛，无死亡卡、无主导卡
- [x] 169 项单测 + 4 个验证工具
- [x] 浏览器灰盒原型可试玩：Canvas 实时战斗 + DOM 菜单 + 大世界壳 + 局外成长 + 存档
- [x] 打通 Cocos Creator 3.8.8 工程（`game/`，Empty 2D 模板）
- [ ] 真人 playtest 校准（当前全部数值仍是 PLACEHOLDER）
- [ ] 把 `core/` 迁入 `game/assets/scripts/`，用 Cocos 重做渲染层
- [ ] 大世界壳的资源流转与机缘系统
- [ ] 美术风格定稿（Q版亮色 vs 国风水墨，样图在 `art/style-samples/`）
- [ ] 商业化点位（广告 + 内购沙箱）
- [ ] 资质办理：公司注册 / 软著 / 平台账号（与开发并行）
