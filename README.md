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
- 支持自动检查配额，并将最近一次结果持久化到独立元数据文件
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
  .codex-account-switcher-meta.json
```

已保存账号文件使用扁平结构，主字段包含 `type`、`email`、`account_id`、`access_token`、`refresh_token`、`id_token`、`expired`、`last_refresh` 和 `disabled`。

扩展自己的配额缓存和失败状态不再写入账号 JSON，而是统一写到 `.codex-account-switcher-meta.json`，按 `account_id` 建索引。切换到活动账号时，写回 `~/.codex/auth.json` 的仍然是 Codex 原始认证结构。

`auth_mode = apikey` 的当前登录态也会保存成账号文件，选择框中显示为 `API 登录` 和 key 前 10 位；这类账号不参与配额查询。

## 选择框说明

- 第一排：账号邮箱
- 第二排：用户名
- 第三排：`套餐 | 5h xx% | 周 xx% | 恢复时间 | 最近刷新时间`
- 顶部标题会显示当前已保存账号总数

配额显示规则：

- `5h` 配额不存在时隐藏
- `周` 配额始终显示
- 恢复时间优先显示为 `今天 HH:mm` / `明天 HH:mm`，其他日期显示为 `MM-DD HH:mm`
- 最近刷新时间显示为相对时间，例如 `3分钟前`、`2小时前`、`5天前`

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

### 0.0.3

- 已保存账号改为扁平新格式，扩展私有缓存统一写入 `.codex-account-switcher-meta.json`
- 当前账号状态栏支持显示周额度；后台轮询改为 30 秒触发，当前账号固定刷新
- 选择框展示优化为 `套餐 | 5h | 周 | 恢复时间 | 最近刷新时间`，顶部显示账号总数
- 支持将 `auth_mode = apikey` 的当前登录态保存为账号文件，并在选择框中显示为 `API 登录`
- 修复切换账号时重复生成同一账号文件的问题，并对同 `account_id` 账号做去重显示

## 本地调试

1. 在 VS Code 中打开本扩展目录。
2. 按 `F5` 启动 Extension Development Host。
3. 在新窗口里点击状态栏中的 `Codex` 按钮。
