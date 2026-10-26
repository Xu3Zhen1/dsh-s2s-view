# dsh-s2s 使用手册

> 同宿主 session 互联 + 静止会话唤醒。裁剪 fork 自 @dpskh/a2a(见 README 鸣谢)。

## 1. 挂载(profile patch)

装**新**插件必须用 **`- insert:`** 形式,且 `name` 指向**可解析的 ESM 入口文件**(不能是目录):

```yaml
- insert:
    - id: dsh-s2s
      name: ./dsh-s2s/lib/index.js
      config:
        lifecycle:
          autoResume: allow         # s2s_resume 用 name(标题)点名即拉起投递
        budget:
          maxHops: 6                # 发送侧防回环
          ratePerMinute: 10
        schedule: {}              # 会话内定时注入(s2s_schedule),可选
```

- `name` 相对 profile 目录解析:把插件 symlink 到 `<profile>/dsh-s2s`,或用 `.dsh/profiles/<profile>/dsh-s2s/lib/index.js`。
- 改配置后**由用户在终端重启对应 profile**(agent 不得代杀前台进程)。

## 2. 配置字段

| 块 | 字段 | 默认 | 说明 |
|---|---|---|---|
| `lifecycle` | `autoResume` | `allow` | 对静止会话:`deny` 仅入信箱;`allow` 拉起+投递 |
| | `mailboxDir` | `~/.dsh/s2s/mailboxes` | 信箱根 |
| `budget` | `maxHops` | 6 | hop 上限,超过拒绝 |
| | `ratePerMinute` | 10 | 每 (from,to) 对每分钟上限 |
| `schedule` | `timerIntervalMs` | 1000 | 会话内定时注入轮询周期(0=禁用) |

缺席的块不挂载(按需加载);`lifecycle`/`budget` 未配置时对应功能关闭。

## 3. 模型工具(9 个)

按「先看清现场 → 再动手 → 再核对结果」排。工具的 `description` 以 `src/tools.ts` / `src/digest.ts` 为准,下表是它的中文转写 + 使用时机。

| 工具 | 作用 | 什么时候用 |
|---|---|---|
| `s2s_peers` | 列**当前项目**内在线的对端会话(标题+状态);默认本项目,`all=true` 列所有项目 | 要发消息/唤醒前,先拿准确的**标题**当地址 |
| `s2s_sessions` | 列**当前项目**内的已知会话(标题+短 id+三态 live-idle/live-busy/dormant);默认本项目,`all=true` 列所有项目 | 需要找 **dormant** 会话(peers 只列 live)或按 `query` 过滤时 |
| `s2s_digest` | 列已知会话**各自停在哪一步**:标题、短 id、最后活动时间、最后事件类型、回合是否仍开着。**只有标题/id/类型/时间,没有消息正文** | 不知道「该找哪个会话接活」时首选;挑出目标后,正文再用 `s2s_history` 或 `session_event_read` 取 |
| `s2s_message` | 按 **name(标题,现读)** 或 `session_id` 发消息(带预算检查);live 会话立即投递,dormant 会话入队,`autoResume=allow` 时同时拉起 | 常规投递。**投递回执 ≠ 已送达**,见下面的 `reconcile` |
| `s2s_resume` | 用 **name(标题)** 点名(主寻址)或 `session_id` 显式唤醒 dormant:入信箱;`autoResume=allow` 则 `AgentRegistry.resume` 拉起并把队列交给它 | 明确要让一个静止会话醒过来并处理堆积消息时 |
| `s2s_status` | **自检**:ledger 后端与是否打开、各会话队列深度、上次 resume 的 preset 结果、history 是否持久。数值是**取样快照**,会漂 | 投递/唤醒行为反常时先跑它——用来区分**真降级**与**静默降级** |
| `s2s_reconcile` | 按 `msgId` 是否真出现在目标**会话日志**里,把已登记投递从 `inboxed` 推进到 `landed`——这就是把「写进信箱」变成「已送达」的判定步骤。可重复调用:进度单调、终态行不复活 | 想知道消息**到底进没进**对方日志时(`s2s_message` 的"queued"只是入队) |
| `s2s_history` | **多源合并**的最近消息:ledger 打开时以 ledger 为权威,目标**会话日志**作为「无存储后端也能跨重启」的兜底,进程内 memory 也参与。每行标 `source`,某源查空会**显式说明**而不是看起来像"没有消息" | 要读消息内容/复盘往来时;也用于 ledger 未登记(untracked)的投递——那些 `reconcile` 看不到 |
| `s2s_schedule` | 会话内定时注入:`list` 列任务 / `create`(`every_seconds` 周期或 `at_iso` 单次)/ `cancel(job_id)` 取消 | 要给**自己或别的会话**安排一个稍后触发的动作 |

## 4. 唤醒静止会话流程(name 为主寻址)

1. `s2s_sessions` 看每个会话的**标题**(即你改的名,如「开发」),不用记 id;**默认只列当前项目**,要看别的项目加 `all: true`(`s2s_message`/`s2s_resume` 仍可按 name/session_id 跨项目点名)。
2. `s2s_resume` `{ name: "开发", text, from? }`:
   - **标题是用户可随时改的**,但解析读的是**缓存的标题**(宿主的零 I/O 投影缓存,`sessionProjectionCache.cachedSnapshot`),所以**改名在下一个标题检查点后生效**,不是同一瞬间;这正是把"每个会话都读一遍日志"从寻址里去掉的代价。要立刻点名刚改名的会话,用它的完整 `session_id`(形如 `session-<uuid>`)。
   - `autoResume=allow`:拉起会话 → `agent.followup`(空闲)/`inject`(忙碌)投递 → 清空信箱。
   - `autoResume=deny`:仅入信箱 `~/.dsh/s2s/mailboxes/<sessionId>/*.json`,会话重开时自动 drain。
   - **同名冲突**:返回 ambiguous + 候选列表,用 `session_id` 精确点名;无匹配:返回 not-found + 所有带标题会话供选。
3. 拉起的会话**保留在 live-idle**(不自动归眠;OQ-5 语义未尽)。

## 5. 验证

- 单元/集成:插件内 `pnpm run typecheck`(0 错)+ `pnpm run test`(473 passed / 44 files)。
- profile 载入:\`dump-config \` 应见 `dsh-s2s` 行且**无** `entry "dsh-s2s" not found`;若开 `hub.server` 可用 `curl <port>/` 看是否监听(404=在监听)。
- 全链路:重启 profile 后,在任一会话的工具列表应出现 `s2s_*` 9 项。

## 6. 限制

- **同宿主/单进程**拓扑;跨进程/跨机 DSH 请用上游 @dpskh/a2a;非 DSH 标准 A2A agent 需网关类插件。
- 与非 s2s 的 mesh(`a2a_*`)勿同挂:双 hub/双工具族/重复 presence。
- 命令面 `/s2s` 已随裁剪移除;live 多会话 join 依赖工具直连与 future broker。
