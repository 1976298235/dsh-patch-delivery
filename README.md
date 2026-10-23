# DSH Patch Delivery

让 DSH 子代理交付可审阅补丁和实际测试证据。保留通用 MCP 会话桥，在独立 Git worktree 中完成代码任务，主代理审阅后显式接纳。

Version 1.2.0 · MIT · Node.js 22+ · Git · 无第三方运行时依赖。

## 工作流程

1. `dsh_list_verification_recipes {}`：查看插件所有者配置的测试命令。
2. `dsh_start_delivery {repo, text, allowed_paths, verification_ids, idempotency_key}`：要求原仓库干净，包括未跟踪文件；在独立 detached worktree 中提交任务，保存 delivery_id。可选 agent_preset 指定实际工作模式。
3. `dsh_get_delivery {delivery_id}`：查询同一个任务，不重复提交。
4. `dsh_collect_delivery {delivery_id}`：任务正常结束后，程序持久化 binary patch 和文件 SHA256，在第二个“干净基线＋该补丁”的 worktree 中执行测试，保存真实命令、退出码和日志。返回 manifest_path。任务工作副本中的 ignored 辅助文件不会被带入验证副本。
5. 主代理检查补丁和证据；获得用户任务范围内的接纳授权后调用 `dsh_accept_delivery {delivery_id}`。
6. 接纳要求测试通过、证据未变、原仓库 clean 且 HEAD 和仓库身份未变。通过 git apply --check 后应用，保留为未提交改动。

`dsh_reject_delivery` 标记已结束的交付为拒绝，保留 worktree 和证据。它不会取消正在运行的任务；取消使用对应 session_id 的 `dsh_cancel`。

示例（路径需要替换为实际仓库；目录范围以 / 结尾，不支持通配符）：

```json
{
  "repo": "C:/projects/example",
  "text": "修复 src/add.js 的边界条件，补充对应测试。不要改其他文件。",
  "allowed_paths": ["src/", "test/"],
  "verification_ids": ["node-test"],
  "idempotency_key": "unique-task-key"
}
```

## 安装与配置

这是 DSH Cordis bundle，需在 DSH 中加载。市场分发包名为 `dsh-patch-delivery`；本机已有链接包可继续使用 `@local/dsh-mcp-server`。尚未发布到 npm。安装替代旧 MCP 桥时避免同时启用两个相同路径的服务。

MCP 端点为 DSH 当前 Web 地址加 `/mcp`，健康检查为 `/mcp/health`。端口由 Host 决定，可能每次启动变化，不保证为 5619。支持 Streamable HTTP JSON，协议 2025-06-18，无 GET SSE。

在对应插件行的 config 中配置可信验证命令：

```yaml
path: /mcp
token: ''
exposeApprovals: true
waitTimeoutMs: 120000
# 默认省略 stateDirectory 时为 ~/.dsh/mcp/dsh-mcp-server
# 必须位于源仓库之外；false 关闭持久化及全部6个交付工具
verificationRecipes:
  - id: node-test
    executable: 'C:/Program Files/nodejs/node.exe'
    args: ['--test']
    timeout_ms: 60000
    protected_paths: ['test/', 'tests/', 'package.json']
```

默认 verificationRecipes 为空；未配置前无法开始交付任务。可执行文件必须为绝对路径，参数是字符串数组，超时为 1000–120000 毫秒。命令以新建的验证副本为 cwd，shell=false。可通过 recipe.env 显式添加环境变量；默认只传 PATH、系统目录、临时目录、用户主目录和语言相关变量及 CI=true，不继承完整 Host 环境。调用者只能选择 ID，不能传入任意 shell 命令。可选 protected_paths 是所有者设定的不可修改输入，命中即拒绝收集，调用者 allowed_paths 不能覆盖它；未配置保护时，测试本身可能属于被修改的补丁，主代理须审查测试改动，不能把“退出0”解读为通过了未修改的原测试。请只配置自己信任的测试；项目代码和测试均在本机运行。

## 持久化与恢复

runtime.json 保存任务及幂等回执；deliveries.json 保存交付记录。使用校验和、临时文件替换和单进程锁。损坏或活跃写入锁会拒绝加载；不会清空数据重新开始。每类最多500条，已完成的回执及终态任务可在24小时后清理，交付历史不会自动删除。

