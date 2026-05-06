# 客服即插即用安装包说明

面向客服电脑的推荐流程是使用 Windows 安装包，不要求客服手动安装 Node.js、npm 或 lark-cli。

## 构建安装包

技术人员在项目目录执行：

```bash
npm.cmd run build:installer
```

构建脚本会生成：

```text
dist/SalesMessageLogger-Setup.exe
```

如果当前机器没有可用的 IExpress，则会保留可分发目录：

```text
dist/SalesMessageLoggerPackage
```

## 安装位置

安装包默认安装到：

```text
%LOCALAPPDATA%\SalesMessageLogger
```

安装完成后会创建桌面和开始菜单入口，并打开：

```text
http://127.0.0.1:3107/setup
```

## 本地向导

本地向导包含：

- 服务运行状态
- 脚本猫安装入口
- 本机 `.user.js` 安装入口
- 飞书群机器人 Webhook 快速配置
- 真飞书应用高级配置
- 测试通知按钮

快速模式只需要客服把飞书群机器人的 Webhook 和可选 Secret 粘贴到向导里，然后点击“发送测试消息”。

高级模式适合交给 Claude Code / Hermes / Codex 处理。向导里可以复制 `AGENT_SETUP_PROMPT.md`，让 Agent 根据 App ID、App Secret、chat_id 或 open_id 完成真飞书应用配置。

## 升级与卸载

- 升级安装不会主动复制或外发本机私有配置。
- 卸载脚本默认保留日志和配置到 `%LOCALAPPDATA%\SalesMessageLogger.keep`。
- 如需删除全部本地数据，可运行：

```powershell
powershell -ExecutionPolicy Bypass -File installer\uninstall.ps1 -RemoveData
```

