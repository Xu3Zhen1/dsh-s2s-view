# 账本备份与 schema 升级纪律（T25）

**适用对象**：`dsh-s2s` 的消息账本（`S2sLedger`，域 `s2s`，格式版本 `1`）
**日期**：2026-10-05（初稿）· **2026-10-09 更正（见 §1.1）**
**依据**：计划书 T25 —— 「文档写明 json/sqlite 的底层文件路径；升级演练一次」

---

## 1. 底层文件在哪里：**先说实话，再说将来的话**

### 1.1 本机实况（**2026-10-09 更正**）：账本**已落盘**

> **★ 撤回声明**：本文件 2026-10-05 初稿曾写「本机没有任何账本文件存在」，并据此得出
> **「备份纪律的实际执行对象是空集」**。**该结论已撤回。**
> 撤回原因不是环境变了，而是**当时对症状的归因错了**：当时 `s2s_status` 报
> `none (ledger constructed but not open)`，被解释为「desktop 未挂 `storageDomain`」；
> **真因是 cordis 的生命周期闸**——`_getImpl(name, strict=true)` 在**提供者 fiber 非 ACTIVE
> （`state≠2`）**时扣住服务，而 `open()` 在回调里**当天就取**，那一刻 fiber 还是 1。
> `storageDomain` **一直存在且可用**（实测三个 live probe 恒为 `PRESENT`）。
> 修法 = `open()` 改为**等「store 可用 **且** 我方 ledger 可取」**、有界重试（`30798cf`）。
> 病情与修法的完整取证见 `plan/` 下相关送审/回执；本文件只记录**与备份有关的事实**。

**2026-10-09 实测（as-of 2026-10-09 02:22:23，宿主 `DeepSeek Harness.exe` Start 02:20:14）**：

| 检查项 | 实测结果 |
|---|---|
| 运行中 `s2s_status` 的 `backend=` | **`storage-domain`**（`ledger: open (backend=storage-domain).`） |
| 账本文件路径 | **`~/.dsh/storages/s2s.json`** |
| 该文件是否存在 | **存在**（29864 B，mtime 2026-10-09 02:22:15） |
| 域结构 | `unit.name = "s2s"`、`unit.version = 1`、`tables.messages` / `tables.sessions` |

⇒ **本机账本文件路径这一条现在是实测，不是推断**。但**引用其大小/记录数必须标 as-of 时刻**——
该文件在持续写入，实测同一文件在不同时刻为 **7430 B → 17233 B → 21008 B → 25591 B → 29864 B**。
**任何"账本有多大/多少条"的说法，缺 as-of 即不可复核。**

### 1.2 两种后端各自的落点（按谁来定路径区分）

账本自己**不配置路径**——`src/ledger.ts` 只通过 `ctx.get('storageDomain')` 拿到宿主已挂载的设施，路径由**宿主 profile** 决定。因此：

| 后端 | 路径由谁决定 | 落点 | 本项目实况 |
|---|---|---|---|
| **A. `storageDomain` + sqlite**（计划书 Q2 选定） | 宿主 profile 里 sqlite backend 的 `path` 配置（键名就是 `path`） | 该 `path` 指向的单个 SQLite 文件 | **不是当前实况**（本机走的是 B） |
| **B. `storageDomain` + JSON**（宿主已提供） | 同上，JSON backend 的**目录**配置（`root`） | `root` 下**每个 unit 一个 `<unit>.json`**（`single` 布局）或 `<unit>/` 树（`per-record`） | **★ 当前实况**：`root = ~/.dsh/storages`，unit `s2s` → **`s2s.json`**（`single`） |
| **C. 自建 JSON**（计划书 §R7 备案的降级路径） | 本项目自定 | 迄今**未实现** | **未实现，且已裁定不实现**（见下） |

