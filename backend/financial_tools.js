const yahooFinance = require('yahoo-finance2').default;

/**
 * Get real-time stock quote for a given ticker symbol.
 * @param {string} ticker - e.g. 'AAPL', 'RELIANCE.NS', 'TCS.NS'
 */
async function getStockPrice(ticker) {
    try {
        const quote = await yahooFinance.quote(ticker);
        return JSON.stringify({
            symbol: quote.symbol,
            name: quote.longName || quote.shortName,
            price: quote.regularMarketPrice,
            currency: quote.currency,
            change: quote.regularMarketChange?.toFixed(2),
            changePercent: quote.regularMarketChangePercent?.toFixed(2),
            open: quote.regularMarketOpen,
            high: quote.regularMarketDayHigh,
            low: quote.regularMarketDayLow,
            volume: quote.regularMarketVolume,
            marketCap: quote.marketCap,
            exchange: quote.fullExchangeName,
        });
    } catch (err) {
        throw new Error(`Failed to fetch stock data for ${ticker}: ${err.message}`);
    }
}

/**
 * Get upcoming IPO calendar from Yahoo Finance.
 */
async function getIpoCalendar() {
    try {
        const results = await yahooFinance.search('upcoming IPO 2026', { newsCount: 0, quotesCount: 0 });
        // Fetch screener for recently listed stocks as a proxy for IPO calendar
        const screener = await yahooFinance.screener({ scrIds: 'most_actives', count: 10 });
        const ipos = screener.quotes.map(q => ({
            symbol: q.symbol,
            name: q.longName || q.shortName,
            price: q.regularMarketPrice,
            change: q.regularMarketChangePercent?.toFixed(2) + '%',
        }));
        return JSON.stringify({ note: 'Most active stocks (IPO proxy)', ipos });
    } catch (err) {
        throw new Error(`Failed to fetch IPO calendar: ${err.message}`);
    }
}

module.exports = { getStockPrice, getIpoCalendar };
