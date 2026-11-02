# dsh-oracle-gate

> 把验收标准先冻住，再只认执行回执的准入闸门。

DSH（DeepSeek Harness）插件。目标只有一句话：**让「做完了」这件事不再由做的人说了算。**

---

## 它解决什么问题

多 agent 协作里最贵的一次事故，不是写错代码，而是**双方对「做完了」的定义不一致**：

- 实现者说「我跑过了，没问题」——但跑的是改过之后的脚本，或者干脆是嘴上说的
- 验收者事后放宽了门槛——因为原来的门槛过不去
- 真实失败被包装成「环境问题」——然后重试三次，每次都记成通过

本插件的做法是**把顺序反过来**：先让验收标准落成带哈希的不可变文件，之后每一次执行都只能按冻结过的判据 id 进行，执行结果由代码自己记账，裁决不看任何人的自我评价。

---

## 核心机制

四步，每一步都堵死一种作弊路径。

### 1. 冻结 `kit_freeze`

把判据写进 `<workspace>/.protocol-kit/<run_id>/oracles.json`，同时记录**内容哈希**。冻结后：

- 再次冻结同一个 `run_id` 会被拒绝（一个 run 只能冻一次）
- 判据里点到的每个本地文件（脚本、数据、基线）都会记下 `sha256` + 字节数
- 冻结之后**一行代码都还没写**，门槛就先定死了

### 2. 执行 `kit_exec`

只接受**判据 id**，不接受临时指定的命令。

执行前做两件事：先校验判据文件哈希，再校验它引用的每个本地文件的哈希。任何一项对不上就直接拒绝执行——**不是警告，是不跑**。

预算在预留阶段就消耗，失败不退。

### 3. 裁决 `kit_gate`

把「真实执行回执」和「人工/LLM 评审结论」分开收集，再统一裁决。四种结果：

| 裁决 | 含义 |
|---|---|
| `pass` | 全部可执行判据通过，人工判据也有明确结论 |
| `rejected` | 有硬失败（退出码不对、超时、起不来）——**人工评审传 pass 也拦不住** |
| `insufficient-evidence` | 证据不足：缺回执、缺引用 |
| `blocked-on-human` | 在等人，**不算失败** |

人工判据的结论必须以结构化形式传入，并带 `evidence_refs`。评审说自己过了但给不出引用，就是没过。

### 4. 归因 `kit_failures`

每类失败绑定固定的回退目标，避免「所有失败都当成 bug 再实现一遍」：

`requirement-misread → clarify`、`design → design`、`implementation → implement`、`evidence-gap → evidence`、`oracle-gamed → freeze`、`infrastructure → no-replay`

---

## 实测：两种作弊都被挡住了

**篡改判据脚本**——把 `check-pass.mjs` 里的一个字符串改掉，再执行：

```
判据「L0-pass」引用的文件在冻结后被改过，判定已不可信，拒绝执行：
check-pass.mjs：期望 7678979105da…，实际 58eee9e63492…
```

**硬门 vs 人情**——判据 `L0-fail` 退出码 1，同时给人工判据传 `verdict: "pass"`：

```json
{ "verdict": "rejected", "blocking": [{ "id": "L0-fail", "reason": "failed", "exit_code": 1 }] }
```

裁决不读自我评价，也不做「综合判断」。

---

## 工具清单

11 个工具，前缀 `kit_` 是早期名字 `protocol-kit` 的遗留，功能上属于本插件，改名时保留以保持与既有产物的兼容。

### 执行内核

| 工具 | 作用 |
|---|---|
| `kit_freeze` | 冻结判据。支持直接传 `oracles`，或传 `acceptance` 由 `src/kernel/compile.js` 编译；`dry_run` 只编译不落盘 |
| `kit_exec` | 按判据 id 执行，写回执 |
| `kit_gate` | 四态裁决 |
| `kit_failures` | 记录 / 检索失败归因 |

### 查看进度

| 工具 | 作用 |
|---|---|
| `kit_status` | 一次回答「这个 run 跑到哪一步」：哪些判据通过/失败/未跑、七个预算桶各剩多少、下一步该做什么。纯只读，连查三次字节不变 |

### 设计决策（动手前）

| 工具 | 作用 |
|---|---|
| `kit_ping` | 通路自检 |
| `kit_inventory` | 扫描项目既有资产，产出带 `路径:行号` 的证据清单 |
| `kit_design` | 生成 P1–P4 决策协议脚本（需求澄清 → 强制发散 → 对抗评审 → 收敛裁决） |
| `kit_run` | 直接执行 P1–P4，省掉脚本搬运 |
| `kit_domain` | 领域包 list / show（backend、frontend、numeric、architecture） |

### 数值

| 工具 | 作用 |
|---|---|
| `kit_numeric` | 比较两条曲线，给相对误差、覆盖率、最差点。即时比较，不记账不裁决 |

---

## 快速开始

