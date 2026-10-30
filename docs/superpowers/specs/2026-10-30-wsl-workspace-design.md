# 本机 WSL 工作区支持（design）

日期：2026-10-30
状态：待评审
范围：dsh-remote 新增 `wsl` 接入后端（v1 核心闭环）

## 1. 背景

dsh-remote 现在只有两条 SSH 接入后端（`native` / `openssh`），所有能力都建立在
「连接一台远端 → SFTP 读写 → 镜像到本地 → 会话在该镜像里工作」这条链路上。

Windows 上大量项目实际跑在 WSL 发行版里。用户目前的绕法是：

1. 在 WSL 里安装并配置 sshd，再按 SSH 机器接入（步骤多、端口与凭据要自己管）；
2. 或者把项目复制到 Windows 侧，失去 WSL 的运行时。

WSL 对 Windows 进程暴露了 UNC 路径（`\\wsl.localhost\<发行版>\...`，旧系统为
`\\wsl$\...`），并且可以用 `wsl.exe -d <发行版>` 执行命令。这让「WSL 当工作区」
不需要 SSH：文件用 Node `fs` 直接读写 UNC，命令用 `wsl.exe` 执行。

## 2. 目标与非目标

### 目标（v1）

- 在 Windows 上自动发现本机 WSL 发行版，一键添加为 dsh-remote 机器。
- 在选择器里浏览 WSL 目录，把任意目录镜像成本地工作区。
- 在镜像会话里，全部文件工具（`rw_list_dir` / `rw_stat` / `rw_read_file` /
  `rw_write_file` / `rw_edit` / `rw_append` / `rw_mkdir` / `rw_remove` /
  `rw_move` / `rw_search` / `rw_download` / `rw_upload` / `rw_sync` /
  `rw_push`）与 `rw_exec` 正常工作。
- 复用已有的身份、镜像、绑定、会话标记与冲突同步逻辑，不复制一套。

### 非目标（v1 明确不做）

- 嵌入终端（`shell()` / PTY）：插件没有 `node-pty` 依赖。
- 端口转发：WSL2 自带 Windows → WSL 的 localhost 转发，SSH 隧道无必要。
- 一键体检 / 部署：不在 WSL 内安装 dsh。
- 远端 DSH 界面挂载。
- 非 Windows 平台：入口整体隐藏。
- WSL1 与自定义 `wsl.conf` 的高级场景不做特殊处理，按 UNC 是否可用来判断可用性。

## 3. 身份模型

WSL 机器就是普通机器记录，新增 `kind` 字段：

```jsonc
{
  "id": "m-...",
  "kind": "wsl",           // 缺省视为 "ssh"，旧记录无需迁移
  "name": "Ubuntu",
  "host": "wsl:Ubuntu",    // 复用 host 承载发行版，天然与 SSH 主机名不相撞
  "port": 0,
  "username": "",
  "workspace": "/home/me/proj",
  "createdAt": "..."
}
```

**为什么用 `host = "wsl:<发行版>"` 而不是给 `poolKey` / `identityOf` 加 `kind` 参数：**

- `poolKey` 的格式被测试固化（`u@h:22`），改格式会波及 `binding.test.js`、
  `session-routing.test.js` 以及所有内存池键。
- 镜像路径由 `mirrorRootFor(host, user, port)` 生成；`wsl:Ubuntu` 经
  `replace(/[^a-zA-Z0-9._-]/g, '_')` 变成 `wsl_Ubuntu`，与 SSH 主机目录天然隔离。
- `identityMatches` / `machineRecordFor` / `resolveMirror` 只比较
  `host/port/username`，WSL 记录直接落在既有逻辑里。

需要做 `kind` 分支的位置：

| 位置 | 行为 |
| --- | --- |
| `withSshConfig()` | `kind === 'wsl'` 时原样返回，不查 `~/.ssh/config`（避免发行版名被当成 Host） |
| `machinesForClient()` | 不计算 `sshConfigResolved`，附加 `kind` 与 `wslDistro` |
| `ensureMirror()` | meta 增加 `kind`；恢复会话时据此选后端 |
| `rw_machines` | 输出 `kind`，WSL 行显示「本机 WSL」 |

`resolveMirror` 的 meta 兼容性：旧 meta 没有 `kind`，读取时缺省为 `ssh`。

## 4. 传输层

新增 `lib/wsl.js`，导出 `listDistros()`、`wslPathToUnc()`、`WslSftp`、`WslPool`、
`isWslBackend()`。

### 4.1 发行版发现

```text
wsl.exe -l -q
```

输出为 UTF-16LE（带 `\0`），按行解码后去掉空行与 `\r`。默认发行版优先用
`wsl.exe -l -v` 中带 `*` 的行判定；该调用失败时退回「`-l -q` 的第一行」。
`running` 字段同样只从 `-l -v` 取，取不到就省略，不影响可用性判断。

### 4.2 路径映射

