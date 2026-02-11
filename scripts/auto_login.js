/**
 * ClawCloud 自动登录 & 余额监控 (Node.js 版)
 * - Авторизация через GitHub с поддержкой 2FA через Telegram
 * - Парсинг баланса ($4.99 / $5 used)
 * - Автоматическое обновление GH_SESSION
 */

const fs = require('fs');
const { chromium } = require('playwright');
const axios = require('axios');
const FormData = require('form-data');
const sodium = require('libsodium-wrappers');

// ==================== 配置 ====================
const CONFIG = {
    CLAW_CLOUD_URL: "https://ap-southeast-1.run.claw.cloud", 
    TWO_FACTOR_WAIT: parseInt(process.env.TWO_FACTOR_WAIT || "120"),
    GH_USERNAME: process.env.GH_USERNAME,
    GH_PASSWORD: process.env.GH_PASSWORD,
    GH_SESSION: process.env.GH_SESSION,
    TG_BOT_TOKEN: process.env.TG_BOT_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    REPO_TOKEN: process.env.REPO_TOKEN,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY
};

CONFIG.SIGNIN_URL = `${CONFIG.CLAW_CLOUD_URL}/signin`;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class Logger {
    constructor() { this.logs = []; }
    log(msg, level = "INFO") {
        const icons = { "INFO": "ℹ️", "SUCCESS": "✅", "ERROR": "❌", "WARN": "⚠️", "STEP": "🔹" };
        const icon = icons[level] || "•";
        const line = `${icon} ${msg}`;
        console.log(line);
        this.logs.push(line);
    }
    getRecentLogs() { return this.logs.slice(-6).join("\n"); }
}

const logger = new Logger();

class Telegram {
    constructor() {
        this.token = CONFIG.TG_BOT_TOKEN;
        this.chatId = CONFIG.TG_CHAT_ID;
        this.ok = !!(this.token && this.chatId);
        this.apiBase = `https://api.telegram.org/bot${this.token}`;
    }

    async send(msg) {
        if (!this.ok) return;
        try {
            await axios.post(`${this.apiBase}/sendMessage`, {
                chat_id: this.chatId,
                text: msg,
                parse_mode: "HTML"
            });
        } catch (e) { /* ignore */ }
    }

    async photo(filePath, caption = "") {
        if (!this.ok || !fs.existsSync(filePath)) return;
        try {
            const form = new FormData();
            form.append('chat_id', this.chatId);
            form.append('caption', caption.substring(0, 1024));
            form.append('photo', fs.createReadStream(filePath));
            await axios.post(`${this.apiBase}/sendPhoto`, form, { headers: form.getHeaders() });
        } catch (e) { /* ignore */ }
    }

    async waitCode(timeoutSec = 120) {
        if (!this.ok) return null;
        let offset = 0;
        const deadline = Date.now() + timeoutSec * 1000;
        while (Date.now() < deadline) {
            try {
                const res = await axios.get(`${this.apiBase}/getUpdates`, { params: { offset: offset, timeout: 10 } });
                if (res.data.ok) {
                    for (const upd of res.data.result) {
                        offset = upd.update_id + 1;
                        if (upd.message && String(upd.message.chat.id) === String(this.chatId)) {
                            const match = (upd.message.text || "").match(/^\/code\s+(\d{6,8})$/);
                            if (match) return match[1];
                        }
                    }
                }
            } catch (e) { await sleep(2000); }
        }
        return null;
    }
}

class SecretUpdater {
    constructor() {
        this.token = CONFIG.REPO_TOKEN;
        this.repo = CONFIG.GITHUB_REPOSITORY;
    }
    async update(name, value) {
        if (!this.token || !this.repo) return false;
        try {
            await sodium.ready;
            const headers = { "Authorization": `token ${this.token}`, "Accept": "application/vnd.github.v3+json" };
            const { data: keyData } = await axios.get(`https://api.github.com/repos/${this.repo}/actions/secrets/public-key`, { headers });
            const binkey = sodium.from_base64(keyData.key, sodium.base64_variants.ORIGINAL);
            const encBytes = sodium.crypto_box_seal(sodium.from_string(value), binkey);
            await axios.put(`https://api.github.com/repos/${this.repo}/actions/secrets/${name}`, {
                encrypted_value: sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL),
                key_id: keyData.key_id
            }, { headers });
            return true;
        } catch (e) { return false; }
    }
}