```js
// 1. 冻结：先把门槛定死，此时实现代码一行没写
kit_freeze({
  root: "/abs/path/to/project",
  run_id: "add-pagination",
  acceptance: [
    { criterion: "类型检查通过", level: "L0", check: "npx tsc --noEmit" },
    { criterion: "分页行为正确", level: "L1", check: "npm test -- pagination" },
    { criterion: "代码风格一致", level: "L2" }  // 人工判据，无命令
  ]
})

// 2. 执行
kit_exec({ root: "...", run_id: "add-pagination", oracle_id: "L0-typecheck" })

// 3. 裁决（人工判据的结论由人/另一 agent 给出）
kit_gate({
  root: "...",
  run_id: "add-pagination",
  reviews: [{ oracle_id: "L2-style", verdict: "pass", veto: false, evidence_refs: ["src/table.tsx:12"] }]
})

// 4. 随时看进度
kit_status({ root: "...", run_id: "add-pagination" })
```

产物落在 `.protocol-kit/<run_id>/`：

```
oracles.json     # 冻结的判据（含哈希）
ledger.jsonl     # 预算账本：每笔预留与消耗
receipts/        # 每次真实执行的退出码、输出哈希、耗时
failures.jsonl   # 失败归因
```

全部是纯文本，可以直接 `git diff` 审计。

---

## Requirements

⚠️ **这是 DSH 插件，不能独立运行。**

- 需要 **DSH（DeepSeek Harness）** 宿主环境，`@deepseek-ai/dsh-tools` 由宿主进程解析
- 直接 `node` import 会找不到该模块，属正常现象
- Node.js ≥ 22

如果只是想读它的设计思路和源码，无需安装任何东西——`src/kernel/` 与 `src/tools/` 是可独立阅读的纯 ESM。

## 安装

```bash
# 1. 克隆
git clone https://github.com/CresBigB/dsh-oracle-gate.git

# 2. link 进你的 DSH profile（不同平台 profile 目录不同，例如 ~/.dsh/profiles/desktop）
cd ~/.dsh/profiles/desktop
corepack pnpm add "link:/abs/path/to/dsh-oracle-gate"

# 3. 把 "dsh-oracle-gate" 加进该目录 package.json 的 dsh.profile.bundles 数组

# 4. 重启 DSH Desktop
```

`link:` 安装是指向源码目录的软链接，改代码即时生效，不需要重装。

**`peerDependencies` 的版本区间必须覆盖宿主当前内核版本**，否则插件会被**静默跳过**（无报错、工具直接消失）——这是最容易踩的坑。判断方法：对比同 profile 下能加载与不能加载的插件，看宿主版本是否落在区间内。

---

## 设计边界

**能做到的**（可验证的硬约束）：

- 判据冻结后不可修改，改判据文本被 `oracles.json` 哈希检出，改脚本体被文件哈希检出
- 执行只能按判据 id 进行，禁止任意命令
- 硬门优先于人工评审
- 预算预留即消耗，失败不退
- 全流程产物可审计

**做不到的**：

- **只锁一层**——判据引用的文件在锁内，它 `import` 的其它模块不在锁内
- 无法判断「这个判据写得对不对」。判据本身写得同义反复（比如断言「与函数本身返回值相等」），插件只能忠实执行它
- 无法阻止人在冻结**之前**就把门槛定得很低——它保证的是「定下来之后不能改」，不是「定得合理」

---

## 安全边界

插件运行在宿主进程内，**拥有完整 Node 权限，没有沙箱**。因此：

- 所有写文件逻辑自带路径围栏，只往 `<root>/.protocol-kit/` 下写
- 不发起任何网络请求
- 不读取 `root` 之外的路径
- 不记录密钥、令牌

---

## 目录结构

```
src/
├── index.js              # 插件入口：name / inject / apply
├── adapters/             # 领域包：backend / frontend / numeric / architecture
│   ├── index.js          # listDomains / loadDomain / validateDomain
│   └── <domain>/domain.json
├── kernel/               # 与领域无关的执行内核
│   ├── compile.js        # acceptance → oracles 编译
│   ├── oracles.js        # 冻结、哈希、文件锁
│   ├── receipt.js        # 回执读写
│   ├── ledger.js         # 预算账本
│   ├── gate.js           # 四态裁决
│   ├── status.js         # run 状态汇总（纯函数，不 import fs）
│   ├── failures.js       # 失败归因
│   ├── numeric.js        # 数值比较内核
│   ├── run.js            # run 目录约定
│   └── scan.js           # 文件遍历与分类
├── protocols/            # P0 资产盘点、P1–P4 设计协议
└── tools/                # 11 个工具的实现
```

领域包只影响「设计阶段注入哪些视角与验收维度」，**执行内核完全不知道领域包的存在**。

---

## 测试

```bash
npm test
```

10 个测试文件、19 个用例，覆盖内核、裁决、状态渲染、数值比较、领域包校验、文件锁。全部用本地临时目录，不联网、不启动子代理、不消耗 token。

---

## License

[MIT](LICENSE)
