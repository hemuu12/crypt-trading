import React, { useState, useEffect, useRef } from "react";
import { RSI } from "technicalindicators";
import {
  Card,
  CardContent,
  CardActionArea,
  Typography,
  CircularProgress,
  LinearProgress,
  Grid,
  Box,
  Chip,
  Stack,
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
import { Snackbar, Alert } from "@mui/material";

/*********************************
 * CONFIG & GLOBAL CONSTANTS
 *********************************/

const WATCHED = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "ADAUSDT", "DOGEUSDT", "XRPUSDT", "DOTUSDT", "LTCUSDT", "BCHUSDT",
  "LINKUSDT", "XLMUSDT", "ATOMUSDT", "FILUSDT", "TRXUSDT", "ETCUSDT", "EOSUSDT", "AAVEUSDT", "UNIUSDT", "MKRUSDT",
  "NEARUSDT", "AVAXUSDT", "FTMUSDT", "GRTUSDT", "CRVUSDT", "SUSHIUSDT", "1INCHUSDT", "LDOUSDT", "OPUSDT",
  "ARBUSDT", "RNDRUSDT", "IMXUSDT", "FETUSDT", "COTIUSDT", "SANDUSDT", "MANAUSDT", "GALAUSDT", "APEUSDT",
  "PEPEUSDT", "SHIBUSDT", "SUIUSDT", "BONKUSDT", "JASMYUSDT", "XECUSDT", "LPTUSDT", "ZILUSDT", "ENJUSDT",
  "STORJUSDT", "SKLUSDT", "OCEANUSDT", "ANKRUSDT", "VETUSDT", "FLOWUSDT", "CHZUSDT", "ALGOUSDT", "HBARUSDT", "RLCUSDT",
  "TUSDUSDT", "KAVAUSDT", "BATUSDT", "DGBUSDT", "ONEUSDT", "SPELLUSDT", 
  "BALUSDT", "YFIUSDT", "ENSUSDT", "COMPUSDT", "BLURUSDT"
];


const API_REST = "https://api.binance.com/api/v3/klines";
const WS_BASE = "wss://stream.binance.us:9443/ws";
// Scanner runs on 1‑hour candles
const INTERVAL = "1h";
// RSI is sourced from the higher 4‑hour timeframe
const RSI_INTERVAL = "4h";
const HISTORY_LIMIT = 500; // candles to keep per timeframe

/*********************************
 * DATA HELPERS (unchanged)
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

function indicators(closes1h, closes4h) {
  // 4‑hour RSI (period 14)
  const rsiSeries = RSI.calculate({ period: 14, values: closes4h });

  // 14‑period SMA of that RSI
  const smaRSI =
    rsiSeries.length >= 14
      ? rsiSeries.slice(-14).reduce((a, b) => a + b, 0) / 14
      : null;

  // 1‑hour CMO (unchanged)
  const cmoSeries = calcCMO(closes1h, 14);

  return {
    rsi: rsiSeries.at(-1) ?? null,
    rsiPrev: rsiSeries.at(-2) ?? null,
    smaRSI,
    cmo: cmoSeries.at(-1) ?? null,
    cmoPrev: cmoSeries.at(-2) ?? null,
  };
}


function trend(candles) {
  const seg = candles.slice(-10);
  const highs = seg.map((c) => c.high);
  const lows = seg.map((c) => c.low);
  const highSlope = highs[highs.length - 1] - highs[0];
  const lowSlope = lows[lows.length - 1] - lows[0];
  return highSlope > 0 && lowSlope > 0 ? "up" : "down";
}


 /* === Candlestick helpers ================================== */
function isBullishEngulfing(prev, cur) {
  return (
    prev.close < prev.open &&          // red ➔
    cur.close > cur.open &&           // green ➔
    cur.open <= prev.close &&         // engulfs
    cur.close >= prev.open
  );
}
function isHammer(c) {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  return range > 3 * body && lowerWick > 2 * body && upperWick < 0.3 * body;
}
function bullishPattern(candles) {
  if (candles.length < 2) return false;
  const prev = candles.at(-2);
  const cur  = candles.at(-1);
  return (
    cur.close > cur.open ||
    isBullishEngulfing(prev, cur) ||
    isHammer(cur)
  );
}

