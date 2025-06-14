import React, { useState, useEffect, useRef } from "react";
import { RSI } from "technicalindicators";
import {
  Card,
  CardContent,
  Typography,
  CircularProgress,
  LinearProgress,
  Grid,
  Box,
} from "@mui/material";
import {
  ChartCanvas,
  Chart,
  CandlestickSeries,
  XAxis,
  YAxis,
  ZoomButtons,
  discontinuousTimeScaleProviderBuilder,
  PriceCoordinate,
} from "react-financial-charts";

/*********************************
 * CONFIG & GLOBAL CONSTANTS
 *********************************/
const WATCHED = ["BTCUSDT", "ETHUSDT", "BNBUSDT"];
const API_REST = "https://api.binance.com/api/v3/klines";
const WS_BASE = "wss://stream.binance.com:9443/ws";
// Scanner runs on 1‑hour candles
const INTERVAL = "1h";
// RSI is sourced from the higher 4‑hour timeframe
const RSI_INTERVAL = "4h";
const HISTORY_LIMIT = 500; // candles to keep per timeframe

/*********************************
 * DATA HELPERS
 *********************************/
async function fetchInitial(symbol, interval) {
  const url = `${API_REST}?symbol=${symbol}&interval=${interval}&limit=${HISTORY_LIMIT}`;
  const res = await fetch(url);
  const j = await res.json();
  return j.map((c) => ({
    date: new Date(c[0]),
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4],
    volume: +c[5],
  }));
}

function calcCMO(vals, p = 14) {
  const out = [];
  for (let i = p; i <= vals.length; i++) {
    const slice = vals.slice(i - p, i);
    let up = 0,
      down = 0;
    for (let j = 1; j < slice.length; j++) {
      const diff = slice[j] - slice[j - 1];
      diff > 0 ? (up += diff) : (down -= diff);
    }
    out.push(100 * ((up - down) / (up + down || 1)));
  }
  return out;
}

function indicators(closes, closes4h) {
  // 4‑hour RSI (period 14)
  const rsiSeries = RSI.calculate({ period: 14, values: closes4h });
  const rsi = rsiSeries.at(-1) ?? null;
  const rsiPrev = rsiSeries.at(-2) ?? null;
  // CMO still on 1‑hour closes
  const cmoSeries = calcCMO(closes, 14);
  const cmo = cmoSeries.at(-1) ?? null;
  const cmoPrev = cmoSeries.at(-2) ?? null;
  return { rsi, rsiPrev, cmo, cmoPrev };
}

function trend(candles) {
  const seg = candles.slice(-10);
  const hh = seg.every((d, i) => (i === 0 ? true : d.high >= seg[i - 1].high));
  const hl = seg.every((d, i) => (i === 0 ? true : d.low >= seg[i - 1].low));
  return hh && hl ? "up" : "down";
}

function score(flags) {
  return Object.values(flags).filter(Boolean).length; // number of true flags
}

function evaluate(sym, candles1h, closes4h) {
  if (candles1h.length < 30 || closes4h.length < 20) return null;
  const closes1h = candles1h.map((c) => c.close);
  const { rsi, rsiPrev, cmo, cmoPrev } = indicators(closes1h, closes4h);
  if (rsi == null || cmo == null) return null;

  const flags = {
    trendOK: trend(candles1h) === "up",
    rsiOK: (rsi <= 30 && rsi > rsiPrev) || (rsi >= 40 && rsi <= 60 && rsi > rsiPrev),
    cmoOK: cmo >= -100 && cmo <= -60 && cmo > cmoPrev,
    priceActionOK: candles1h.at(-1).close > candles1h.at(-1).open,
    supportOK: candles1h.at(-1).low <= Math.min(...candles1h.slice(-20).map((c) => c.low)) * 1.005,
    liquidityOK: true, // placeholder
  };

  const sc = score(flags);
  const valid = sc >= 5; // require at least 5/6 conditions

  // 🎯 Console debug
  console.debug(`[EVAL] ${sym}`, { ...flags, rsi, cmo, score: sc, valid });

  const lastClose = candles1h.at(-1).close;

  return {
    symbol: sym,
    rsi,
    cmo,
    score: sc,
    valid,
    flags,
    entry: lastClose,
    target: +(lastClose * 1.03).toFixed(4),
    stop: +(lastClose * 0.99).toFixed(4),
    updated: new Date(candles1h.at(-1).date).toLocaleTimeString(),
  };
}

/*********************************
 * CHART COMPONENT
 *********************************/