**★ 一条重要的实测修正（写给后续维护者）**：计划书 R7 / §955 把"降级"写成**自建 JSON**，但**宿主已经自带 `@deepseek-ai/dsh-storage-json`（JSON 文件 KV 后端）**。**2026-10-09 补充**：本机**实际跑的就是这个后端**（`backend=storage-domain`，落点 `~/.dsh/storages/s2s.json`）⇒ 该"降级路径"的**前提（宿主后端缺席）已被证伪**。审查方裁定：**Q9 收口为「后端缺席时的未来降级备案」，当前不切自建 JSON。**

**⇒ 运维含义（已更正）**：**备份纪律的实际执行对象不再是空集**——本机确有账本文件
`~/.dsh/storages/s2s.json`，**应当纳入备份**。但请注意两点：
1. **它可能是惰性创建的**：`dsh-storage-json` 的 `openUnit()` 只无条件 `mkdir(root)`，
   **unit 文件按首次写入才落**。⇒ `backend=storage-domain` 但文件尚不存在是**正常**的
   （实测：账本打开后、写入第一条消息之前，`~/.dsh/storages/` 顶层仍为原基线 3 项）。
   **看不到文件 ≠ 没在跑**。反过来，**看到文件才是"已写入过"的证据**。
2. **文件在持续增长**：引用大小/记录数须带 as-of 时刻（见 §1.1）。

### 1.3 备份操作（可照做，**2026-10-09 起本机已适用**）

1. **先确认文件真的出现了**，不要假设：
   - 读 `s2s_status` 的 `backend=` 行 —— 应为 `storage-domain`（而非 `none (…)`）；
   - 再到 `root`（本机 `~/.dsh/storages/`）下看 **`s2s.json`** 是否存在、大小是否非 0。
   - ⚠️ **`backend=storage-domain` 但文件不存在是可能的**（惰性创建，见 §1.2）——
     此时**先投递一条消息触发首次写入**再复查，不要直接判"没落盘"。
2. **备份 = 在停机状态下整文件复制**（JSON 是**整文件原子替换**语义，见 §1.4；仍**必须在宿主停止、
   或至少没有写入时**做 —— 运行中热拷可能抓到替换的中间态）。
   ```
   # 停机后（Windows）
   copy "%USERPROFILE%\.dsh\storages\s2s.json" "%USERPROFILE%\.dsh\storages\s2s.json.bak-<YYYYMMDD-HHMMSS>"
   ```
3. **备份后必须验证**，不是复制完就算：
   - 大小非 0；
   - 记录备份文件的 SHA256 与时间戳，作为回滚凭据；
   - **同时记下该时刻的 as-of**（文件在增长，缺时刻的读数不可复核）。
4. **命名与保留**：`.bak-<时间戳>` 后缀（与 profile 现有 `*.bak-2026xxxx` 惯例一致）；升级前的那一份**在验证新版本可用之前不要删**。

### 1.4 写入协议：为什么"await 返回"就等于"已落盘"

`@deepseek-ai/dsh-storage-json` 的 `writeAtomic()`（`packages/storage/storage-json/src/atomic.ts`）协议：

```
写同目录临时文件  →  handle.writeFile(data)  →  await handle.sync()   ← fsync，强制刷盘
                 →  await handle.close()
                 →  await rename(tmp, target)   ← 原子替换（Windows 映射 MoveFileExW REPLACE_EXISTING）
                 →  fsyncDirectory()            ← POSIX 下 fsync 父目录（Windows 跳过）
```

其文档注释写明：*"@returns resolution after the replacement is **crash-durable**"*。

⇒ **写入路径的 `await` 返回即已落盘**，验收时**无需额外等待重启**即可判定写入成功。
这一条是 2026-10-09 实测确认的（该次验证：唯一标记写后由独立磁盘读回命中）。

---

## 2. Schema 升级纪律

### 2.1 两条硬规则

1. **只增字段（additive-only）**。新增字段必须是 **optional 或带 `default`**，这样**旧文件无需迁移**即可被新代码读取。
   - 本仓库已有先例：T23 给 `messageRecordSchema` 加的 `revision: z.number().int().min(0).default(0)` —— **带默认值**，所以在此字段出现之前写的行**仍能加载**（缺值按 `0` 处理）。这正是"只增字段"的正确做法。