/* === Liquidity‑grab filter (rough) ========================= */
function liquidityGrabPassed(c) {
  const body       = Math.abs(c.close - c.open);
  const lowerWick  = Math.min(c.open, c.close) - c.low;
  if (lowerWick > body * 2 && c.close > c.open) return true;   // bullish rejection
  if (lowerWick > body * 2 && c.close < c.open) return false;  // still hunting
  return true;
}

function liquidityGrabScore(candle, recentLows = []) {
  const body = Math.abs(candle.close - candle.open);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;

  let score = 0;

  if (lowerWick > body * 2) score += 40; // long wick → rejection
  if (candle.close > candle.open) score += 20; // bullish close

  const supportZone = Math.min(...recentLows);
  if (candle.low <= supportZone * 1.005 && candle.close > supportZone) score += 20; // fakeout recovery

  if (isHammer(candle)) score += 20; // hammer = rejection pattern

  return Math.min(score, 100);
}

function stopHuntProbabilityShort(candle, recentHighs = []) {
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);

  let score = 0;

  if (upperWick > body * 2) score += 40;
  if (candle.close < candle.open) score += 20;

  const resistance = Math.max(...recentHighs);
  if (candle.high >= resistance * 0.995 && candle.close < resistance) score += 20;

  return Math.min(score, 100);
}



function downtrend(candles) {
  const seg = candles.slice(-10);
  const lh = seg.every((d, i) => i === 0 || d.high <= seg[i - 1].high);
  const ll = seg.every((d, i) => i === 0 || d.low <= seg[i - 1].low);
  return lh && ll ? "down" : "up";
}

function evaluate(sym, candles1h, closes4h) {
  if (candles1h.length < 30 || closes4h.length < 20) return null;

  const closes1h = candles1h.map((c) => c.close);
  const { rsi, rsiPrev, smaRSI, cmo, cmoPrev } = indicators(closes1h, closes4h);
  if (rsi == null || smaRSI == null || cmo == null) return null;

  const last = candles1h.at(-1);

  // === RSI Logic ===
  const rsiFacingUp     = rsi > rsiPrev;
  const rsiAboveSMA     = rsi > smaRSI;
  const aboutToCrossSMA = rsiPrev < smaRSI && rsi >= smaRSI * 0.98;
  const notOverbought   = rsi < 80;
  const rsiOK = (rsiAboveSMA || aboutToCrossSMA) && rsiFacingUp && notOverbought;

  // === Other Flags ===
  const flags = {
    trendOK: trend(candles1h) === "up",
    rsiOK,
    cmoOK: cmo >= -100 && cmo <= -60 && cmo > cmoPrev,
    priceActionOK: bullishPattern(candles1h),
    supportOK:
      last.low <=
      Math.min(...candles1h.slice(-20).map((c) => c.low)) * 1.005,
    liquidityOK: liquidityGrabPassed(last),
  };

  const baseScore6 = Object.values(flags).filter(Boolean).length;
  const score10 = Math.round((baseScore6 / 6) * 10);

  if (!flags.trendOK) return null;
  const valid = score10 >= 7;

  const grade = score10 >= 9 ? "💎 Strong" : score10 >= 7 ? "🔥 Good" : "–";

  // 🧠 Detailed Notes
  const notes = [];
  if (flags.trendOK) notes.push("Uptrend confirmed");
  else notes.push("Uptrend not confirmed");
  
  if (flags.rsiOK) notes.push("RSI is rising and above/near SMA");
  else notes.push("RSI not favorable");

  if (flags.cmoOK) notes.push("CMO turning up from oversold zone");
  else notes.push("CMO not supportive");

  if (flags.priceActionOK) notes.push("Bullish price action detected");
  else notes.push("No bullish candle pattern");

  if (flags.supportOK) notes.push("Near strong support level");
  else notes.push("Support not clearly visible");

  if (flags.liquidityOK) notes.push("No signs of stop-hunt");
  else notes.push("Possible liquidity grab in progress");

  
const entry = last.close;
const recentLows = candles1h.slice(-20).map((c) => c.low);
const stopHuntProbability = liquidityGrabScore(last, recentLows);

// ❌ Skip if too risky
if (stopHuntProbability >= 70) {
  return {
    symbol: sym,
    valid: false,
    type: "long",
    score: score10,
    grade: "⚠️ Risky",
    notes: [...notes, "⚠️ High stop-hunt risk – avoid entry"],
    stopHuntProbability,
    updated: new Date(last.date).toLocaleTimeString(),
  };
}

  

  return {
    symbol: sym,
    rsi,
    smaRSI,
    cmo,
    score: score10,
    valid,
    type: "long",
    grade,
    notes,  // ✅ send array, not joined string
    entry,
    target: +(entry * 1.03).toFixed(4),
    stop: +(entry * 0.99).toFixed(4),
    updated: new Date(last.date).toLocaleTimeString(),
    stopHuntProbability
  };
}


