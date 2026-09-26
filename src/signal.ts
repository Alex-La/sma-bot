import { appendFile } from "node:fs/promises";

/**
 * Сигнал тренда SMA по рыночным данным Binance (mainnet) + отправка в Telegram.
 * Правило: монету держим, пока дневное закрытие (UTC) выше SMA(N), иначе USDT.
 */

/** Число из env. Пустая строка (несуществующий секрет CI) и мусор — ошибка, а не молчаливый 0/NaN. */
export function envNum(
    env: NodeJS.ProcessEnv,
    name: string,
    def: number,
    ok: (x: number) => boolean,
    hint: string,
): number {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return def;
    const x = Number(raw);
    if (!Number.isFinite(x) || !ok(x)) throw new Error(`${name}="${raw}" — ${hint}`);
    return x;
}

export const SMA = envNum(process.env, "SMA_PERIOD", 50, (x) => Number.isInteger(x) && x >= 2, "нужно целое ≥ 2");
export const SYMBOLS = [
    ...new Set(
        (process.env.SYMBOLS ?? "BTCUSDT,ETHUSDT")
            .split(",")
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean),
    ),
];
if (SYMBOLS.length === 0) throw new Error("SYMBOLS пуст — нужна хотя бы одна пара");

// data-api.binance.vision — публичный эндпоинт только для рыночных данных, без гео-блокировки США.
const DATA_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];

export interface Candle {
    openTime: number;
    close: number;
}

export interface Signal {
    day: Date;
    close: number;
    sma: number;
    dist: number;
    inMarket: boolean;
    changed: boolean;
}

// [openTime, open, high, low, close, volume, closeTime, ...]
type Kline = [number, string, string, string, string, string, number, ...unknown[]];

/** Экранирование для вставки внешнего текста в сообщение с parse_mode=HTML. */
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** URL для сообщения об ошибке: без query (там signature) и без токена бота в пути. */
const redact = (url: string) => url.split("?")[0]!.replace(/\/bot\d+:[^/]*/, "/bot***");

export async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, {
        ...init,
        headers: { "User-Agent": "sma-bot/1.0", ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${redact(url)}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
}

/** Только ЗАКРЫТЫЕ дневные свечи, по возрастанию времени. */
export async function dailyCloses(symbol: string): Promise<Candle[]> {
    const q = new URLSearchParams({ symbol, interval: "1d", limit: String(SMA + 5) });
    const errs: string[] = [];
    for (const host of DATA_HOSTS) {
        try {
            const rows = await getJson<Kline[]>(`${host}/api/v3/klines?${q}`);
            const now = Date.now();
            const closed = rows.filter((r) => r[6] < now).map((r) => ({ openTime: r[0], close: Number(r[4]) }));
            if (closed.length < SMA + 1) throw new Error(`мало данных: ${closed.length} свечей, нужно ${SMA + 1}`);
            return closed;
        } catch (e) {
            errs.push(`${new URL(host).host}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    throw new Error(`${symbol}: не удалось получить свечи\n${errs.join("\n")}`);
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;

export function evaluate(candles: Candle[]): Signal {
    const c = candles.map((x) => x.close);
    const close = c[c.length - 1]!;
    const prevClose = c[c.length - 2]!;
    const sma = mean(c.slice(-SMA));
    const smaPrev = mean(c.slice(-SMA - 1, -1));
    const inMarket = close > sma;
    return {
        day: new Date(candles[candles.length - 1]!.openTime),
        close,
        sma,
        dist: close / sma - 1,
        inMarket,
        changed: inMarket !== prevClose > smaPrev,
    };
}

export function fmtPrice(x: number): string {
    if (Math.abs(x) >= 100) return Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return x.toFixed(2);
}

export const fmtPct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

const fmtDay = (d: Date) =>
    `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;

export function renderSignals(signals: Map<string, Signal>): string {
    const day = new Date(Math.max(...[...signals.values()].map((s) => s.day.getTime())));
    const lines = [`<b>📊 SMA${SMA} · свеча ${fmtDay(day)} (UTC)</b>`, ""];
    for (const [symbol, s] of signals) {
        const status = s.inMarket
            ? s.changed ? "🟢 <b>ВОЙТИ</b> ⚠️ сигнал сменился" : "🟢 держать"
            : s.changed ? "🔴 <b>ВЫЙТИ</b> ⚠️ сигнал сменился" : "⚪️ вне рынка (USDT)";
        lines.push(`<b>${symbol.replace(/USDT$/, "")}</b> — ${status}`);
        lines.push(`   close ${fmtPrice(s.close)} · SMA ${fmtPrice(s.sma)} · ${fmtPct(s.dist)}`);
    }
    return lines.join("\n");
}

/** Отчёт из HTML (Telegram) в Markdown: <b> -> **, перевод строки -> жёсткий перенос. */
export const htmlToMarkdown = (s: string) => s.replace(/<\/?b>/g, "**").split("\n").join("  \n");

/**
 * Дописать текст в сводку прогона GitHub Actions (видна на странице run, без копания в логах).
 * Вне Actions переменной нет — тогда это no-op.
 */
export async function writeSummary(markdown: string): Promise<void> {
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (!file) return;
    await appendFile(file, `${markdown}\n`);
}

export async function sendTelegram(text: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) throw new Error("Нет TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID");
    const body = new URLSearchParams({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: "true" });
    const res = await getJson<{ ok: boolean }>(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        body,
    });
    if (!res.ok) throw new Error(`Telegram: ${JSON.stringify(res)}`);
}
