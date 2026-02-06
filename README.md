# 🐕 OpenClaw Watchdog

OpenClaw Gateway 的智能监控守护进程，提供健康检查、日志分析、模型管理和自动恢复功能。

## ✨ 功能特性

| 功能 | 描述 |
|------|------|
| 🔍 **健康监控** | 定期检查 Gateway 和各频道状态 |
| 📊 **日志分析** | 自动检测错误、配额问题和模型故障 |
| 🔀 **模型管理** | 追踪失败模型，支持自动切换备用模型 |
| 🔄 **自动恢复** | Gateway 故障时自动重启 |
| 📢 **通知推送** | 通过 Telegram 发送告警通知 |
| 📝 **报告生成** | 生成 JSON 和文本格式的详细报告 |

---

## 📋 系统要求

- **Node.js** 18.0.0 或更高版本
- **OpenClaw** 已安装并配置（`openclaw` CLI 可用）
- **npm** 或 **pnpm** 包管理器

---

## 🚀 安装步骤

### 1. 克隆项目

```bash
git clone https://github.com/your-username/OpenClawWatchdog.git
cd OpenClawWatchdog
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置设定

复制并编辑配置文件：

```bash
cp config/watchdog.example.json config/watchdog.json
# 编辑 config/watchdog.json 设置你的参数
```

### 4. 验证安装

```bash
# 执行单次检查，验证设置是否正确
npm run dev:check
```

---

## ⚙️ 配置说明

配置文件位于 `config/watchdog.json`，以下是各配置项的详细说明：

### 监控设置 (`monitor`)

```json
{
  "monitor": {
    "enabled": true,              // 是否启用监控
    "intervalMs": 30000,          // 检查间隔（毫秒），默认 30 秒
    "healthTimeoutMs": 10000,     // 健康检查超时（毫秒）
    "logFile": "/tmp/openclaw/openclaw-{{date}}.log",  // OpenClaw 日志路径
    "reportsDir": "./reports"     // 报告输出目录
  }
}
```

### Gateway 设置 (`gateway`)

```json
{
  "gateway": {
    "url": "ws://127.0.0.1:18789", // Gateway WebSocket 地址
    "token": null,                  // Gateway 认证 Token（如有）
    "healthEndpoint": true          // 是否使用健康检查端点
  }
}
```

### 运行模式 (`dryRun`)

```json
{
  "dryRun": false  // true = 只读模式，不执行任何修复操作
                   // false = 启用自动恢复功能
}
```

### 模型管理 (`models`)

```json
{
  "models": {
    "quotaCheckEnabled": true,           // 是否检查模型配额
    "quotaRecoveryCheckIntervalMs": 300000,  // 配额恢复检查间隔（5分钟）
    "autoSwitch": true,                  // 模型故障时自动切换

    "sessionRules": {
      "default": {                       // 默认规则
        "allowedModels": [               // 允许使用的模型列表
          "provider/model-name"
        ],
        "fallbackOrder": [               // 备用模型优先顺序
          "provider/model-name"
        ]
      },
      "agent:main:*": {                  // 匹配 agent:main:* 的会话规则
        "allowedModels": [...],
        "fallbackOrder": [...]
      }
    }
  }
}
```

**会话规则匹配**：
- `default` - 默认规则，匹配所有未指定的会话
- `agent:main:*` - 匹配 agent:main 开头的所有会话
- `agent:sub:*` - 匹配 agent:sub 开头的所有会话

### 恢复设置 (`recovery`)

```json
{
  "recovery": {
    "enabled": true,               // 是否启用自动恢复
    "maxRestartAttempts": 3,       // 最大重启尝试次数
    "restartCooldownMs": 60000,    // 重启冷却时间（1分钟）
    "strategies": [                // 恢复策略
      "restart_gateway"            // 目前支持：restart_gateway
    ]
  }
}
```

### 通知设置 (`notifications`)

```json
{
  "notifications": {
    "enabled": true,                    // 是否启用通知
    "channel": "telegram",              // 通知频道（目前仅支持 telegram）
    "target": "YOUR_TELEGRAM_CHAT_ID",  // Telegram Chat ID（群组或用户）
    "topic": "20"                       // Telegram 论坛话题 ID（可选）
  }
}
```

**获取 Telegram Chat ID**：
1. 将 Bot 添加到群组
2. 发送一条消息
3. 访问 `https://api.telegram.org/bot<TOKEN>/getUpdates` 查看 chat.id