```js
// Linux 路径 → Windows UNC
wslPathToUnc('/home/me/x', 'Ubuntu')       // \\wsl.localhost\Ubuntu\home\me\x
wslPathToUnc('/', 'Ubuntu')                 // \\wsl.localhost\Ubuntu\
```

- 根优先 `\\wsl.localhost`；首次探测失败（`fs.existsSync` 为假）回退 `\\wsl$`。
- 结果按发行版缓存，`invalidate()` 清空缓存并重新探测。
- 只接受 POSIX 绝对路径；收到 `C:\...` 时报错并提示「WSL 使用 Linux 路径，例如
  /home/you/project」。

### 4.3 `WslSftp`（ssh2 形状的适配器）

实现 `buildSftpSurface()` 需要的原语，用 `node:fs/promises` 直接操作 UNC：

| 原语 | 实现要点 |
| --- | --- |
| `readdir` | `readdir({ withFileTypes: true })`，返回 `{ filename, attrs }`；`attrs` 带 `isDirectory()` / `isSymbolicLink()` / `size` / `mtime`（秒）/ `mode` |
| `stat` / `lstat` | 返回带 `isDirectory()` / `isFile()` / `isSymbolicLink()` 的对象；`mtime` 秒化 |
| `mkdir` / `rmdir` / `unlink` / `rename` | 直接映射 `fs`；`rename` 用 `fs.rename`（Windows 覆盖语义由 `renameOverwrite` 的既有退避处理） |
| `realpath` | `fs.realpath`，结果转回 Linux 路径 |
| `setstat` | `attrs.mode` 存在时 `fs.chmod`；其余属性忽略 |
| `readFile` / `writeFile` | `fs.readFile` / `fs.writeFile` |
| `fastGet` / `fastPut` | `fs.copyFile` |
| `open` / `read` / `close` | 用文件句柄实现，供 `readPartial` 区间读 |
| `on('end'/'close'/'error')` | 继承 `EventEmitter`，`buildSftpSurface` 的失效检测照常工作 |

`buildSftpSurface` 会把 Linux 路径原样传进来（`toSftpPath` 对 POSIX 路径不变），
`WslSftp` 内部统一做 UNC 映射，因此上层看到的始终是 Linux 路径。

### 4.4 `WslPool`

与 `SshPool` 同形，供 `ActivePool` 与 `poolForMachine` 透明使用：

| 方法 | 行为 |
| --- | --- |
| `connect()` | 校验：Windows 平台、`wsl.exe` 存在、发行版在列表里、UNC 根可读。失败抛出可读错误（`未找到 WSL 发行版 "X"`、`无法访问 \\\\wsl.localhost\\X`） |
| `exec(cmd, opts)` | `spawn('wsl.exe', ['-d', distro, '--', 'bash', '-s'])`，命令经 stdin 写入；有 `cwd` 时前置 `cd <shq(cwd)> && `；返回 `{ stdout, stderr, code }`；超时用 `opts.timeoutMs`，超时 kill 并 reject |
| `detect()` | 固定 `platform = 'linux'`、`shellMode = 'native'`；不探测 Git Bash |
| `sftp()` | `buildSftpSurface(new WslSftp(distro), { commandTimeoutMs })` |
| `shell()` | 抛出 `WSL 终端暂不支持（v1）` |
| `close()` / `invalidate()` | 清空 SFTP 与 UNC 缓存，无长连接 |
| `client` 属性 | 首次 `connect()` 成功后设为 `{ wsl: true }`；`ActivePool` 不转发 `client`，所以设置页对 WSL 行显示「本机 WSL」而不是「已连接」（v1 不引入 `ActivePool.client` 改动） |

`exec` 的错误语义与 `SshPool` 对齐：退出码非 0 不抛错，由调用方读取 `code`；
只有 spawn 失败、超时、发行版不存在才 reject。

### 4.5 工厂分派

- `createPool(config)`：`isWslBackend(config)` 时返回 `new WslPool(config)`；
  `isSystemOpenSshBackend` 保持不变。
- `ActivePool._delegateIsCurrent()` 增加 `WslPool` 分支。
- `ActivePool.setTarget()` 的 diff 字段包含 `kind` / `distro`，切换后端时重建 delegate。

## 5. 路由

### 新增

`GET /dsh-remote/wsl`

```jsonc
{
  "available": true,
  "distros": [
    { "name": "Ubuntu", "default": true, "uncRoot": "\\\\wsl.localhost\\Ubuntu", "running": true }
  ]
}
```

不可用时返回 `{ available: false, reason: "..." }`（非 Windows、未安装 WSL、
`wsl.exe` 调用失败），HTTP 仍为 200。

`POST /dsh-remote/machines` 新增 `action: 'from-wsl'`：

- 入参 `{ distro, name? }`，`host = "wsl:" + distro`，`port = 0`，`username = ""`。
- 幂等：已存在同 `host` 的 WSL 记录时直接返回该记录，不重复添加。
- 不写 `~/.ssh/config`。

