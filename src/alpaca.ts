import { setTimeout as sleep } from "node:timers/promises";

import { getJson } from "./signal.ts";


export interface Asset {
    symbol: string; // "BTC/USD"
    base: string;
    quote: string;
    step: string;
    minNotional: number;
}

export interface Book {
    qty: number;
    cash: number;
}

export interface Order {
    id: string;
    client_order_id: string;
    symbol: string;
    side: "buy" | "sell";
    status: string;
    filled_qty: string;
    filled_avg_price: string | null;
    submitted_at: string;
}

type Params = Record<string, string | number>;

const DONE = new Set(["filled", "canceled", "expired", "rejected", "done_for_day"]);

/** Ключ позиции: /v2/positions отдаёт "BTCUSD", а ордера и ассеты — "BTC/USD". */
const posKey = (symbol: string) => symbol.replace("/", "");

export const filledQuote = (o: Order) => Number(o.filled_qty) * Number(o.filled_avg_price ?? 0);

export class Alpaca {
    private readonly baseUrl: string;
    private readonly dataUrl: string;
    private readonly headers: Record<string, string>;

    constructor(baseUrl: string, key: string, secret: string, dataUrl = "https://data.alpaca.markets") {
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.dataUrl = dataUrl.replace(/\/$/, "");
        this.headers = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
    }

    async req<T>(method: "GET" | "POST", url: string, params: Params = {}, body?: object): Promise<T> {
        const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
        return getJson<T>(`${url}${q ? `?${q}` : ""}`, {
            method,
            headers: { ...this.headers, ...(body ? { "Content-Type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
    }

    async asset(symbol: string): Promise<Asset> {
        type A = { symbol: string; tradable: boolean; min_order_size: string | number; min_trade_increment: string | number };
        const a = await this.req<A>("GET", `${this.baseUrl}/v2/assets/${encodeURIComponent(symbol)}`);
        if (!a.tradable) throw new Error(`${symbol}: не торгуется на Alpaca`);
        const [base, quote] = a.symbol.split("/");
        if (!base || !quote) throw new Error(`${symbol}: не крипто-пара (${a.symbol})`);
        const px = await this.price(symbol);
        return {
            symbol: a.symbol,
            base,
            quote,
            step: String(a.min_trade_increment),
            minNotional: Math.max(Number(a.min_order_size) * px, 1),
        };
    }

    async price(symbol: string): Promise<number> {
        const r = await this.req<{ trades: Record<string, { p: number }> }>(
            "GET", `${this.dataUrl}/v1beta3/crypto/us/latest/trades`, { symbols: symbol },
        );
        const p = r.trades[symbol]?.p;
        if (!p) throw new Error(`${symbol}: нет последней сделки`);
        return p;
    }

    /** Доступные USD для покупки крипты (крипта не маржинальная). */
    async buyingPower(): Promise<number> {
        const acc = await this.req<{ non_marginable_buying_power: string }>("GET", `${this.baseUrl}/v2/account`);
        return Number(acc.non_marginable_buying_power);
    }

    /** Свободное количество по каждой позиции, ключ — символ без "/". */
    async positions(): Promise<Map<string, number>> {
        const ps = await this.req<{ symbol: string; qty_available: string }[]>("GET", `${this.baseUrl}/v2/positions`);
        return new Map(ps.map((p) => [posKey(p.symbol), Number(p.qty_available)]));
    }

    heldQty(positions: Map<string, number>, symbol: string): number {
        return positions.get(posKey(symbol)) ?? 0;
    }

    /**
     * Позиция и денежный поток корзины по всей истории ордеров бота.
     *
     * /v2/orders отдаёт максимум PAGE записей, поэтому обходим постранично от старых к новым
     * по submitted_at. `after` строгий — отступаем на 1 мс назад и убираем дубли по id,
     * чтобы ордер с той же меткой времени не выпал между страницами.
     * Комиссии не учитываются: при продаже количество всё равно ограничено фактической позицией.
     */
    async book(symbol: string, prefix: string): Promise<Book> {
        const PAGE = 500;
        const MAX_PAGES = 200;
        const seen = new Set<string>();
        let qty = 0;
        let cash = 0;
        let after = "1970-01-01T00:00:00Z";
        for (let page = 0; ; page++) {
            if (page >= MAX_PAGES) {
                throw new Error(`${symbol}: больше ${MAX_PAGES * PAGE} ордеров — история не вычитана целиком`);
            }
            const orders = await this.req<Order[]>("GET", `${this.baseUrl}/v2/orders`, {
                status: "all", symbols: symbol, direction: "asc", limit: PAGE, after,
            });
            for (const o of orders) {
                if (seen.has(o.id)) continue;
                seen.add(o.id);
                if (o.symbol !== symbol || !o.client_order_id?.startsWith(prefix)) continue;
                const q = Number(o.filled_qty);
                const c = filledQuote(o);
                if (o.side === "buy") {
                    qty += q;
                    cash -= c;
                } else {
                    qty -= q;
                    cash += c;
                }
            }
            if (orders.length < PAGE) break;
            const last = Math.max(...orders.map((o) => Date.parse(o.submitted_at)));
            after = new Date(last - 1).toISOString();
        }
        return { qty: Math.max(qty, 0), cash };
    }

    /** Рыночный ордер; ждём финального статуса, чтобы знать фактическое исполнение. */
    async market(
        symbol: string,
        side: "buy" | "sell",
        amount: { qty: string } | { notional: string },
        clientOrderId: string,
    ): Promise<Order> {
        let o = await this.req<Order>("POST", `${this.baseUrl}/v2/orders`, {}, {
            symbol, side, type: "market", time_in_force: "gtc", client_order_id: clientOrderId, ...amount,
        });
        for (let i = 0; !DONE.has(o.status); i++) {
            if (i >= 60) throw new Error(`${symbol}: ордер ${o.id} не исполнился за 30 с (статус ${o.status})`);
            await sleep(500);
            o = await this.req<Order>("GET", `${this.baseUrl}/v2/orders/${o.id}`);
        }
        if (o.status !== "filled" && !(Number(o.filled_qty) > 0)) {
            throw new Error(`${symbol}: ордер ${o.id} не исполнен (статус ${o.status})`);
        }
        return o;
    }
}

export function floorToStep(x: number, step: string): string {
    const s = Number(step);
    const decimals = Math.max(0, -Math.floor(Math.log10(s) + 1e-9));
    return (Math.floor(x / s + 1e-9) * s).toFixed(decimals);
}
