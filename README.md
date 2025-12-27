---

# ☁️ ClawCloud 自动保活脚本 (Node.js 版)

这是一个基于 **GitHub Actions** 和 **Playwright** 的自动化脚本，用于定时登录 ClawCloud 面板以保持账号活跃。

它具备以下高级功能：
*   🚀 **全自动登录**：模拟真实浏览器行为，绕过简单的反爬虫检测。
*   🔐 **支持 2FA/验证码**：如果触发二步验证（2FA）或邮箱验证码，脚本会通过 **Telegram** 通知你，并允许你在 TG 中回复验证码完成登录。
*   🍪 **Session 自动持久化**：登录成功后自动抓取 Cookie 并加密保存到 GitHub Secrets，下次运行直接免密登录。
*   📸 **截图反馈**：运行过程中的关键步骤和错误都会发送截图到 Telegram。

## 📂 文件结构

请确保您的仓库包含以下三个核心文件：

```text
.
├── .github
│   └── workflows
│       └── keep_alive.yml   # GitHub Actions 配置文件
├── scripts
│   └── auto_login.js        # 核心 Node.js 脚本
├── package.json             # 依赖管理文件
└── README.md                # 说明文档
```

## 🛠️ 配置指南

在使用之前，您需要在 GitHub 仓库中配置 Secrets。

### 1. 获取必要信息
*   **Telegram Bot Token**: 在 Telegram 找 [@BotFather](https://t.me/BotFather) 创建机器人获取。
*   **Telegram Chat ID**: 在 Telegram 找 [@userinfobot](https://t.me/userinfobot) 获取您的数字 ID。
*   **REPO_TOKEN (个人访问令牌)**:
    1.  点击 GitHub 头像 -> Settings -> Developer settings -> Personal access tokens -> Tokens (classic)。
    2.  Generate new token (classic) -> 勾选 **`repo`** 权限 -> 生成并复制。

### 2. 添加 GitHub Secrets
进入仓库 -> **Settings** -> **Secrets and variables** -> **Actions** -> **New repository secret**，添加以下变量：

| 变量名 (Name) | 说明 | 示例值 |
| :--- | :--- | :--- |
| `GH_USERNAME` | **(必填)** ClawCloud / GitHub 登录邮箱 | `user@example.com` |
| `GH_PASSWORD` | **(必填)** 登录密码 | `MyPassword123` |
| `TG_BOT_TOKEN` | **(必填)** Telegram 机器人 Token | `123456:ABC-DEF...` |
| `TG_CHAT_ID` | **(必填)** 接收通知的 TG 用户 ID | `12345678` |
| `REPO_TOKEN` | **(必填)** 用于自动更新 Cookie | `ghp_xxxxxxxx...` |
| `GH_SESSION` | **(必填)** Cookie 缓存，**首次创建请留空** | *(空)* |

> ⚠️ **注意**：`GH_SESSION` 必须存在，第一次创建时值留空即可。脚本运行成功后会自动更新它。

### 3. 修改区域 (可选)
脚本默认连接的是 **法兰克福 (eu-central-1)** 区域。如果您的账号在 **美西** 或其他区域，请修改 `scripts/auto_login.js` 第 17 行：

```javascript
// 修改为实际的控制台地址
const CONFIG = {
    CLAW_CLOUD_URL: "https://us-west-1.run.claw.cloud", 
    // ...
```

## 🚀 首次运行与交互

由于首次运行可能需要验证设备或 2FA，请按照以下步骤操作：

1.  在 GitHub 仓库页面，点击 **Actions** 选项卡。
2.  在左侧选择 **ClawCloud 自动登录保活 (Node.js)**。
3.  点击右侧的 **Run workflow** -> **Run workflow** 按钮手动触发。
4.  **关注您的 Telegram**：
    *   如果脚本遇到验证码，会发消息提示。
    *   **请直接回复机器人**：`/code 123456` (将 123456 替换为实际验证码)。
    *   脚本会自动读取您的回复并填入网页。
5.  **完成**：
    *   登录成功后，脚本会自动保存 Cookie 到 `GH_SESSION`。
    *   以后的定时任务将自动使用 Cookie 登录，无需人工干预。

## ⏲️ 定时任务
默认配置在 `.github/workflows/keep_alive.yml` 中：

```yaml
on:
  schedule:
    - cron: '0 7 */3 * *'  # UTC时间 7:00 (北京时间 15:00)，每3天运行一次
```
您可以根据需要修改 `cron` 表达式调整频率。

## 📦 本地开发 (可选)

如果您想在本地电脑调试脚本：

1.  安装依赖：
    ```bash
    npm install
    npx playwright install chromium
    ```
2.  设置环境变量 (Linux/Mac):
    ```bash
    export GH_USERNAME="xxx"
    export GH_PASSWORD="xxx"
    export TG_BOT_TOKEN="xxx"
    export TG_CHAT_ID="xxx"
    # 本地运行不需要 REPO_TOKEN，因为无法更新 GitHub Secrets
    ```
3.  运行：
    ```bash
    node scripts/auto_login.js
    ```

## ⚠️ 免责声明

本脚本仅供学习交流使用。使用本脚本所产生的任何后果（如账号被封禁、资源被回收等）由使用者自行承担。请遵守服务商的使用条款。
