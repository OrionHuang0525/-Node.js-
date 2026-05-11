# Sales Message Logger

第三方网页售后待回复消息本地 TXT 日志记录器。

当前版本写入本机 TXT 日志，并支持三种飞书/AI 通知方式：

1. 真飞书应用：通过 `lark-cli` 使用应用 bot 身份发送消息。
2. 自定义群机器人 Webhook：作为备用方式。
3. 真飞书应用交互卡片：Claude Code 先生成审核与回复建议，再由 Node.js 只发送一条飞书审批卡片。

默认不调用第三方系统内部 API，不自动回复、不自动点击页面按钮，只读取当前登录用户页面上已经展示出来的 DOM 内容。

如果启用“Claude 审核 + 飞书审批卡片 + 页面二次确认回复”，脚本也必须满足两次人工确认：先在飞书卡片批准，再在目标网页浮层确认发送。任何一步未确认，都不会向客户发送回复。

## 1. 安装 Node.js

先安装 Node.js LTS 版本。

可以在命令行执行下面命令确认是否安装成功：

```bash
node -v
npm -v
```

## 2. 安装依赖

在项目目录执行：

```bash
npm install
```

如果 Windows PowerShell 提示 `npm.ps1 cannot be loaded because running scripts is disabled on this system`，可以改用：

```bash
npm.cmd install
```

## 3. 启动日志服务

执行：

```bash
npm start
```

如果遇到同样的 PowerShell 执行策略提示，可以改用：

```bash
npm.cmd start
```

看到类似输出表示启动成功：

```text
Sales Message Logger listening on http://127.0.0.1:3107
```

服务只监听 `127.0.0.1:3107`，不会监听 `0.0.0.0`。

如果暂时不配置飞书，服务会显示：

```text
Feishu webhook disabled
```

## 3.1 配置飞书机器人

在飞书群里添加自定义机器人，复制机器人 Webhook 地址。

不要把 Webhook 写进代码或提交到仓库。启动服务前通过环境变量配置。

PowerShell：

```powershell
$env:FEISHU_WEBHOOK_URL="https://open.feishu.cn/open-apis/bot/v2/hook/你的机器人地址"
npm.cmd start
```

如果机器人开启了签名校验，再加上：

```powershell
$env:FEISHU_SECRET="你的签名密钥"
npm.cmd start
```

CMD：

```bat
set FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/你的机器人地址
npm.cmd start
```

如果机器人开启了签名校验：

```bat
set FEISHU_SECRET=你的签名密钥
npm.cmd start
```

看到下面输出表示飞书通知已启用：

```text
Feishu webhook enabled
```

## 4. 检查服务是否正常

打开浏览器访问：

```text
http://127.0.0.1:3107/health
```

如果看到 `success: true`，表示本机日志服务正常。

返回里的 `feishu.enabled` 为 `true` 时，表示服务已经读取到 `FEISHU_WEBHOOK_URL`。`feishu.secretConfigured` 为 `true` 时，表示也读取到了 `FEISHU_SECRET`。

## 4.1 Claude 审核与飞书审批卡片

这一模式需要真飞书应用，不是普通群机器人 Webhook。

打开本机配置向导：

```text
http://127.0.0.1:3107/setup
```

在“Claude 审核 + 飞书审批卡片”里填写：

- Claude 命令：通常为 `claude.cmd`
- 飞书 App ID / App Secret
- 群 `chat_id`
- 回调模式：`http` 或 `ws`

保存后服务会把 `notificationMode` 切换为 `feishu_card`。此时新售后消息不会再走 Webhook 文本通知，而是走 Claude 审核后的飞书交互卡片，避免重复通知。

飞书卡片按钮回调地址：

```text
http://127.0.0.1:3107/feishu/card-callback
```

如果飞书无法访问本机 `127.0.0.1`，需要使用长连接模式或公网/内网穿透回调地址。普通 Webhook 机器人不能处理“批准填入草稿”按钮。

审批回复安全规则：

- Claude 只生成建议，不直接回复客户。
- 飞书卡片“批准填入草稿”只把任务置为已批准。
- 用户脚本只在当前选中订单号和客户名匹配时填入草稿。
- 页面内还会弹出二次确认浮层；点击“确认发送”后才会点击原网页发送按钮。

## 5. 安装 Tampermonkey

在 Chrome 或 Edge 安装 Tampermonkey。

## 6. 创建用户脚本

打开 Tampermonkey Dashboard。

点击 Create a new script。

把 `userscript/sales-message-logger.user.js` 内容复制进去。

保存并启用脚本。

## 7. 打开目标网页

打开：

```text
https://shengji.lingdongsz.com/uranus/#/afterMessage/salesConsultation
```