function evaluateShort(sym, candles1h, closes4h) {
  if (candles1h.length < 30 || closes4h.length < 20) return null;

  const closes1h = candles1h.map((c) => c.close);
  const { rsi, rsiPrev, smaRSI, cmo, cmoPrev } = indicators(closes1h, closes4h);
  if (rsi == null || smaRSI == null || cmo == null) return null;

  const last = candles1h.at(-1);

  // === Downtrend Logic ===
  const isDowntrend = downtrend(candles1h) === "down";

  // === RSI Logic ===
  const rsiFalling = rsi < rsiPrev;
  const rsiBelowSMA = rsi < smaRSI;
  const notOversold = rsi > 20;
  const rsiOK = rsiBelowSMA && rsiFalling && notOversold;

  // === CMO Logic ===
  const cmoUTurn = cmo < cmoPrev && cmoPrev > 90;
  const cmoOK = cmo >= 50 && cmo <= 100 && cmoUTurn;

  // === Resistance Logic ===
  const nearResistance = last.high >= Math.max(...candles1h.slice(-20).map((c) => c.high)) * 0.995;

  const flags = {
    trendOK: isDowntrend,
    rsiOK,
    cmoOK,
    resistanceOK: nearResistance,
  };

  const score10 =
    (flags.trendOK ? 3 : 0) +
    (flags.rsiOK ? 3 : 0) +
    (flags.cmoOK ? 3 : 0) +
    (flags.resistanceOK ? 1 : 0);

  const valid = flags.trendOK && flags.rsiOK && flags.cmoOK;
  const almost = flags.trendOK && flags.rsiOK && !flags.cmoOK;

  const grade = valid
    ? score10 >= 9 ? "💎 Strong" : "🔥 Good"
    : almost ? "🕒 Almost" : "–";

  // 🧠 Notes for explanation
  const notes = [];
  if (flags.trendOK) notes.push("Downtrend confirmed");
  else notes.push("Trend not downward");

  if (flags.rsiOK) notes.push("RSI below SMA and falling");
  else if (!notOversold) notes.push("RSI oversold or turning up");
  else notes.push("RSI not aligned with downtrend");

  if (flags.cmoOK) notes.push("CMO U-turn from overbought zone");
  else notes.push("CMO not confirming reversal");

  if (flags.resistanceOK) notes.push("Near resistance zone");
  else notes.push("No clear resistance");

const entry = last.close;
const recentHighs = candles1h.slice(-20).map((c) => c.high);
const stopHuntProbability = stopHuntProbabilityShort(last, recentHighs);

// ❌ Skip if too risky
if (stopHuntProbability >= 70) {
  return {
    symbol: sym,
    valid: false,
    type: "short",
    score: score10,
    grade: "⚠️ Risky",
    notes: [...notes, "⚠️ High stop-hunt risk – avoid entry"],
    stopHuntProbability,
    updated: new Date(last.date).toLocaleTimeString(),
  };
}


  return {
    symbol: sym,
    rsi,
    smaRSI,
    cmo,
    score: score10,
    valid,
    almost,
    type: "short",
    grade,
    notes,  // ✅ return notes as array
    entry,
    stop: +(entry * 1.01).toFixed(4),
    target: +(entry * 0.97).toFixed(4),
    updated: new Date(last.date).toLocaleTimeString(),
    stopHuntProbability
  };
}