function CandleChart({ data, trade }) {
  if (!data?.length) return null;
  const scaleProvider = discontinuousTimeScaleProviderBuilder().inputDateAccessor((d) => d.date);
  const { data: d, xScale, xAccessor, displayXAccessor } = scaleProvider(data);
  const start = xAccessor(d[Math.max(0, d.length - 100)]);
  const end = xAccessor(d[d.length - 1]);
  return (
    <ChartCanvas
      height={400}
      width={800}
      ratio={1}
      margin={{ left: 50, right: 50, top: 10, bottom: 30 }}
      data={d}
      xScale={xScale}
      xAccessor={xAccessor}
      displayXAccessor={displayXAccessor}
      xExtents={[start, end]}
    >
      <Chart id={0} yExtents={(dd) => [dd.high, dd.low]}>
        <XAxis />
        <YAxis />
        <CandlestickSeries />
        {trade && (
          <>
            <PriceCoordinate
              at="right"
              orient="right"
              price={trade.entry}
              displayFormat={(n) => `Entry → ${n}`}
            />
            <PriceCoordinate
              at="right"
              orient="right"
              price={trade.target}
              displayFormat={(n) => `Target 🎯 ${n}`}
            />
            <PriceCoordinate
              at="right"
              orient="right"
              price={trade.stop}
              displayFormat={(n) => `Stop ✋ ${n}`}
            />
          </>
        )}
        <ZoomButtons />
      </Chart>
    </ChartCanvas>
  );
}

/*********************************
 * MAIN APP COMPONENT
 *********************************/
export default function App() {
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeSymbol, setActiveSymbol] = useState(null);
  const candleMap1h = useRef(new Map());
  const closes4hMap = useRef(new Map());

  const refresh = () => {
    const out = [];
    for (const sym of WATCHED) {
      const c1h = candleMap1h.current.get(sym) || [];
      const c4h = closes4hMap.current.get(sym) || [];
      const ev = evaluate(sym, c1h, c4h);
      if (ev) out.push(ev);
    }
    setSignals(out);
  };

  // WebSocket + initial REST + reconnect
  useEffect(() => {
    const wsMap = new Map();
    const timers = new Map();
    const openWS = (sym, retry = 0) => {
      const ws = new WebSocket(`${WS_BASE}/${sym.toLowerCase()}@kline_${INTERVAL}`);
      ws.onopen = () => {
        console.log("[WS] Connected", sym);
        retry = 0;
      };
      ws.onerror = (e) => console.error("[WS] error", sym, e);
      ws.onclose = () => {
        console.warn("[WS] closed", sym);
        const delay = Math.min(30_000, 2 ** retry * 1_000);
        timers.set(sym, setTimeout(() => openWS(sym, retry + 1), delay));
      };
      ws.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if (d.e !== "kline") return;
        const k = d.k;
        const candle = { date: new Date(k.t), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
        const arr = candleMap1h.current.get(d.s) || [];
        if (k.x) {
          candleMap1h.current.set(d.s, [...arr.slice(-HISTORY_LIMIT + 1), candle]);
          refresh();
        } else {
          const upd = [...arr];
          upd[upd.length - 1] = candle;
          candleMap1h.current.set(d.s, upd);
        }
      };
      wsMap.set(sym, ws);
    };

    (async () => {
      await Promise.all(
        WATCHED.map(async (s) => {
          candleMap1h.current.set(s, await fetchInitial(s, INTERVAL));
          const data4h = await fetchInitial(s, RSI_INTERVAL);
          closes4hMap.current.set(s, data4h.map((d) => d.close));
        })
      );
      setLoading(false);
      refresh();
      WATCHED.forEach(openWS);
    })();

    return () => {
      wsMap.forEach((ws) => ws.close());
      timers.forEach((t) => clearTimeout(t));
    };
  }, []);

  // periodic refresh every hour (safety)
  useEffect(() => {
    const id = setInterval(refresh, 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  /*************** RENDER ***************/
  return (
    <Box p={2}>
      <Typography variant="h4" gutterBottom>
        Crypto Trade Scanner (1h / 4h RSI)
      </Typography>
      {loading ? (
        <CircularProgress />
      ) : (
        <Grid container spacing={2}>
          {signals.map((s) => (
            <Grid
              item
              xs={12}
              md={6}
              lg={4}
              key={s.symbol}
              onClick={() => setActiveSymbol(s.symbol)}
              style={{ cursor: "pointer" }}
            >
              <Card variant="outlined">
                <CardContent>
                  <Typography variant="h6">{s.symbol}</Typography>
                  <Typography variant="body2">Updated: {s.updated}</Typography>
                  <Typography variant="body2">Score: {s.score}/6</Typography>
                  <Typography variant="body2" color={s.valid ? "green" : "red"}>
                    {s.valid ? "Valid Entry Signal ✅" : "Not Ready ❌"}
                  </Typography>
                  <LinearProgress variant="determinate" value={(s.score / 6) * 100} />
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      )}
      {activeSymbol && candleMap1h.current.has(activeSymbol) && (
        <Box mt={4}>
          <Typography variant="h5">{activeSymbol} – 1‑Hour Chart</Typography>
          <CandleChart data={candleMap1h.current.get(activeSymbol)} trade={signals.find((s) => s.symbol === activeSymbol)} />
        </Box>
      )}
    </Box>
  );
}
