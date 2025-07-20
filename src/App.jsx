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
  Snackbar,
  Alert,
} from "@mui/material";

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
const INTERVAL = "2h";
const RSI_INTERVAL = "4h";
const HISTORY_LIMIT = 500;
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

function trend(candles) {
  const seg = candles.slice(-10);
  const highs = seg.map((c) => c.high);
  const lows = seg.map((c) => c.low);
  const highSlope = highs[highs.length - 1] - highs[0];
  const lowSlope = lows[lows.length - 1] - lows[0];
  return highSlope > 0 && lowSlope > 0 ? "up" : "down";
}

function evaluateLong(sym, candles2h, closes4h) {
  if (candles2h.length < 20 || closes4h.length < 20) return null;
  const closes2h = candles2h.map((c) => c.close);
  const rsiSeries = RSI.calculate({ period: 14, values: closes2h });
  if (rsiSeries.length < 14) return null;

  const rsi = rsiSeries.at(-1);
  const rsiSMA = rsiSeries.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const isUptrend = trend(closes4h.map((c) => ({ high: c, low: c }))) === "up";

  let score = 0;
  const notes = [];

  if (isUptrend) {
    score += 5;
    notes.push("✅ Uptrend confirmed (05/10)");
  } else {
    notes.push("❌ Not in uptrend");
  }

  if (rsi > rsiSMA) {
    score += 5;
    notes.push("✅ 2H RSI above 14-period SMA (05/10)");
  } else {
    notes.push("❌ 2H RSI below 14-period SMA");
  }

  if (score === 10) notes.push("🎯 Both conditions confirmed (10/10)");

  const last = candles2h.at(-1);
  return {
    symbol: sym,
    rsi,
    smaRSI: rsiSMA,
    entry: last.close,
    target: +(last.close * 1.03).toFixed(4),
    stop: +(last.close * 0.99).toFixed(4),
    valid: true,
    type: "long",
    score,
    grade: score === 10 ? "💎 Strong" : "🟡 Moderate",
    notes,
    updated: new Date(last.date).toLocaleTimeString(),
  };
}

function SignalCard({ signal, price }) {
  const { symbol, updated, score, entry, target, stop, notes, grade } = signal;
  return (
    <Grid item xs={12} sm={6} md={4} lg={3}>
      <Card variant="outlined" sx={{ height: "100%", minHeight: 240, borderRadius: 2, boxShadow: 2 }}>
        <CardActionArea sx={{ p: 2 }}>
          <CardContent>
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
              <Typography variant="h6" fontWeight={700}>{symbol}</Typography>
              {price && <Chip label={`$${price.toFixed(4)}`} size="small" />}
            </Stack>
            <Typography variant="body2" sx={{ mt: 0.5 }}>⏱️ Updated: {updated}</Typography>
            <Typography variant="body2">🟢 Entry: <strong>{entry}</strong></Typography>
            <Typography variant="body2">🎯 Target: <strong>{target}</strong></Typography>
            <Typography variant="body2">⛔ Stop: <strong>{stop}</strong></Typography>

            <Box mt={1}>
              <LinearProgress variant="determinate" value={(score / 10) * 100} sx={{ height: 8, borderRadius: 5 }} />
              <Typography variant="caption">Score: {score}/10 — {grade}</Typography>
            </Box>

            <Box mt={1.5}>
              {notes.map((n, i) => (
                <Typography key={i} variant="body2" color="text.secondary">🧠 {n}</Typography>
              ))}
            </Box>
            <Typography variant="body2" sx={{ mt: 1 }}>📈 Type: <strong>LONG</strong></Typography>
          </CardContent>
        </CardActionArea>
      </Card>
    </Grid>
  );
}

export default function App() {
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [prices, setPrices] = useState({});
  const [snackMsg, setSnackMsg] = useState(null);

  const candleMap2h = useRef(new Map());
  const closes4hMap = useRef(new Map());

  useEffect(() => {
    const loadInitial = async () => {
      await Promise.all(
        WATCHED.map(async (s) => {
          const candles2h = await fetchInitial(s, INTERVAL);
          const data4h = await fetchInitial(s, RSI_INTERVAL);
          candleMap2h.current.set(s, candles2h);
          closes4hMap.current.set(s, data4h.map((d) => d.close));
        })
      );
      const signals = [];
      for (const sym of WATCHED) {
        const c2h = candleMap2h.current.get(sym) || [];
        const c4h = closes4hMap.current.get(sym) || [];
        const signal = evaluateLong(sym, c2h, c4h);
        if (signal) signals.push(signal);
      }
      setSignals(signals);
      setLoading(false);
    };
    loadInitial();
  }, []);

  return (
    <Box p={2}>
      <Typography variant="h4" fontWeight={700} gutterBottom textAlign="center">
        🧠 Crypto Long Trade Scanner
      </Typography>

      {loading ? (
        <Box display="flex" alignItems="center" justifyContent="center" height="60vh">
          <CircularProgress size={64} />
        </Box>
      ) : (
        <Grid container spacing={2}>
          {signals.map((s) => (
            <SignalCard key={s.symbol} signal={s} price={prices[s.symbol]} />
          ))}
        </Grid>
      )}

      <Snackbar open={!!snackMsg} autoHideDuration={3000} onClose={() => setSnackMsg(null)}>
        <Alert severity="info" variant="filled">{snackMsg}</Alert>
      </Snackbar>
    </Box>
  );
}