2. **破坏性改动必须 `bump LEDGER_DOMAIN_VERSION`**（`src/ledger-schema.ts`）。该常量注释写明：*Bumped only for breaking layout changes*。改版本号 = 明确声明"旧文件不再被本版本读"。

### 2.2 升级四步（可照做）

| 步 | 动作 | 判据 |
|---|---|---|
| 1 | **备份**底层文件（见 §1.3），记录 SHA256 + 时间戳 | 备份存在、大小非 0 |
| 2 | **改 schema**：优先加 optional/带 default 字段；若确需破坏性改动，同时 bump `LEDGER_DOMAIN_VERSION` | `pnpm run typecheck` 0 错 |
| 3 | **起新版本、读旧文件验证**（若为非破坏性，这一步必须能直接过） | `s2s_status` 的 `ledger:` 行为 `open`；`s2s_reconcile` 不报 invalid-record |
| 4 | **回滚演练**：用第 1 步的备份替回底层文件，确认旧版本仍能起来 | 见 §3 |

### 2.3 为什么 `invalidRecords` 是 `reject`（且**不要**改成 skip）

`ledgerDomain` 的 `invalidRecords` **刻意保持默认的 reject**（源码注释已论证）：`messages` 是**权威数据**，悄悄丢掉"能解释某次投递的那一行"，正好把这个账本存在的意义抹掉。代价是**一行损坏的 `sessions` 也会挡住整个 open**。

⇒ **取舍已明示**：宁可 open 失败并**指名哪张表哪个 key**（可诊断），也不要静默丢行（不可诊断）。若将来要放宽，注意该选项是**域级、非表级**，无法只对 `sessions` 放宽。

---

## 3. 升级演练（T25 要求"演练一次"）

**演练对象**：本仓库**实际使用**的 `storageDomain` + sqlite（测试环境），因为生产 `desktop` 未挂载后端、没有可演练的文件。

**演练设计**：用**真实的 sqlite 账本**验证「旧文件被新代码读取」与「回滚能恢复」两件事，不依赖生产环境。

| 步 | 动作 | 期望 |
|---|---|---|
| 1 | 建账本、写若干行（含 `status` 各态），关闭 | 文件存在、大小非 0；记录 SHA256 |
| 2 | **备份**该文件 | `.bak-<ts>` 存在、大小一致 |
| 3 | 用**新增字段后**的 schema 重新打开**旧文件** | open 成功；旧行可读；新字段取默认值 |
| 4 | 再写入新行、关闭 | 成功 |
| 5 | **回滚**：把 `.bak` 替回原路径，用**加字段前**的代码打开 | open 成功；旧行原样可读；**回滚有效** |

**已实现的自动化**：见 `tests/ledger-backup.spec.ts`（本次新增）。该文件把上述五步固化为可重复执行的用例，其中第 5 步是**真正的回滚验证**（用备份文件恢复并重新打开），而不是只断言"备份文件存在"。

**★ 该演练证明什么、不证明什么**：

- **证明**：非破坏性（加带默认值字段）升级下，**旧文件无需迁移即可被新代码读取**；且**备份文件确实可用于回滚**。
- **不证明**：破坏性升级（bump 版本号）的迁移路径 —— 那需要专门写迁移代码，本项目**当前没有、也暂不需要**（尚无破坏性改动）。**不要把这条演练读成"任何升级都能安全回滚"。**

---

## 4. 一句话运维摘要

> **当前部署没有账本文件**（未挂 storage 家族），备份纪律的实际执行对象是空集。
> **挂载后**：路径由 profile 的 backend 配置决定（账本自己不设路径）；备份 = **停机整文件拷贝 + 验证大小 + 记 SHA256**；**升级只增字段（optional/带 default）**，破坏性改动才 bump `LEDGER_DOMAIN_VERSION`；**升级前必留一份备份，验证新版本可用之前不删**。
> **降级路径的修正待拍板**：宿主自带 `dsh-storage-json`，优先复用而非自建（计划书 R7 原写"自建 JSON"）。