登录第三方系统。

## 8. 保持 Node.js 服务运行

页面要能写入本机 TXT，必须保持下面命令持续运行：

```bash
npm start
```

## 9. 检查日志文件

页面出现新的售后待回复消息后，检查：

```text
logs/message-log-YYYY-MM-DD.txt
```

每条日志会包含订单编号、客户名、客户原文、客户译文、来源页面、写入时间等信息。

如果配置了飞书机器人，同一条消息写入 TXT 后会同步发送飞书文本通知。飞书发送失败时，TXT 仍会保留，服务端控制台会输出失败原因，避免因为飞书短暂异常造成本地日志重复写入。

## 10. 如果没有写入

打开浏览器开发者工具 Console。

搜索：

```text
Sales Consultation Local Logger
```

检查是否找到下面日志：

```text
found ul.order-wrap
found .chat-history
```

同时检查 Node.js 服务是否已经启动：

```bash
npm start
```

也可以访问：

```text
http://127.0.0.1:3107/health
```

确认返回 `success: true`。

如果 TXT 已写入但飞书没有收到：

1. 检查启动服务的命令行窗口是否显示 `Feishu webhook enabled`。
2. 检查 `/health` 返回的 `feishu.enabled` 是否为 `true`。
3. 检查飞书机器人是否开启了签名校验；如果开启了，必须设置 `FEISHU_SECRET`。
4. 检查服务端控制台里的 `Failed to send Feishu message` 错误。

## 11. 如果误报

优先调整用户脚本中的过滤函数 `shouldIgnoreText`。

不要改技术路线。

## 12. 如果要记录页面首次已有消息

默认配置不会把页面首次打开时已经存在的历史待回复消息全部写入日志。

如果确实要记录首次已有消息，把 `userscript/sales-message-logger.user.js` 中的：

```javascript
logExistingOnFirstRun: false
```

改成：

```javascript
logExistingOnFirstRun: true
```

## 日志与去重文件

TXT 日志每天一个文件：

```text
logs/message-log-YYYY-MM-DD.txt
```

当天去重文件：

```text
logs/dedupe-YYYY-MM-DD.json
```

服务启动时会读取当天去重文件，尽量避免 Node.js 重启后重复写入同一条消息。

## Lark CLI 与飞书一键启动

本机已安装官方 Lark/Feishu CLI：

```bash
npm.cmd run lark:version
```

如果要检查 CLI 状态：

```bash
npm.cmd run lark:doctor
```

当前机器已经完成真飞书应用配置，并验证 bot 可以发消息到当前接收会话。

本地私有接收配置保存在：

```text
config/lark.local.env
```

这个文件已加入 `.gitignore`，不要提交、不要外发。

发送一条真飞书应用测试消息：

```bash
npm.cmd run test:lark
```

如果成功，命令行会显示：

```text
POST /test-lark-cli: lark-cli test sent
```

正式运行真飞书应用推送：

```bash
npm.cmd run start:lark
```

看到：

```text
Lark CLI enabled
```

表示本机服务已经启用真实飞书应用发送。之后第三方网页出现新的售后待回复消息时，会同时写入 TXT 并通过应用 bot 推送到飞书。

飞书推送默认会聚合 5 秒内新增的待回复订单，避免一次刷出多条时连续刷屏。可在 `config/lark.local.env` 调整：

```text
LARK_AGGREGATE_WINDOW_MS=5000
```

推送内容以左侧订单信息为准。只有左侧订单是当前选中项，并且右侧聊天标题客户名与左侧客户名匹配时，才会附带客户原文、客户译文和客户消息时间；其他订单只发送订单摘要，避免错配。

`lark-cli doctor` 如果提示用户 IM scopes 未完全授予，不影响当前 bot 直发链路。当前发消息使用的是 bot 身份和已保存的 P2P `chat_id`。

## Webhook 备用方式

第一次配置飞书群机器人：

```bash
npm.cmd run setup:feishu
```

按提示粘贴飞书群自定义机器人的 Webhook。如果机器人开启签名校验，再填 `FEISHU_SECRET`。配置会保存在：

```text
config/feishu.local.env
```

这个文件已加入 `.gitignore`，不要提交、不要外发。

发送一条飞书测试消息：

```bash
npm.cmd run test:feishu
```

如果成功，命令行会显示：

```text
POST /test-feishu: feishu test sent
```

同时飞书群里会收到一条“售后待回复消息”测试通知。

正式运行：

```bash
npm.cmd run start:feishu
```

看到：

```text
Feishu webhook enabled
```

表示本机服务已经加载飞书机器人配置。之后第三方网页出现新的售后待回复消息时，会同时写入 TXT 并推送到飞书群。
