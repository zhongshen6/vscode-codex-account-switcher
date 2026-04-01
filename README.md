# Codex 账号切换器

一个用于切换 Codex 账号的 VS Code 扩展，会在状态栏提供入口按钮，并支持配额查看、自动续期和 Codex 热重载。

## 功能

- 从固定目录读取已保存的账号记录
- 通过选择框显示账号邮箱、用户名、套餐、配额和最近检查时间
- 将所选账号的认证文件写入当前 Codex 配置目录
- 支持删除已保存账号
- 支持自动检查配额，并将最近一次结果持久化到账号文件
- 支持对非当前账号自动续期 `access_token`
- 支持应用或恢复 Codex 重载补丁
- 切号后可自动重载 Codex 侧边栏，避免只切换认证文件但前端未刷新

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

选择框右上角的设置按钮会直接打开本扩展的设置页。

## Codex 补丁

补丁用于解决切号后官方 Codex 扩展前端不完整重载的问题。当前实现会在切号后：

- 重启 Codex 进程
- 关闭旧的 Codex 编辑器页面
- 重载 Codex sidebar webview

如果不需要这个行为，可以在设置中关闭自动重载，或手动恢复补丁。

## 本地调试

1. 在 VS Code 中打开本扩展目录。
2. 按 `F5` 启动 Extension Development Host。
3. 在新窗口里点击状态栏中的 `Codex` 按钮。