重启/重载后，相同 key 和参数返回原回执。未知提交不会自动重发：有 task_id 时观察真实 Host 事件；无可恢复句柄时返回 OPERATION_UNCERTAIN，要求人工核实。completed 只表示 Host 回合正常结束；交付仍必须通过独立验证。

接纳前先保存 applying 状态。恢复时，仅在原仓库改动补丁与预期完全一致时记录 accepted；否则 APPLY_UNCERTAIN，保留现场，不自动重试、回滚、提交、合并或推送。验证前持久化补丁快照；collecting 中断后，显式 collect 从该快照重建新的干净验证副本，可能重新执行测试，绝不把被测试污染的验证副本当作新补丁。缺少快照时返回 COLLECTION_INTERRUPTED。collection_failed 与 verification_failed 不自动重试；先检查证据和工作副本。未知提交可从已有回执只读恢复 task_id；无法恢复时可 reject 并标记 unresolved_execution，这不会取消仍可能运行的任务。

## 工具

默认共36个 MCP 工具：原有28个会话、文本/附件、任务查询、模型、工作目录、工作区、上下文压缩、日志、余额、审批及工具发现，加上6个交付工具和2个模式工具。stateDirectory=false 时保留30个。

`dsh_list_presets {}` 读取 Host 真实工作模式及默认项；`dsh_select_preset {session_id, agent_preset}` 仅能切换尚未开始第一轮的会话，Host 会拒绝已有对话的切换。已有会话需要新建会话并在 create_session 或 start_delivery 中指定 agent_preset。这些工具不修改全局默认模式，也不自动批准操作。

普通子代理任务可继续使用 `dsh_create_session {cwd, switch:false, idempotency_key}`、`dsh_send_text {session_id, text, wait:false, idempotency_key}`，再以 `dsh_get_task` / `dsh_wait_task` 查询 task_id。wait_task 最长60秒。始终显式传 session_id。

`dsh_read_conversation {session_id, after_seq, limit}` 返回 next_cursor 和 has_more；按游标增量读取。模型切换、命令执行及审批仍沿用 Host 行为。不要自动批准不在用户任务范围内的操作。

## 边界

- worktree 是工作副本隔离，不是操作系统沙箱。Agent 和测试仍受 Host 原生权限约束，并共享仓库 Git 元数据。路径范围检查约束收集和接纳，不承诺阻止 agent 的所有越界访问。
- 不支持交付 symlink 或 submodule 的改动；拒绝路径穿越与 symlink 父路径。忽略文件、仓库依赖和构建缓存不打包，也不从 agent 副本复制到验证副本；需要的依赖准备应明确放入可信 recipe。完整运行环境不打包。
- 校验和用于发现意外损坏，不是对同一用户恶意篡改的认证。接纳与外部编辑器之间仍存在竞态；它不是文件系统事务，也不承诺副作用严格一次。
- 验证超时终止直接进程，不保证终止它创建的全部子进程。不要配置会后台驻留的命令。
- worktree、日志和交付记录保留供审阅，当前无自动清理界面。达到容量上限时停止新任务。
- MCP 挂在 Host Web 服务上；请使用本机监听或受控网络，并配置 token。非回环 Origin 请求拒绝；无 Origin 的本机脚本可连接。审批桥默认启用，可用 exposeApprovals=false 关闭。

## 测试

```sh
npm test
```

包括27项持久化/交付/模式测试及70项原有协议检查。使用临时 Git 仓库、假 Host 和本机 HTTP 服务；不需要调用模型。测试夹具保留在系统临时目录，可通过 DSH_TEST_ROOT 指定已有目录。真实 DSH 模型联调需单独执行，离线检查不能替代真实 Host 验收。

## English

DSH Patch Delivery adds an isolated code-delivery workflow to the live DSH MCP bridge: detached Git worktrees, binary patches, SHA256 file records, actual owner-configured verification commands and logs, durable receipts, and explicit adoption against an unchanged clean baseline. Changes remain uncommitted. Worktrees are not security sandboxes. No automatic merge, push, approval, or uncertain resubmission is performed.
