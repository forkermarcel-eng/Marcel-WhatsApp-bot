"""Pure arithmetic adapted from audited day-trader-skill. See NOTICE.md."""
import math


def rsi(closes, n=14):
    """Wilder RSI; flat prices explicitly neutral (upstream returned 100)."""
    if len(closes) < n + 1:
        return None
    gains = [max(0.0, b - a) for a, b in zip(closes, closes[1:])]
    losses = [max(0.0, a - b) for a, b in zip(closes, closes[1:])]
    ag, al = sum(gains[:n]) / n, sum(losses[:n]) / n
    for i in range(n, len(gains)):
        ag = (ag * (n - 1) + gains[i]) / n
        al = (al * (n - 1) + losses[i]) / n
    return 50.0 if ag == al == 0 else 100 - 100 / (1 + ag / al) if al else 100.0


def ema(closes, n):
    """Port of Trading/domain.js:ema; first-close seed, NOT SMA seed."""
    result, value = [], None
    k = 2 / (n + 1)
    for close in closes:
        value = close if value is None else close * k + value * (1 - k)
        result.append(value)
    return result


def atr_sma(bars, n=14):
    """Upstream atr_of arithmetic, with n+1 warmup and previous close gaps."""
    if len(bars) < n + 1:
        return None
    ranges = [max(b['high'] - b['low'], abs(b['high'] - a['close']),
                  abs(b['low'] - a['close'])) for a, b in zip(bars, bars[1:])]
    return sum(ranges[-n:]) / n


def find_setups(closes, cfg):
    """Adapted find_setups: symmetric, interval-neutral, no US stock filters."""
    fast, slow = ema(closes, cfg['fast']), ema(closes, cfg['slow'])
    r = rsi(closes, cfg['rsi'])
    prev_r = rsi(closes[:-1], cfg['rsi'])
    n = cfg['lookback']
    ma = sum(closes[-n:]) / n
    prev_ma = sum(closes[-n-1:-1]) / n
    high, low = max(closes[-n-1:-1]), min(closes[-n-1:-1])
    run = closes[-6] / closes[-16] - 1 if min(closes[-16:]) > 0 else None
    span = (max(closes[-5:]) - min(closes[-5:])) / closes[-1] if closes[-1] > 0 else None
    rules = []
    def add(test, rule, side, criteria):
        if test:
            rules.append({'rule': rule, 'side': side, 'criteria': criteria})
    add(closes[-1] > high, 'CLOSE_BREAKOUT', 'LONG', {'lookback': n, 'level': high})
    add(closes[-1] < low, 'CLOSE_BREAKOUT', 'SHORT', {'lookback': n, 'level': low})
    add(closes[-2] < prev_ma and closes[-1] > ma, 'SMA_RECLAIM', 'LONG', {'period': n})
    add(closes[-2] > prev_ma and closes[-1] < ma, 'SMA_RECLAIM', 'SHORT', {'period': n})
    add(r is not None and r < cfg['oversold'], 'RSI_EXTREME', 'LONG', {'threshold': cfg['oversold']})
    add(r is not None and r > cfg['overbought'], 'RSI_EXTREME', 'SHORT', {'threshold': cfg['overbought']})
    add(prev_r is not None and prev_r < cfg['oversold'] and closes[-1] > closes[-2], 'RSI_REBOUND', 'LONG', {'threshold': cfg['oversold']})
    add(prev_r is not None and prev_r > cfg['overbought'] and closes[-1] < closes[-2], 'RSI_REBOUND', 'SHORT', {'threshold': cfg['overbought']})
    tight = span is not None and span < cfg['flagRange']
    add(run is not None and run > cfg['flagRun'] and tight, 'COMPRESSION_AFTER_RUN', 'LONG', {'run': run, 'range': span})
    add(run is not None and run < -cfg['flagRun'] and tight, 'COMPRESSION_AFTER_RUN', 'SHORT', {'run': run, 'range': span})
    add(fast[-2] <= slow[-2] and fast[-1] > slow[-1], 'EMA_CROSS', 'LONG', {'fast': cfg['fast'], 'slow': cfg['slow']})
    add(fast[-2] >= slow[-2] and fast[-1] < slow[-1], 'EMA_CROSS', 'SHORT', {'fast': cfg['fast'], 'slow': cfg['slow']})
    return rules, {'rsi': r, 'previousRsi': prev_r, 'sma': ma, 'emaFast': fast[-1],
                   'emaSlow': slow[-1], 'priorHigh': high, 'priorLow': low,
                   'trend': 'UP' if fast[-1] > slow[-1] else 'DOWN' if fast[-1] < slow[-1] else 'FLAT'}


def confirmed_swings(bars, left, right):
    """Only strict pivots with right-side confirmation, no backdated knowledge."""
    result = []
    for i in range(left, len(bars) - right):
        neighbors = bars[i-left:i] + bars[i+1:i+right+1]
        for kind, field, compare in [('HIGH', 'high', max), ('LOW', 'low', min)]:
            value = bars[i][field]
            boundary = compare(b[field] for b in neighbors)
            if (kind == 'HIGH' and value > boundary) or (kind == 'LOW' and value < boundary):
                result.append({'kind': kind, 'price': value, 'pivotAt': bars[i]['time'],
                               'knownAt': bars[i+right]['end'], 'left': left, 'right': right})
    return result[-200:]