### 复用（透明）

`/ls`、`/stat`、`/read`、`/write`、`/mirror`、`/home`、`/search`、`/probe` 通过
`pool.sftp()` / `pool.exec()` 工作，WSL 与 SSH 无差别。

`/probe` 对 WSL 执行 `wsl.exe -d <distro> -- true` 并返回
`{ ok, platform: 'linux', latencyMs }`。

## 6. 设置页与选择器

### 设置页

顶部新增「本机 WSL」卡片（`available === false` 时整卡隐藏，不占位置）：

- 每行：发行版名、`默认` 徽章（可选）、`运行中`（可选）、UNC 根（灰色小字）。
- 操作：`添加`（幂等）、`选目录`（打开选择器并预选该机器）、`刷新`。
- 机器列表中的 WSL 记录显示 `WSL` 徽章，副标题显示发行版与默认工作区。
- WSL 机器的编辑表单只保留：名称、默认工作区、删除。SSH 字段与 backend
  下拉全部不渲染（不是禁用）。
- 当前机器是 WSL 时：端口转发区块显示「WSL2 已自带 localhost 转发，无需隧道」，
  体检/部署/远端界面区块隐藏。

### 选择器

- 机器下拉：WSL 机器显示 `Ubuntu（WSL）`，SSH 机器保持 `${name} (${username}@${host})`。
- 选择 WSL 机器后，目录列表走 `/ls`（服务器端 `setTarget` 到 WSL），路径提示为
  Linux 形式（`/home/...`）。
- 提交与镜像流程不变。

### 工具与终端

- `rw_connect`：支持 `machineId`（已保存 WSL 机器）或 `distro: 'Ubuntu'`；
  后者等价于临时连接一台 `wsl:<distro>` 机器。
- `rw_info`：显示 `WSL: Ubuntu`、平台 `linux`。
- `rw_exec`：正常执行；`pty: true` 时明确报错「WSL 暂不支持 PTY」。
- 终端路由与 launcher：WSL 会话直接拒绝并提示，不生成脚本。

## 7. 错误处理

| 场景 | 表现 |
| --- | --- |
| 非 Windows | `/wsl` 返回 `available:false, reason:"仅 Windows 支持"`；卡片隐藏 |
| 未安装 WSL / `wsl.exe` 不存在 | 同上，`reason` 指向 `wsl --install` |
| 发行版已删除但机器还在 | `connect()` 抛 `WSL 发行版 "X" 不存在（wsl -l -q 中未找到）` |
| UNC 不可访问 | 抛 `无法访问 \\\\wsl.localhost\\X，请确认发行版已启动（wsl -d X -- true）` |
| 传了 Windows 路径 | 抛 `WSL 使用 Linux 路径，例如 /home/you/project` |
| `wsl.exe` 卡住 | `exec` 超时 kill，错误信息含超时值 |

所有失败都不得影响插件其余功能：设置页其它区块、SSH 机器、本地会话照常。

## 8. 测试

| 文件 | 覆盖 |
| --- | --- |
| `test/wsl.test.js` | `wsl -l -q` UTF-16LE 解析；`wslPathToUnc`（根、嵌套、非法路径）；`WslSftp` 的 `readdir/stat` 形状与 mtime 秒化（用临时目录模拟 UNC 根）；`WslPool.exec` 的 argv 与 stdin 构造（注入 spawn 桩）；超时；UNC 回退 |
| `test/wsl-routes.test.js` | `/wsl` 可用/不可用；`from-wsl` 幂等；`/machines` 返回 `kind`；不写 ssh config |
| `test/wsl-capability.test.js` | WSL 机器上终端/部署/转发入口返回明确拒绝 |
| 现有测试 | `npm test` 全绿；`client-smoke` 与 harness 的假 document 不受影响 |

集成验证（人工）：在 Windows + WSL 真机上走一遍「添加 Ubuntu → 选目录 →
镜像 → rw_read_file → rw_exec → rw_sync」。

## 9. 风险

- **UNC 依赖 SMB 重定向**：首次访问会唤醒发行版，延迟可达数秒；`connect()` 的
  超时要放宽（默认 15s）。
- **路径大小写与符号链接**：WSL 的 Linux 语义与 Windows 访问层有差异；v1 按
  `fs` 的实际结果处理，不做额外模拟。
- **DSH 升级**：本改动不动 DSH 内部，只依赖 `wsl.exe` 与 UNC 的稳定行为。
- **WSL1**：UNC 通常可用但行为不同，v1 不区分；失败时按错误提示引导用户用 SSH。

## 10. 迁移与兼容

- 旧 `machines.json` 无 `kind`，读取时视为 `ssh`；保存时仅在 WSL 记录上写
  `kind`，不批量改写。
- 旧镜像 meta 无 `kind`，视为 `ssh`。
- 无 WSL 的机器上，所有新代码路径不触发（`/wsl` 返回 `available:false`）。
