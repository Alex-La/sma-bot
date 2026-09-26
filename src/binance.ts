import { createHmac } from "node:crypto";

import { getJson } from "./signal.ts";


export interface SymbolFilters {
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
    orderId: number;
    clientOrderId: string;
    side: "BUY" | "SELL";
    executedQty: string;
    cummulativeQuoteQty: string;
}

type Params = Record<string, string | number>;

export class Binance {
    private offset = 0;
    private readonly baseUrl: string;
    private readonly key: string;
    private readonly secret: string;

    constructor(baseUrl: string, key: string, secret: string) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.key = key;
        this.secret = secret;
    }

    async req<T>(method: "GET" | "POST", path: string, params: Params = {}, signed = false): Promise<T> {
        const p = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
        if (signed) {
            p.set("timestamp", String(Math.round(Date.now() + this.offset)));
            p.set("recvWindow", "10000");
        }
        let q = p.toString();
        if (signed) q += `&signature=${createHmac("sha256", this.secret).update(q).digest("hex")}`;
        return getJson<T>(`${this.baseUrl}${path}${q ? `?${q}` : ""}`, {
            method,
            headers: { "X-MBX-APIKEY": this.key },
        });
    }

    async syncTime(): Promise<void> {
        const { serverTime } = await this.req<{ serverTime: number }>("GET", "/api/v3/time");
        this.offset = serverTime - Date.now();
    }

    async filters(symbol: string): Promise<SymbolFilters> {
        type F = { filterType: string; stepSize?: string; minNotional?: string };
        const info = await this.req<{ symbols: { baseAsset: string; quoteAsset: string; filters: F[] }[] }>(
            "GET", "/api/v3/exchangeInfo", { symbol },
        );
        const s = info.symbols[0];
        if (!s) throw new Error(`${symbol}: нет в exchangeInfo`);
        const f = (t: string) => s.filters.find((x) => x.filterType === t);
        const lot = f("LOT_SIZE");
        if (!lot?.stepSize) throw new Error(`${symbol}: нет LOT_SIZE`);
        return {
            base: s.baseAsset,
            quote: s.quoteAsset,
            step: lot.stepSize,
            minNotional: Number((f("NOTIONAL") ?? f("MIN_NOTIONAL"))?.minNotional ?? 5),
        };
    }

    async price(symbol: string): Promise<number> {
        const r = await this.req<{ price: string }>("GET", "/api/v3/ticker/price", { symbol });
        return Number(r.price);
    }

    async freeBalances(): Promise<Map<string, number>> {
        const acc = await this.req<{ balances: { asset: string; free: string }[] }>("GET", "/api/v3/account", {}, true);
        return new Map(acc.balances.map((b) => [b.asset, Number(b.free)]));
    }

    /**
     * Позиция и денежный поток корзины по всей истории ордеров бота.
     *
     * allOrders отдаёт максимум PAGE записей за запрос и без orderId — только САМЫЕ СВЕЖИЕ.
     * Поэтому историю обходим постранично от самого старого ордера: иначе после PAGE ордеров
     * по паре старые покупки выпадают из окна и позиция восстанавливается молча неверно.
     */
    async book(symbol: string, prefix: string): Promise<Book> {
        const PAGE = 1000;
        const MAX_PAGES = 100;
        let qty = 0;
        let cash = 0;
        let from = 0;
        for (let page = 0; ; page++) {
            if (page >= MAX_PAGES) {
                throw new Error(`${symbol}: больше ${MAX_PAGES * PAGE} ордеров — история не вычитана целиком`);
            }
            const orders = await this.req<Order[]>(
                "GET", "/api/v3/allOrders", { symbol, orderId: from, limit: PAGE }, true,
            );
            for (const o of orders) {
                if (!o.clientOrderId?.startsWith(prefix)) continue;
                const q = Number(o.executedQty);
                const c = Number(o.cummulativeQuoteQty);
                if (o.side === "BUY") {
                    qty += q;
                    cash -= c;
                } else {
                    qty -= q;
                    cash += c;
                }
            }
            if (orders.length < PAGE) break;
            from = Math.max(...orders.map((o) => o.orderId)) + 1;
        }
        return { qty: Math.max(qty, 0), cash };
    }

    async market(
        symbol: string,
        side: "BUY" | "SELL",
        amount: { quantity: string } | { quoteOrderQty: string },
        clientOrderId: string,
    ): Promise<Order> {
        return this.req<Order>(
            "POST",
            "/api/v3/order",
            { symbol, side, type: "MARKET", newOrderRespType: "RESULT", newClientOrderId: clientOrderId, ...amount },
            true,
        );
    }
}

export function floorToStep(x: number, step: string): string {
    const decimals = step.includes(".") ? (step.replace(/0+$/, "").split(".")[1] ?? "").length : 0;
    const s = Number(step);
    return (Math.floor(x / s + 1e-9) * s).toFixed(decimals);
}
