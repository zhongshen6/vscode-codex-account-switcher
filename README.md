# Codex 账号切换器

一个简单、轻量的 VS Code 扩展，用来切换 Codex 账号。

它不做复杂面板，也不接管整套工作流，主要就是解决几个实际问题：

- 快速切换已保存账号
- 顺手看一下账号配额
- 在需要时自动续期非当前账号
- 切号后把 Codex 侧边栏真正重载起来

## 功能

- 从固定目录读取已保存的账号记录
- 通过选择框显示账号邮箱、用户名、套餐、配额和最近检查时间
- 将所选账号的认证文件写入当前 Codex 配置目录
- 支持删除已保存账号
- 支持自动检查配额，并将最近一次结果持久化到账号文件
- 支持对非当前账号自动续期 `access_token`
- 支持应用或恢复 Codex 重载补丁
- 切号后可自动重载 Codex 侧边栏，避免只切换认证文件但前端未刷新

整体设计偏“够用就好”：

- 没有复杂 dashboard
- 没有额外服务进程
- 没有数据库
- 基本围绕 `auth.json` 和保存账号目录工作

## 默认路径

- Codex 主目录固定为 `~/.codex`
- 已保存账号目录固定为 Codex 主目录同级的 `.codex-accounts`

## 已保存账号的目录结构

```text
.codex-accounts/
  账号名__account-id.json
```

扩展会在保存的账号 JSON 中写入自己的私有元数据，用于缓存最近一次配额结果和检查时间。切换到活动账号时，这些元数据不会写入 `~/.codex/auth.json`。

## 选择框说明

- 第一排：账号邮箱
- 第二排：用户名
- 第三排：套餐 | 配额状态 | 相对时间

配额显示规则：

- `5h` 配额不存在时隐藏
- `周` 配额始终显示
- `审查` 配额为 `100%` 时隐藏
- 时间显示为相对时间，例如 `3分钟前`、`2小时前`、`5天前`

## 设置项

- `codexAccountSwitcher.autoReloadCodexAfterSwitch`
- `codexAccountSwitcher.autoRefreshTokensForInactiveAccounts`
- `codexAccountSwitcher.autoRefreshQuota`
- `codexAccountSwitcher.quotaRefreshIntervalMinutes`
- `codexAccountSwitcher.quotaRequestMinIntervalMs`
- `codexAccountSwitcher.sortBy`
- `codexAccountSwitcher.sortDescending`

选择框右上角的设置按钮会直接打开本扩展的设置页。

排序说明：

- 当前账号固定置顶
- `sortBy = quota` 时，先按 `5h` 配额排序，再按 `周` 配额排序
- 配额排序里，没有 `5h` 的账号按 `0` 处理
- 配额排序里，`查询失败` 的账号会排在最后
- `sortDescending = false` 时低额度在前，`true` 时高额度在前

## Codex 补丁

补丁用于解决切号后官方 Codex 扩展前端不完整重载的问题。当前实现会在切号后：

- 重启 Codex 进程
- 关闭旧的 Codex 编辑器页面
- 重载 Codex sidebar webview

如果不需要这个行为，可以在设置中关闭自动重载，或手动恢复补丁。

## 最近更新

- 新增账号配额显示，选择框现在会显示套餐、5h/周/审查额度和最近检查时间
- 新增非当前账号自动续期，过期账号在检查配额或切换前可自动刷新 token
- 新增配额缓存持久化，重启 VS Code 后仍可直接显示上次成功查询的结果
- 后台刷新改为每分钟巡检，到期账号会自动补查，不用等整段固定定时器
- 新增失败重试策略，连续失败多次后标记为查询失败并降低重试频率
- 优化选择框显示规则，隐藏无效 5h、隐藏 100% 审查，并改为相对时间显示
- 新增选择框右上角设置按钮，可直接打开本扩展设置页
- 新增 5 个可配置设置项，包括自动重载、自动续期、自动刷新和请求间隔
- 切号后 Codex 重载补丁已完善，前端现在会整页重载并恢复可用
- 移除无用的 `config.toml` 切换代码，并更新 README 与扩展说明

## 本地调试

1. 在 VS Code 中打开本扩展目录。
2. 按 `F5` 启动 Extension Development Host。
3. 在新窗口里点击状态栏中的 `Codex` 按钮。