/*********************************
 * PRESENTATION HELPERS
 *********************************/
const scoreToColor = (s) =>
  s >= 9 ? "success.main" : s >= 7 ? "warning.main" : "error.main";


/*********************************
 * CARD COMPONENT (replace old SignalCard)
 *********************************/
function SignalCard({ signal, onSelect }) {
  const {
    symbol,
    updated,
    score,      // 0‑10
    grade,      // 💎 / 🔥 / –
    entry,
    target,
    stop,
    valid,
    notes,
    stopHuntProbability,
  } = signal;

  return (
    <Grid item xs={12} sm={6} lg={4}>
      <Card
        sx={{ height: "100%", borderColor: scoreToColor(score) }}
        variant="outlined"
      >
        <CardActionArea onClick={() => onSelect(symbol)} sx={{ height: "100%", p: 1 }}>
          <CardContent>
            {/* header row */}
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="space-between"
              spacing={1}
              mb={1}
            >
              <Typography variant="h6" fontWeight={600}>
                {symbol}
              </Typography>
              <Chip
                size="small"
                label={grade}
                color={valid ? "success" : "default"}
              />
            </Stack>

            <Typography variant="body2" gutterBottom>
              Updated: {updated}
            </Typography>

            {/* trade levels */}
            <Typography variant="caption" display="block">
              🟢 Entry: {entry}
            </Typography>
            <Typography variant="caption" display="block">
              🎯 Target: {target}
            </Typography>
            <Typography variant="caption" display="block">
              ⛔ Stop: {stop}
            </Typography>

            {/* score bar */}
            <LinearProgress
              variant="determinate"
              value={(score / 10) * 100}
              sx={{
                mt: 1,
                height: 8,
                borderRadius: 5,
                bgcolor: "grey.300",
                "& .MuiLinearProgress-bar": { bgcolor: scoreToColor(score) },
              }}
            />
            <Typography variant="caption" display="block" mt={0.5}>
              Score: {score}/10
            </Typography>

            {/* AI notes + Stop-Hunt */}
            {Array.isArray(notes) && notes.length > 0 && (
              <Box mt={1}>
                {notes.map((n, i) => (
                  <Typography
                    key={i}
                    variant="caption"
                    color="text.secondary"
                    display="block"
                  >
                    🧠 {n}
                  </Typography>
                ))}
                {typeof stopHuntProbability === "number" && (
                  <Typography variant="caption" display="block" color="warning.main" mt={0.5}>
                    🕵️ Stop-Hunt Probability: {stopHuntProbability}%
                  </Typography>
                )}
              </Box>
            )}

            {(valid || signal.almost) && (
              <Typography variant="body2">
                📉 Type: {signal.type === "short" ? "SHORT" : "LONG"}
              </Typography>
            )}
          </CardContent>
        </CardActionArea>
      </Card>
    </Grid>
  );
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
            <PriceCoordinate price={trade.entry} at="right" orient="right" displayFormat={(p) => `Entry → ${p}`}/>
            <PriceCoordinate price={trade.target} at="right" orient="right" displayFormat={(p) => `Target 🎯 ${p}`}/>
            <PriceCoordinate price={trade.stop} at="right" orient="right" displayFormat={(p) => `Stop ✋ ${p}`}/>
               {trade.type === "short" && (
      <PriceCoordinate price={trade.entry} at="left" orient="left" displayFormat={() => "⬇"} />
    )}
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
  const [filterType, setFilterType] = useState("all"); // 'all' | 'long' | 'short'

const [snackMsg, setSnackMsg] = useState(null);

  

  const candleMap1h = useRef(new Map());
  const closes4hMap = useRef(new Map());

  const refresh = () => {
    const longSignals = [];
    const shortSignals = [];

    for (const sym of WATCHED) {
      const c1h = candleMap1h.current.get(sym) || [];
      const c4h = closes4hMap.current.get(sym) || [];

      const long = evaluate(sym, c1h, c4h);
      if (long?.valid || long?.almost) {
        longSignals.push({ ...long, type: "long" });
      }

      const short = evaluateShort(sym, c1h, c4h);
      if (short?.valid || short?.almost) {
        shortSignals.push(short);
      }
    }

    setSignals([...longSignals, ...shortSignals]);
  };

 useEffect(() => {
  const stream = WATCHED.map((s) => `${s.toLowerCase()}@kline_${INTERVAL}`).join("/");
  const ws = new WebSocket(`wss://stream.binance.us:9443/stream?streams=${stream}`);

  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data?.data?.e !== "kline") return;

    const k = data.data.k;
    const sym = data.data.s;
    const candle = {
      date: new Date(k.t),
      open: +k.o,
      high: +k.h,
      low: +k.l,
      close: +k.c,
      volume: +k.v,
    };

    const arr = candleMap1h.current.get(sym) || [];
    if (k.x) {
      const updatedCandles = [...arr.slice(-HISTORY_LIMIT + 1), candle];
      candleMap1h.current.set(sym, updatedCandles);

      const closes4h = closes4hMap.current.get(sym) || [];
      const newLong = evaluate(sym, updatedCandles, closes4h);
      const newShort = evaluateShort(sym, updatedCandles, closes4h);

      if (newLong?.valid || newShort?.valid || newLong?.almost || newShort?.almost) {
        setSnackMsg(`${sym} → New ${newLong?.valid ? "LONG" : "SHORT"} Signal`);

        refresh();
      }
    } else {
      const upd = [...arr];
      upd[upd.length - 1] = candle;
      candleMap1h.current.set(sym, upd);
    }
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
  })();

  return () => {
    ws.close();
  };
}, []);


  useEffect(() => {
    const id = setInterval(refresh, 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const filteredSignals = signals.filter((s) => {
    if (!s.valid && !s.almost) return false;
    if (filterType === "long") return s.type !== "short";
    if (filterType === "short") return s.type === "short";
    return true;
  });

  return (
    <Box p={2}>
      <Typography variant="h4" fontWeight={700} gutterBottom>
        Crypto Trade Scanner
      </Typography>

      <Stack direction="row" spacing={2} mb={2}>
        <Chip
          label="All"
          variant={filterType === "all" ? "filled" : "outlined"}
          color="primary"
          onClick={() => setFilterType("all")}
        />
        <Chip
          label="LONG"
          variant={filterType === "long" ? "filled" : "outlined"}
          color="success"
          onClick={() => setFilterType("long")}
        />
        <Chip
          label="SHORT"
          variant={filterType === "short" ? "filled" : "outlined"}
          color="error"
          onClick={() => setFilterType("short")}
        />
      </Stack>

      {loading ? (
        <Box display="flex" alignItems="center" justifyContent="center" height="60vh">
          <CircularProgress size={64} />
        </Box>
      ) : (
        <Grid container spacing={2} mb={4}>
          {filteredSignals.map((s) => (
            <SignalCard key={s.symbol + s.type} signal={s} onSelect={setActiveSymbol} />
          ))}
        </Grid>
      )}

      {activeSymbol && candleMap1h.current.has(activeSymbol) && (
        <Box mt={2}>
          <Typography variant="h5" mb={1}>
            {activeSymbol} – 1‑Hour Chart
          </Typography>
          <CandleChart
            data={candleMap1h.current.get(activeSymbol)}
            trade={signals.find((s) => s.symbol === activeSymbol)}
          />
        </Box>
      )}
      <Snackbar open={!!snackMsg} autoHideDuration={3000} onClose={() => setSnackMsg(null)}>
  <Alert severity="info" variant="filled">{snackMsg}</Alert>
</Snackbar>

    </Box>
  );
}