### 日志设置 (`logging`)

```json
{
  "logging": {
    "level": "info",              // 日志级别：debug, info, warn, error
    "file": "./logs/watchdog.log" // 日志文件路径
  }
}
```

---

## 🎮 使用方法

### 开发模式（推荐）

```bash
# 单次检查（测试配置）
npm run dev:check

# 持续监控
npm run dev
```

### 生产模式

```bash
# 构建项目
npm run build

# 单次检查
npm run check

# 持续监控
npm start
```

### 使用脚本

```bash
# 持续监控
./start.sh

# 单次检查
./start.sh check
```

---

## 🖥️ 作为系统服务运行 (macOS)

### 安装 LaunchAgent

1. 编辑 `com.openclaw.watchdog.plist`，修改路径为你的实际安装路径

2. 复制到 LaunchAgents：
```bash
cp com.openclaw.watchdog.plist ~/Library/LaunchAgents/
```

3. 加载服务：
```bash
launchctl load ~/Library/LaunchAgents/com.openclaw.watchdog.plist
```

### 管理服务

```bash
# 启动
launchctl start com.openclaw.watchdog

# 停止
launchctl stop com.openclaw.watchdog

# 卸载
launchctl unload ~/Library/LaunchAgents/com.openclaw.watchdog.plist
```

---

## 📊 报告说明

每次检查生成两种格式的报告：

| 格式 | 文件名 | 用途 |
|------|--------|------|
| JSON | `report-{timestamp}-{id}.json` | 程序解析、自动化处理 |
| Text | `report-{timestamp}-{id}.txt` | 人工阅读、快速查看 |

### 状态级别

| 状态 | 图标 | 说明 |
|------|------|------|
| HEALTHY | ✅ | 所有系统正常 |
| DEGRADED | ⚠️ | 有小问题，仍可运行 |
| UNHEALTHY | 🔴 | 有重大问题，影响功能 |
| CRITICAL | 🚨 | Gateway 不可用或严重故障 |

---

## 📁 项目结构

```
OpenClawWatchdog/
├── src/
│   ├── watchdog.ts          # 主入口
│   ├── health-monitor.ts    # 健康检查
│   ├── log-analyzer.ts      # 日志分析
│   ├── model-guard.ts       # 模型配额追踪
│   ├── model-switcher.ts    # 模型切换
│   ├── config-guardian.ts   # 配置保护
│   ├── recovery.ts          # 自动恢复
│   ├── notifier.ts          # 通知系统
│   ├── report-generator.ts  # 报告生成
│   ├── logger.ts            # 日志工具
│   └── types.ts             # 类型定义
├── config/
│   └── watchdog.json        # 配置文件
├── reports/                 # 生成的报告
├── logs/                    # Watchdog 日志
├── start.sh                 # 启动脚本
├── service.sh               # 服务脚本
└── com.openclaw.watchdog.plist  # macOS LaunchAgent
```

---

## 🔧 故障排除

### 健康检查失败

```bash
# 确认 OpenClaw Gateway 正在运行
openclaw gateway status

# 手动测试健康检查
openclaw health --json
```

### 找不到日志文件

```bash
# 检查日志目录是否存在
ls -la /tmp/openclaw/

# 确认日志文件模式是否匹配
ls /tmp/openclaw/openclaw-*.log
```

### 通知发送失败

```bash
# 测试 OpenClaw 消息功能
openclaw message send --channel telegram --target "YOUR_CHAT_ID" --message "Test"
```

### 高 CPU/内存使用

- 增加 `monitor.intervalMs`（如设为 60000 = 1分钟）
- 减少报告保留数量，定期清理 `reports/` 目录

---

## 🛡️ 安全建议

1. **不要提交敏感配置**：将 `config/watchdog.json` 加入 `.gitignore`
2. **使用环境变量**：敏感信息如 Token 可从环境变量读取
3. **限制权限**：确保配置文件权限为 600

---

## 📝 许可证

MIT License - 请负责任地使用，生产环境部署前请充分测试。
