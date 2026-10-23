"""Bounded observation functions; no provider, broker, DB, clock or file I/O."""
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_FLOOR, ROUND_CEILING
from bisect import bisect_right
import math
from indicators import rsi, ema, atr_sma, find_setups, confirmed_swings


class AnalysisError(ValueError):
    pass


def need(condition, code):
    if not condition:
        raise AnalysisError(code)


def timestamp(text):
    need(isinstance(text, str) and len(text) <= 100, 'TIME_INVALID')
    try:
        dt = datetime.fromisoformat(text.replace('Z', '+00:00'))
        need(dt.tzinfo is not None and 'T' in text, 'TIMEZONE_REQUIRED')
        return int(dt.timestamp() * 1000)
    except (ValueError, OverflowError):
        raise AnalysisError('TIME_INVALID')


def stamp(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def number(value):
    need(type(value) in (int, float) and math.isfinite(value) and abs(value) <= 1e15, 'NUMBER_INVALID')
    return value


def decimal(value):
    need(type(value) in (int, float, str) and not isinstance(value, bool), 'DECIMAL_INVALID')
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        raise AnalysisError('DECIMAL_INVALID')
    need(result.is_finite() and abs(result) <= Decimal('1e15'), 'DECIMAL_INVALID')
    return result


def validate(request):
    need(isinstance(request, dict), 'REQUEST_INVALID')
    need(request.get('mode') in ('offline-fixture', 'historical'), 'MODE_REQUIRED')
    instrument = request.get('instrument', {})
    need(isinstance(instrument.get('id'), str) and instrument.get('active') is True, 'INSTRUMENT_REQUIRED')
    interval = request.get('intervalMs')
    need(type(interval) is int and 60000 <= interval <= 86400000, 'INTERVAL_INVALID')
    start, end, asof = [timestamp(request[k]) for k in ('from', 'to', 'asOf')]
    need(start < end <= asof and (end-start) // interval <= 10000, 'WINDOW_INVALID')
    need(start % interval == end % interval == 0, 'WINDOW_ALIGNMENT')
    delay = request.get('delayMs')
    need(delay is None or type(delay) is int and 0 <= delay <= 86400000, 'DELAY_INVALID')
    signed = request.get('priceDomain') == 'signed'
    need(request.get('priceDomain', 'positive') in ('positive', 'signed'), 'PRICE_DOMAIN_INVALID')
    need(not signed or instrument.get('group') == 'energy', 'SIGNED_PRICE_DOMAIN_NOT_SUPPORTED')
    calendar = request.get('calendar', {})
    need(timestamp(calendar.get('from')) <= start and timestamp(calendar.get('to')) >= end, 'SESSION_COVERAGE_UNKNOWN')
    need(isinstance(calendar.get('reference'), str) and bool(calendar['reference'].strip()), 'SESSION_REFERENCE_REQUIRED')
    windows = calendar.get('windows')
    need(isinstance(windows, list) and len(windows) <= 400, 'SESSIONS_INVALID')
    normalized = []
    for window in windows:
        a, b = timestamp(window['start']), timestamp(window['end'])
        need(a < b and b-a <= 48*3600000 and a % interval == b % interval == 0, 'SESSION_INVALID')
        need(isinstance(window.get('id'), str) and window['id'], 'SESSION_ID_REQUIRED')
        normalized.append({**window, '_start': a, '_end': b})
    normalized.sort(key=lambda w: w['_start'])
    need(len({w['id'] for w in normalized}) == len(normalized), 'SESSION_ID_DUPLICATE')
    need(all(a['_end'] <= b['_start'] for a, b in zip(normalized, normalized[1:])), 'SESSION_OVERLAP')
    starts = [w['_start'] for w in normalized]
    def in_session(at):
        i = bisect_right(starts, at) - 1
        return i >= 0 and at+interval <= normalized[i]['_end']
    bars = request.get('bars')
    need(isinstance(bars, list) and len(bars) <= 10000, 'BARS_LIMIT')
    by_time, excluded = {}, 0
    for raw in bars:
        at = timestamp(raw['time'])
        need(start <= at < end and at % interval == 0, 'BAR_WINDOW_INVALID')
        bar = {k: number(raw[k]) for k in ('open', 'high', 'low', 'close')}
        need(signed or min(bar.values()) > 0, 'PRICE_DOMAIN_INVALID')
        need(bar['low'] <= min(bar['open'], bar['close']) <= max(bar['open'], bar['close']) <= bar['high'], 'OHLC_INVALID')
        bar.update(time=stamp(at), end=stamp(at+interval), _time=at)
        need(at not in by_time or bar == by_time[at], 'BAR_CONFLICT')
        by_time[at] = bar
    closed = []
    for at, bar in sorted(by_time.items()):
        need(in_session(at), 'BAR_OUTSIDE_SESSION')
        if at+interval > asof-(delay or 0):
            excluded += 1
        else:
            closed.append(bar)
    known = {b['_time'] for b in closed}
    missing = [at for at in range(start, end, interval)
               if at+interval <= asof-(delay or 0) and in_session(at) and at not in known]
    return closed, normalized, missing, excluded


def config(raw):
    defaults = {'fast': 9, 'slow': 21, 'rsi': 14, 'atr': 14, 'lookback': 20,
                'swingLeft': 2, 'swingRight': 2, 'oversold': 30, 'overbought': 70,
                'flagRun': .10, 'flagRange': .05}
    need(isinstance(raw, dict) and set(raw) <= set(defaults), 'RULE_CONFIG_INVALID')
    defaults.update(raw)
    for key in ('fast', 'slow', 'rsi', 'atr', 'lookback'):
        need(type(defaults[key]) is int and 2 <= defaults[key] <= 250, 'PERIOD_INVALID')
    need(defaults['fast'] < defaults['slow'], 'EMA_PERIOD_ORDER')
    for key in ('swingLeft', 'swingRight'):
        need(type(defaults[key]) is int and 1 <= defaults[key] <= 20, 'SWING_PERIOD_INVALID')
    need(0 < number(defaults['oversold']) < number(defaults['overbought']) < 100, 'RSI_THRESHOLD_INVALID')
    need(0 < number(defaults['flagRun']) < 1 and 0 < number(defaults['flagRange']) < 1, 'FLAG_THRESHOLD_INVALID')
    return defaults


def scan(bars, cfg):
    warmup = max(30, cfg['slow']+1, cfg['lookback']+1, cfg['rsi']+2, cfg['atr']+1)
    if len(bars) < warmup:
        return {'status': 'WARMUP', 'requiredBars': warmup, 'availableBars': len(bars), 'observations': []}
    rules, indicators = find_setups([b['close'] for b in bars], cfg)
    indicators['atrSma'] = atr_sma(bars, cfg['atr'])
    swings = confirmed_swings(bars, cfg['swingLeft'], cfg['swingRight'])
    # Swings known AFTER the previous close cannot support a previous-close crossing.
    for kind, side in [('HIGH', 'LONG'), ('LOW', 'SHORT')]:
        known = [s for s in swings if s['kind'] == kind and timestamp(s['knownAt']) <= timestamp(bars[-2]['end'])]
        if known:
            pivot = known[-1]
            a, b, level = bars[-2]['close'], bars[-1]['close'], pivot['price']
            if (side == 'LONG' and a <= level < b) or (side == 'SHORT' and a >= level > b):
                rules.append({'rule': 'CONFIRMED_SWING_CROSS', 'side': side, 'criteria': pivot})
    for rule in rules:
        rule['knownAt'] = bars[-1]['end']
        rule['meaning'] = 'RULE_BASED_OBSERVATION'
    return {'status': 'READY', 'indicators': indicators, 'swings': swings,
            'observations': rules, 'criteria': cfg, 'requiredBars': warmup}


def entry(bars, windows, spec, asof, short_allowed, interval):
    need(isinstance(spec, dict), 'ENTRY_INVALID')
    need(spec.get('setup') in ('level', 'orb') and spec.get('side') in ('LONG', 'SHORT'), 'ENTRY_RULE_INVALID')
    if spec['side'] == 'SHORT' and short_allowed is not True:
        return {'status': 'BLOCKED', 'reason': 'SHORT_PERMISSION_UNKNOWN_OR_FALSE'}
    window = next((w for w in windows if w['id'] == spec.get('sessionId')), None)
    need(window is not None, 'ENTRY_SESSION_REQUIRED')
    until = timestamp(spec['expiresAt']) if spec.get('expiresAt') else window['_end']
    before = timestamp(spec['notBefore']) if spec.get('notBefore') else window['_start']
    need(window['_start'] <= before < until <= window['_end'], 'ENTRY_WINDOW_INVALID')
    series = [b for b in bars if window['_start'] <= b['_time'] < window['_end']]
    if spec['setup'] == 'orb':
        minutes = spec.get('openingRangeMinutes', 15)
        need(type(minutes) is int and 1 <= minutes <= 120, 'OPENING_RANGE_INVALID')
        range_end = window['_start'] + minutes*60000
        step = interval
        need(range_end < until and step > 0 and minutes*60000 % step == 0, 'OPENING_RANGE_ALIGNMENT')
        ranges = [b for b in series if timestamp(b['end']) <= range_end]
        if asof < range_end or len(ranges) != minutes*60000//step:
            return {'status': 'WAITING', 'reason': 'OPENING_RANGE_INCOMPLETE'}
        high, low = max(b['high'] for b in ranges), min(b['low'] for b in ranges)
        level = high if spec['side'] == 'LONG' else low
        known_at = range_end
    else:
        level = number(spec.get('level'))
        known_at = timestamp(spec.get('levelKnownAt'))
        high = low = None
    condition = spec.get('condition', 'close_beyond')
    need(condition in ('close_beyond', 'cross'), 'ENTRY_CONDITION_INVALID')
    previous, trigger = None, None
    for bar in series:
        finish = timestamp(bar['end'])
        beyond = bar['close'] > level if spec['side'] == 'LONG' else bar['close'] < level
        crossed = previous is not None and (previous <= level if spec['side'] == 'LONG' else previous >= level)
        if bar['_time'] >= known_at and finish >= before and finish <= until and beyond and (condition == 'close_beyond' or crossed):
            trigger = {'barStart': bar['time'], 'knownAt': bar['end'], 'close': bar['close']}
            break
        previous = bar['close']
    return {'status': 'CONDITION_OBSERVED' if trigger else 'EXPIRED' if asof >= until else 'WAITING',
            'side': spec['side'], 'condition': condition, 'priceBasis': 'closed-bar', 'level': level,
            'levelKnownAt': stamp(known_at), 'openingRange': {'high': high, 'low': low} if high is not None else None,
            'expiresAt': stamp(until), 'trigger': trigger, 'active': asof < until}


def exit_plan(bars, spec, metadata, cfg, asof, signed):
    """Adapted compute/atr_of: symmetric Decimal tick arithmetic, hypothetical only."""
    need(isinstance(spec, dict) and spec.get('side') in ('LONG', 'SHORT'), 'EXIT_INVALID')
    if spec['side'] == 'SHORT' and metadata.get('shortAllowed') is not True:
        return {'status': 'BLOCKED', 'reason': 'SHORT_PERMISSION_UNKNOWN_OR_FALSE'}
    if metadata.get('tickSize') is None or not metadata.get('priceBasis'):
        return {'status': 'BLOCKED', 'reason': 'TICK_SIZE_OR_PRICE_BASIS_UNKNOWN'}
    tick, e = decimal(metadata['tickSize']), decimal(spec.get('entry'))
    need(tick > 0 and (signed or e > 0) and e % tick == 0, 'ENTRY_TICK_OR_DOMAIN_INVALID')
    plan_at = timestamp(spec['planAt']) if spec.get('planAt') else asof
    need(plan_at <= asof, 'FUTURE_PLAN_INVALID')
    past = [b for b in bars if timestamp(b['end']) <= plan_at]
    stop, target = spec.get('stop', {}), spec.get('target', {})
    side = 1 if spec['side'] == 'LONG' else -1
    value = decimal(stop.get('value')) if stop.get('kind') in ('price', 'pct', 'atr') else None
    if stop.get('kind') == 'price':
        raw = value
    elif stop.get('kind') == 'pct':
        need(value > 0 and value < 100 and e > 0, 'PERCENT_STOP_INVALID')
        raw = e - side*e*value/100
    elif stop.get('kind') == 'atr':
        need(value > 0, 'ATR_MULTIPLIER_INVALID')
        atr = atr_sma(past, cfg['atr'])
        if atr is None:
            return {'status': 'WARMUP', 'reason': 'ATR_HISTORY_INCOMPLETE', 'requiredBars': cfg['atr']+1}
        raw = e - side*value*decimal(atr)
    elif stop.get('kind') in ('range_mid', 'range_edge'):
        a, b = timestamp(stop.get('from')), timestamp(stop.get('to'))
        selected = [bar for bar in past if a <= bar['_time'] and timestamp(bar['end']) <= b]
        step = timestamp(bars[0]['end'])-bars[0]['_time'] if bars else 0
        need(a < b <= plan_at and step > 0 and (b-a) % step == 0 and len(selected) == (b-a)//step, 'STOP_RANGE_INCOMPLETE')
        high, low = decimal(max(b['high'] for b in selected)), decimal(min(b['low'] for b in selected))
        raw = (high+low)/2 if stop['kind'] == 'range_mid' else low if side == 1 else high
    else:
        raise AnalysisError('STOP_RULE_INVALID')
    s = (raw/tick).to_integral_value(rounding=ROUND_FLOOR if side == 1 else ROUND_CEILING)*tick
    risk = side*(e-s)
    need(risk >= tick and (signed or s > 0), 'STOP_DIRECTION_OR_DOMAIN_INVALID')
    val = decimal(target.get('value'))
    need(target.get('kind') in ('r', 'price'), 'TARGET_RULE_INVALID')
    if target['kind'] == 'r':
        need(val > 0, 'TARGET_MULTIPLE_INVALID')
        val = e + side*val*risk
    t = (val/tick).to_integral_value(rounding=ROUND_CEILING if side == 1 else ROUND_FLOOR)*tick
    reward = side*(t-e)
    need(reward > 0 and (signed or t > 0), 'TARGET_DIRECTION_OR_DOMAIN_INVALID')
    fmt = lambda x: format(x, 'f')
    return {'status': 'HYPOTHETICAL', 'side': spec['side'], 'entry': fmt(e), 'stop': fmt(s), 'target': fmt(t),
            'riskDistance': fmt(risk), 'rewardDistance': fmt(reward), 'rewardRisk': fmt(reward/risk),
            'tickSize': fmt(tick), 'priceBasis': metadata['priceBasis'], 'planAt': stamp(plan_at),
            'costsIncluded': False, 'fillsModelled': False, 'maximumLossGuaranteed': False}


def analyze(request):
    bars, windows, missing, excluded = validate(request)
    cfg = config(request.get('rules', {}))
    metadata = request['instrument'].get('metadata', {})
    reasons = request.get('qualityReasons', [])
    need(isinstance(reasons, list) and len(reasons) <= 40 and all(isinstance(x, str) and len(x) <= 100 for x in reasons), 'QUALITY_REASONS_INVALID')
    reasons = list(reasons)
    if request['mode'] == 'offline-fixture':
        reasons.append('OFFLINE_FIXTURE')
    if request.get('delayMs') is None:
        reasons.append('DELAY_UNKNOWN')
    if missing:
        reasons.append('SESSION_GAPS')
    if not bars:
        reasons.append('NO_CLOSED_BARS')
    if excluded:
        reasons.append('UNPUBLISHED_BARS_EXCLUDED')
    base = {'schemaVersion': 'phase4.v1', 'purpose': 'OBSERVATION_ONLY', 'instrumentId': request['instrument']['id'],
            'mode': request['mode'], 'asOf': request['asOf'], 'intervalMs': request['intervalMs'],
            'quality': {'reasons': sorted(set(reasons)), 'closedBars': len(bars), 'excludedBars': excluded,
                        'missingBars': len(missing), 'missingSample': [stamp(t) for t in missing[:20]],
                        'realtimeConfirmed': False, 'usableForCurrentMonitoring': False}}
    if missing or not bars:
        return {**base, 'scan': {'status': 'BLOCKED', 'observations': []}, 'entry': None, 'exit': None}
    base['scan'] = scan(bars, cfg)
    if metadata.get('shortAllowed') is not True:
        base['scan']['observations'] = [r for r in base['scan']['observations'] if r['side'] != 'SHORT']
        base['quality']['reasons'] = sorted(set(base['quality']['reasons'] + ['SHORT_PERMISSION_UNKNOWN_OR_FALSE']))
    base['entry'] = entry(bars, windows, request['entry'], timestamp(request['asOf']), metadata.get('shortAllowed'), request['intervalMs']) if request.get('entry') else None
    base['exit'] = exit_plan(bars, request['exit'], metadata, cfg, timestamp(request['asOf']), request.get('priceDomain') == 'signed') if request.get('exit') else None
    return base