class AutoLogin {
    constructor() {
        this.tg = new Telegram();
        this.secret = new SecretUpdater();
        this.shots = [];
    }

    async shot(page, name) {
        const filename = `${Date.now()}_${name}.png`;
        await page.screenshot({ path: filename });
        this.shots.push(filename);
        return filename;
    }

    // --- НОВАЯ ФУНКЦИЯ ПАРСИНГА БАЛАНСА ---
    async getBalance(page) {
        logger.log("Шаг: Сбор данных о балансе...", "STEP");
        try {
            await page.goto(`${CONFIG.CLAW_CLOUD_URL}/plan`, { waitUntil: 'networkidle' });
            
            // Локатор для суммы (например, $4.99)
            const balanceElement = page.locator('text=$').first();
            await balanceElement.waitFor({ timeout: 10000 });
            const amount = await balanceElement.innerText();

            // Локатор для детализации (например, $0/5 used)
            const details = await page.locator('text=/used/').innerText();
            
            const info = `${amount.trim()} (${details.trim()})`;
            logger.log(`Баланс получен: ${info}`, "SUCCESS");
            return info;
        } catch (e) {
            logger.log(`Ошибка парсинга баланса: ${e.message}`, "WARN");
            return "Не удалось определить";
        }
    }

    async loginGithub(page) {
        logger.log("Вход в GitHub...", "STEP");
        await page.fill('input[name="login"]', CONFIG.GH_USERNAME);
        await page.fill('input[name="password"]', CONFIG.GH_PASSWORD);
        await page.click('input[type="submit"]');
        await sleep(5000);

        if (page.url().includes('two-factor')) {
            const s = await this.shot(page, "2fa_required");
            await this.tg.send("🔐 <b>Требуется 2FA</b>\nОтправьте <code>/code XXXXXX</code>");
            await this.tg.photo(s);
            const code = await this.tg.waitCode(CONFIG.TWO_FACTOR_WAIT);
            if (code) {
                await page.fill('input[autocomplete="one-time-code"]', code);
                await page.keyboard.press('Enter');
                await sleep(5000);
            }
        }
        return !page.url().includes('login');
    }

    async notify(ok, balance = "") {
        const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Shanghai' });
        let msg = `<b>🤖 ClawCloud Monitor</b>\n\n` +
                  `<b>Статус:</b> ${ok ? "✅ Активен" : "❌ Ошибка"}\n` +
                  `<b>Баланс:</b> <code>${balance || "нет данных"}</code>\n` +
                  `<b>Время:</b> ${now}`;
        await this.tg.send(msg);
        if (this.shots.length > 0) await this.tg.photo(this.shots[this.shots.length - 1]);
    }

    async run() {
        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext();
        if (CONFIG.GH_SESSION) {
            await context.addCookies([{ name: 'user_session', value: CONFIG.GH_SESSION, domain: 'github.com', path: '/' }]);
        }
        const page = await context.newPage();

        try {
            await page.goto(CONFIG.SIGNIN_URL);
            await sleep(3000);

            if (page.url().includes('signin')) {
                await page.click('button:has-text("GitHub")');
                await sleep(5000);
                if (page.url().includes('github.com/login')) {
                    await this.loginGithub(page);
                }
            }

            // Ждем завершения всех редиректов в панель
            await page.waitForURL(/claw\.cloud/, { timeout: 30000 });

            // ПАРСИНГ БАЛАНСА
            const balance = await this.getBalance(page);
            
            // Сохранение новой сессии
            const cookies = await context.cookies();
            const session = cookies.find(c => c.name === 'user_session');
            if (session) await this.secret.update('GH_SESSION', session.value);

            await this.shot(page, "final_state");
            await this.notify(true, balance);

        } catch (e) {
            logger.log(e.message, "ERROR");
            await this.notify(false);
        } finally {
            await browser.close();
        }
    }
}

(new AutoLogin()).run();
