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
} from "react-financial-charts";

/*********************************
 * CONFIG & GLOBAL CONSTANTS
 *********************************/
const WATCHED = ["BTCUSDT", "ETHUSDT", "BNBUSDT"];
const API_REST = "https://api.binance.com/api/v3/klines";
const WS_BASE = "wss://stream.binance.com:9443/ws";
const INTERVAL = "1m";
const HISTORY_LIMIT = 500; // candles to keep

/*********************************
 * DATA HELPERS
 *********************************/
async function fetchInitial(symbol) {
  const url = `${API_REST}?symbol=${symbol}&interval=${INTERVAL}&limit=${HISTORY_LIMIT}`;
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

function indicators(closes) {
  const r = RSI.calculate({ period: 14, values: closes });
  const c = calcCMO(closes, 14);
  return { rsi: r.at(-1) ?? null, rsiPrev: r.at(-2) ?? null, cmo: c.at(-1) ?? null, cmoPrev: c.at(-2) ?? null };
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

function evaluate(sym, candles) {
  if (candles.length < 30) return null;
  const closes = candles.map((c) => c.close);
  const { rsi, rsiPrev, cmo, cmoPrev } = indicators(closes);
  if (rsi == null || cmo == null) return null;

  const flags = {
    trendOK: trend(candles) === "up",
    rsiOK: (rsi <= 30 && rsi > rsiPrev) || (rsi >= 40 && rsi <= 60 && rsi > rsiPrev),
    cmoOK: cmo >= -100 && cmo <= -60 && cmo > cmoPrev,
    priceActionOK: candles.at(-1).close > candles.at(-1).open,
    supportOK: candles.at(-1).low <= Math.min(...candles.slice(-20).map((c) => c.low)) * 1.005,
    liquidityOK: true, // placeholder
  };

  const sc = score(flags);
  const valid = sc >= 5; // require at least 5/6 conditions

  // 🎯 Console debug
  console.debug(`[EVAL] ${sym}`, { ...flags, rsi, cmo, score: sc, valid });

  return {
    symbol: sym,
    rsi,
    cmo,
    score: sc,
    valid,
    flags,
    entry: candles.at(-1).close,
    target: +(candles.at(-1).close * 1.03).toFixed(4),
    stop: +(candles.at(-1).close * 0.99).toFixed(4),
    updated: new Date(candles.at(-1).date).toLocaleTimeString(),
  };
}

/*********************************
 * CHART COMPONENT
 *********************************/
function CandleChart({ data }) {
  if (!data?.length) return null;
  const scaleProvider = discontinuousTimeScaleProviderBuilder().inputDateAccessor((d) => d.date);
  const { data: d, xScale, xAccessor, displayXAccessor } = scaleProvider(data);
  const start = xAccessor(d[Math.max(0, d.length - 100)]);
  const end = xAccessor(d[d.length - 1]);
  return (
    <ChartCanvas height={400} width={800} ratio={1} margin={{ left: 50, right: 50, top: 10, bottom: 30 }} data={d} xScale={xScale} xAccessor={xAccessor} displayXAccessor={displayXAccessor} xExtents={[start, end]}>
      <Chart id={0} yExtents={(dd) => [dd.high, dd.low]}>
        <XAxis />
        <YAxis />
        <CandlestickSeries />
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
  const candleMap = useRef(new Map());

  const refresh = () => {
    const out = [];
    for (const sym of WATCHED) {
      const c = candleMap.current.get(sym) || [];
      const ev = evaluate(sym, c);
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
        const arr = candleMap.current.get(d.s) || [];
        if (k.x) {
          candleMap.current.set(d.s, [...arr.slice(-HISTORY_LIMIT + 1), candle]);
          refresh();
        } else {
          const upd = [...arr];
          upd[upd.length - 1] = candle;
          candleMap.current.set(d.s, upd);
        }
      };
      wsMap.set(sym, ws);
    };

    (async () => {
      await Promise.all(WATCHED.map(async (s) => candleMap.current.set(s, await fetchInitial(s))));
      setLoading(false);
      refresh();
      WATCHED.forEach(openWS);
    })();

    return () => {
      wsMap.forEach((ws) => ws.close());
      timers.forEach((t) => clearTimeout(t));
    };
  }, []);

  // fallback refresh every minute
  useEffect(() => {
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, []);

  /*************** RENDER ***************/
  return (
    <Box p={2}>
      <Typography variant="h4" gutterBottom>
        Crypto Trade Scanner (Debug Mode)
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
      {activeSymbol && candleMap.current.has(activeSymbol) && (
        <Box mt={4}>
          <Typography variant="h5">{activeSymbol} Chart</Typography>
          <CandleChart data={candleMap.current.get(activeSymbol)} />
        </Box>
      )}
    </Box>
  );
}