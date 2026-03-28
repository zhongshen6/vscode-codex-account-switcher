# Codex 账号切换器

一个用于切换 Codex 账号的 VS Code 扩展，会在状态栏提供一个入口按钮。

## 功能

- 从固定目录读取已保存的账号记录
- 通过选择框显示账号信息并切换账号
- 将所选账号的认证文件复制到当前 Codex 配置目录
- 支持删除已保存账号
- 支持应用或恢复可选的 Codex 重载补丁

## 默认路径

- Codex 主目录固定为 `~/.codex`
- 已保存账号目录固定为 Codex 主目录同级的 `.codex-accounts`

## 已保存账号的目录结构

```text
.codex-accounts/
  账号名__account-id.json
```

## 本地调试

1. 在 VS Code 中打开本扩展目录。
2. 按 `F5` 启动 Extension Development Host。
3. 在新窗口里点击状态栏中的 `Codex` 按钮。
