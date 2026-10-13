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

## 二、工程结构

```
video_code/
├── README.md                  本文件：环境、结构、约定
├── art/
│   └── style-samples/         美术风格样图（Q版 / 水墨）
├── core/                      纯逻辑层：不依赖引擎，可单测、可批跑
│   └── src/
│       ├── types.ts           数据契约（卡牌、属性、玩家模型）
│       └── score.ts           Build 评分模型（纯函数）
├── design/
│   └── numbers/
│       ├── cards.json         功法卡数值表 v0.1（全部 PLACEHOLDER）
│       └── sim-report.md      Monte Carlo 模拟报告（自动生成）
├── tools/
│   └── sim/
│       └── card-sim.ts        抽卡模拟器
└── game/                       Cocos Creator 工程（已创建 · Empty(2D) 模板 · Creator 3.8.8）
    ├── assets/scripts/         游戏脚本（View 层组件放这里）
    ├── settings/               项目设置（2D 模块已启用，3D 已关闭）
    └── package.json            工程描述（name/uuid/version/type=2d）
```

### 三条不可妥协的约定

1. **`core/` 里不许出现 `cc.*`、`wx.*`、`tt.*`**。逻辑与表现分离，是为了让数值和概率能在引擎之外被测试；一旦逻辑写进 Cocos 组件，就只能靠人肉玩来验证概率，效率差一个数量级。
2. **所有数值只存 `design/numbers/*.json`，不写死在代码里**。改数值不需要重新编译，这是调平衡的前提。
3. **未经 playtest 的数值一律标 `PLACEHOLDER`**，并写明依据与验证路径。禁止 magic number。

---

## 三、如何运行逻辑层测试与模拟

```bash
# 抽卡 Monte Carlo（零依赖，Node 22 直接跑 TS）
node --experimental-strip-types tools/sim/card-sim.ts
```

```bash
# 命令行构建（Cocos Creator 3.8.8，注意：命令行无法创建项目，项目内也需已有场景）
"D:\Cocos\cocos\Creator\3.8.8\CocosCreator.exe" --project D:\AICODE\workBuddy_code\video_code\game --build "platform=web-mobile;debug=true"
# 退出码：36 = 构建成功 / 32 = 参数不合法 / 34 = 构建过程出错
```

输出：控制台报告 + `design/numbers/sim-report.md`（固定随机种子，任何人跑结果一致，便于对比改动效果）。

模拟器回答三个结构性问题：
- 有没有**死亡卡**（一万局几乎无人选）
- 有没有**主导卡**（被选中率远超均匀基准）
- 一局的终局强度分布有多窄（太窄 = 每局长一个样，重玩价值是假的）

---

## 四、调试约定（工程化提速的关键）

游戏内 Debug 面板第一版就要做，清单：

1. 跳波次 / 直达 Boss
2. 指定给卡（直接构造目标 Build）
3. 时间倍速 1x / 2x / 4x
4. 无敌 / 秒杀
5. 强制触发广告与内购沙箱
6. 数值热改（改 JSON 立即生效）
7. 固定随机种子（复现 bug 的唯一可靠办法）

---

## 五、当前进度

- [x] 平台与变现路线确定：微信 / 抖音小游戏 + H5，内购 + 广告
- [x] 设计骨架确认：2D 节点大世界做壳 + 单局 Roguelike 做核
- [x] 单局时长确定：6-10 分钟
- [x] 纯逻辑层骨架 + 数值表 v0.1 + Monte Carlo 模拟器跑通
- [x] Cocos Creator 3.8.8 安装于 `D:\Cocos\cocos\Creator\3.8.8`，`game/` 工程已用 Empty(2D) 模板创建
- [ ] 在 Dashboard 中打开 `game/` 验证工程（首次打开会生成 library/temp 缓存），创建首个场景
- [ ] 把 `core/` 纯逻辑层迁入 `game/assets/scripts/core/`（Cocos 只打包 assets 下的脚本），并引入单测工具
- [ ] 灰盒战斗（验证单局时长与爽感峰值）
- [ ] 大世界壳（节点地图）与资源流转
- [ ] 商业化点位（广告 + 内购）
- [ ] 版本迭代规划与资质办理
