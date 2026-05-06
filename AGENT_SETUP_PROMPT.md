# 真飞书应用高级模式配置提示词

你是一个在 Windows 本机上工作的 AI Agent。请帮我把“售后消息本地记录器”接入真飞书应用高级模式。

## 背景

本机项目是 Sales Message Logger，服务监听：

`http://127.0.0.1:3107`

它已经支持：

- `GET /health`
- `GET /setup`
- `POST /config/lark-cli`
- `POST /test-notification`
- `POST /test-lark-cli`

目标是让服务通过 `lark-cli` 以飞书应用机器人身份，把售后待回复消息推送到指定飞书群或指定用户。

## 请你执行

1. 确认本机服务正在运行。
2. 如果没有运行，请在项目目录启动服务。
3. 确认或安装 `lark-cli`。
4. 让用户提供飞书应用的 `App ID` 和 `App Secret`，不要把它们写入 README 或聊天公开区域。
5. 使用 `lark-cli config init` 或等效方式完成飞书应用配置。
6. 如果需要用户授权，请打开授权链接并等待用户完成。
7. 获取推送目标：
   - 优先使用用户提供的群 `chat_id`。
   - 如果用户只要求发给个人，则解析或确认用户 `open_id`。
8. 调用本地接口保存配置：

```powershell
$body = @{
  enabled = $true
  bin = "lark-cli"
  chatId = "oc_xxx"
  userId = ""
  aggregateWindowMs = 5000
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:3107/config/lark-cli" `
  -ContentType "application/json" `
  -Body $body
```

9. 发送测试消息：

```powershell
Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:3107/test-notification" `
  -ContentType "application/json" `
  -Body '{"mode":"lark"}'
```

10. 最后检查：

```powershell
Invoke-RestMethod http://127.0.0.1:3107/health
```

确认 `larkCli.enabled` 为 `true`。

## 安全要求

- 不要把 App Secret、Webhook、Cookie、Token 写进 README。
- 不要调用第三方售后系统内部 API。
- 不要自动回复客户。
- 不要自动点击第三方网页按钮。
- 只配置飞书推送链路和本机服务配置。

