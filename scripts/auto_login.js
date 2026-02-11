/**
 * ClawCloud 自动登录 & 余额监控 (Node.js 版)
 * - Усиленная навигация: принудительный переход в биллинг
 * - Поиск баланса по регулярному выражению (любая сумма $)
 * - Исправлено ожидание селекторов для медленной загрузки
 */

const fs = require('fs');
const { chromium } = require('playwright');
const axios = require('axios');
const FormData = require('form-data');
const sodium = require('libsodium-wrappers');

// ==================== Конфигурация ====================
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
        const line = `${icons[level] || "•"} ${msg}`;
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
        this.apiBase = `https://api.telegram.org/bot${this.token}`;
    }
    async send(msg) {
        try { await axios.post(`${this.apiBase}/sendMessage`, { chat_id: this.chatId, text: msg, parse_mode: "HTML" }); } catch (e) {}
    }
    async photo(filePath, caption = "") {
        if (!fs.existsSync(filePath)) return;
        try {
            const form = new FormData();
            form.append('chat_id', this.chatId);
            form.append('caption', caption.substring(0, 1024));
            form.append('photo', fs.createReadStream(filePath));
            await axios.post(`${this.apiBase}/sendPhoto`, form, { headers: form.getHeaders() });
        } catch (e) {}
    }
    async waitCode(timeoutSec = 120) {
        let offset = 0;
        const deadline = Date.now() + timeoutSec * 1000;
        while (Date.now() < deadline) {
            try {
                const res = await axios.get(`${this.apiBase}/getUpdates`, { params: { offset, timeout: 10 } });
                if (res.data.ok) {
                    for (const upd of res.data.result) {
                        offset = upd.update_id + 1;
                        if (upd.message && String(upd.message.chat.id) === String(this.chatId)) {
                            const match = (upd.message.text || "").match(/^\/code\s+(\d{6,8})$/);
                            if (match) return match[1];
                        }
                    }
                }
            } catch (e) {}
            await sleep(2000);
        }
        return null;
    }
}

class SecretUpdater {
    async update(name, value) {
        if (!CONFIG.REPO_TOKEN || !CONFIG.GITHUB_REPOSITORY) return false;
        try {
            await sodium.ready;
            const headers = { "Authorization": `token ${CONFIG.REPO_TOKEN}`, "Accept": "application/vnd.github.v3+json" };
            const { data: keyData } = await axios.get(`https://api.github.com/repos/${CONFIG.GITHUB_REPOSITORY}/actions/secrets/public-key`, { headers });
            const binkey = sodium.from_base64(keyData.key, sodium.base64_variants.ORIGINAL);
            const encBytes = sodium.crypto_box_seal(sodium.from_string(value), binkey);
            await axios.put(`https://api.github.com/repos/${CONFIG.GITHUB_REPOSITORY}/actions/secrets/${name}`, {
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
        await page.screenshot({ path: filename, fullPage: false });
        this.shots.push(filename);
        return filename;
    }

    async getBalance(page) {
        logger.log("Шаг: Принудительный переход на страницу Plan...", "STEP");
        try {
            // Переходим по прямому URL и ждем загрузки сети
            await page.goto(`${CONFIG.CLAW_CLOUD_URL}/plan`, { waitUntil: 'networkidle', timeout: 60000 });
            
            // Ждем именно текст баланса (символ доллара), так как он важнее заголовка
            await page.waitForSelector('text=$', { timeout: 30000 });
            await sleep(5000); // Даем время JS-скриптам ClawCloud отрисовать цифры

            const data = await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('div, span, p, b, h1, h2'));
                const moneyRegex = /\$\d+\.\d+/; 
                
                // Ищем элемент, где текст - это ТОЛЬКО сумма (без лишних слов)
                const balanceEl = els.find(el => moneyRegex.test(el.innerText) && el.innerText.length < 10);
                // Ищем упоминание лимитов
                const usedEl = els.find(el => el.innerText.toLowerCase().includes('used'));
                
                return {
                    main: balanceEl ? balanceEl.innerText.trim() : "Не найден",
                    used: usedEl ? usedEl.innerText.trim() : "Лимиты не найдены"
                };
            });

            logger.log(`Данные получены: ${data.main}`, "SUCCESS");
            return `${data.main} (${data.used})`;

        } catch (e) {
            logger.log(`Тайм-аут или ошибка парсинга: ${e.message}`, "WARN");
            await this.shot(page, "debug_plan_page");
            return "Не удалось прочитать (проверьте скриншот)";
        }
    }

    async loginGithub(page) {
        logger.log("Вход в GitHub...", "STEP");
        await page.fill('input[name="login"]', CONFIG.GH_USERNAME);
        await page.fill('input[name="password"]', CONFIG.GH_PASSWORD);
        await page.click('input[type="submit"]');
        
        await sleep(5000);

        if (page.url().includes('two-factor')) {
            await this.tg.send("🔐 <b>Нужен 2FA код</b>\nОтправьте <code>/code XXXXXX</code>");
            const code = await this.tg.waitCode(CONFIG.TWO_FACTOR_WAIT);
            if (code) {
                await page.fill('input[autocomplete="one-time-code"]', code);
                await page.keyboard.press('Enter');
                await sleep(5000);
            }
        }
        return true;
    }

    async notify(ok, balance = "", err = "") {
        const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Shanghai' });
        let msg = `<b>🤖 ClawCloud Monitor</b>\n\n` +
                  `<b>Статус:</b> ${ok ? "✅ Успех" : "❌ Ошибка"}\n` +
                  `<b>Баланс:</b> <code>${balance}</code>\n` +
                  `<b>Время:</b> ${now}`;
        if (err) msg += `\n<b>Детали:</b> ${err}`;
        
        await this.tg.send(msg);
        if (this.shots.length > 0) await this.tg.photo(this.shots[this.shots.length - 1], "Текущий экран");
    }

    async run() {
        logger.log("Запуск скрипта...");
        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });

        if (CONFIG.GH_SESSION) {
            await context.addCookies([{ name: 'user_session', value: CONFIG.GH_SESSION, domain: 'github.com', path: '/' }]);
        }

        const page = await context.newPage();

        try {
            await page.goto(CONFIG.SIGNIN_URL, { waitUntil: 'networkidle' });
            
            if (page.url().includes('signin')) {
                await page.click('button:has-text("GitHub")');
                await sleep(5000);
                if (page.url().includes('github.com/login')) {
                    await this.loginGithub(page);
                }
            }

            // Ждем завершения входа
            await page.waitForURL(/claw\.cloud/, { timeout: 60000 });
            logger.log("Авторизация прошла успешно", "SUCCESS");
            
            // Важная пауза: ClawCloud должен прогрузить токены в фоне
            await sleep(8000); 

            const balance = await this.getBalance(page);
            
            // Сохранение сессии
            const cookies = await context.cookies();
            const session = cookies.find(c => c.name === 'user_session');
            if (session) await this.secret.update('GH_SESSION', session.value);

            await this.shot(page, "success_final");
            await this.notify(true, balance);

        } catch (e) {
            logger.log(`Критическая ошибка: ${e.message}`, "ERROR");
            await this.shot(page, "critical_error");
            await this.notify(false, "Ошибка", e.message);
        } finally {
            await browser.close();
        }
    }
}

(new AutoLogin()).run();
