"""Synthetic OFFLINE fixtures only; no downloads/accounts/broker data."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'market-analysis' / 'python'))
import copy
import unittest
from analysis import analyze, AnalysisError, timestamp, stamp
from indicators import rsi, ema, atr_sma, confirmed_swings

START = timestamp('2026-10-22T12:00:00Z')


def fixture(n=40, prices=None, group='forex', tick=.00001):
    closes = prices if prices is not None else [100+i for i in range(n)]
    bars = [{'time': stamp(START+i*60000), 'open': c, 'high': c+.25, 'low': c-.25, 'close': c} for i, c in enumerate(closes)]
    return {'mode': 'offline-fixture', 'instrument': {'id': 'fixture:reference:fx:EURUSD', 'active': True, 'group': group,
            'metadata': {'tickSize': tick, 'priceBasis': 'mid', 'shortAllowed': True}},
            'bars': bars, 'from': stamp(START), 'to': stamp(START+len(bars)*60000), 'asOf': stamp(START+len(bars)*60000),
            'intervalMs': 60000, 'delayMs': 0, 'calendar': {'from': stamp(START), 'to': stamp(START+len(bars)*60000),
            'reference': 'synthetic offline UTC session', 'windows': [{'id': 'fixture', 'start': stamp(START), 'end': stamp(START+len(bars)*60000)}]}}


class Phase4Tests(unittest.TestCase):
    def test_wilder_rsi_reference_flat_and_warmup(self):
        self.assertEqual(rsi([10]*20), 50)
        self.assertEqual(rsi(list(range(20))), 100)
        self.assertEqual(rsi(list(range(20, 0, -1))), 0)
        self.assertIsNone(rsi([1, 2]))
        closes = [44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28]
        self.assertAlmostEqual(rsi(closes), 70.46413502109705)

    def test_existing_ema_first_close_seed(self):
        self.assertEqual(ema([1, 2, 3], 3), [1, 1.5, 2.25])

    def test_atr_mean_includes_gap_and_needs_previous_close(self):
        bars = [{'high': 11, 'low': 9, 'close': 10}, {'high': 16, 'low': 14, 'close': 15}, {'high': 18, 'low': 17, 'close': 17}]
        self.assertIsNone(atr_sma(bars[:2], 2))
        self.assertEqual(atr_sma(bars, 2), 4.5)

    def test_scanner_long_short_symmetry_and_criteria(self):
        up, down = analyze(fixture()), analyze(fixture(prices=list(range(140, 100, -1))))
        self.assertEqual(up['scan']['status'], 'READY')
        self.assertTrue(any(x['rule'] == 'CLOSE_BREAKOUT' and x['side'] == 'LONG' for x in up['scan']['observations']))
        self.assertTrue(any(x['rule'] == 'CLOSE_BREAKOUT' and x['side'] == 'SHORT' for x in down['scan']['observations']))
        self.assertEqual(up['scan']['indicators']['trend'], 'UP')
        self.assertEqual(down['scan']['indicators']['trend'], 'DOWN')
        self.assertEqual(up['quality']['usableForCurrentMonitoring'], False)
        self.assertEqual(up['scan']['observations'][0]['knownAt'], fixture()['asOf'])

    def test_flat_series_is_neutral_without_false_breakout(self):
        output = analyze(fixture(prices=[100]*40))
        self.assertEqual(output['scan']['observations'], [])
        self.assertEqual(output['scan']['indicators']['rsi'], 50)

    def test_warmup_and_parameter_bounds(self):
        self.assertEqual(analyze(fixture(10))['scan']['status'], 'WARMUP')
        for config in [{'slow': 1}, {'fast': 30, 'slow': 20}, {'unknown': 5}, {'swingRight': 100}, {'oversold': 80}]:
            request = fixture();request['rules'] = config
            with self.assertRaises(AnalysisError):
                analyze(request)

    def test_swings_not_known_until_right_confirmation_and_equal_highs_not_unique(self):
        request = fixture(prices=[1, 2, 4, 2, 1, 2])
        bars = [{**b, 'end': stamp(timestamp(b['time'])+60000)} for b in request['bars']]
        self.assertEqual(confirmed_swings(bars[:4], 2, 2), [])
        pivot = confirmed_swings(bars[:5], 2, 2)[0]
        self.assertEqual(pivot['pivotAt'], bars[2]['time'])
        self.assertEqual(pivot['knownAt'], bars[4]['end'])
        bars[3]['high'] = bars[2]['high']
        self.assertEqual(confirmed_swings(bars[:5], 2, 2), [])

    def test_gap_blocks_observations_but_explicit_closed_interval_is_not_gap(self):
        request = fixture();request['bars'].pop(10)
        result = analyze(request)
        self.assertEqual(result['scan']['status'], 'BLOCKED')
        self.assertEqual(result['quality']['missingBars'], 1)
        request['calendar']['windows'] = [
            {'id': 'a', 'start': request['from'], 'end': stamp(START+10*60000)},
            {'id': 'b', 'start': stamp(START+11*60000), 'end': request['to']}]
        self.assertEqual(analyze(request)['quality']['missingBars'], 0)

    def test_duplicates_conflicts_invalid_ohlc_and_timezone(self):
        request = fixture();request['bars'].append(copy.deepcopy(request['bars'][0]))
        self.assertEqual(analyze(request)['quality']['closedBars'], 40)
        request['bars'][-1]['close'] = 100.1
        with self.assertRaisesRegex(AnalysisError, 'BAR_CONFLICT'):
            analyze(request)
        for mutate in [lambda r: r['bars'][0].update(high=1), lambda r: r.update(asOf='2026-10-22T13:00:00'),
                       lambda r: r['bars'][0].update(close=float('nan')), lambda r: r.update(intervalMs=True)]:
            request = fixture();mutate(request)
            with self.assertRaises(AnalysisError):
                analyze(request)

    def test_unpublished_bars_cannot_trigger_or_change_last_observation(self):
        request = fixture();request['delayMs'] = 60000
        request['bars'][-1].update(high=999, close=999)
        output = analyze(request)
        self.assertEqual(output['quality']['excludedBars'], 1)
        self.assertEqual(output['quality']['closedBars'], 39)
        self.assertNotEqual(output['scan']['indicators']['priorHigh'], 999)

    def test_orb_symmetric_closed_bar_confirmation(self):
        for side, price, level in [('LONG', 102, 100.25), ('SHORT', 98, 99.75)]:
            request = fixture(prices=[100, 100, 100, price, price])
            request['entry'] = {'setup': 'orb', 'side': side, 'sessionId': 'fixture', 'openingRangeMinutes': 3}
            output = analyze(request)['entry']
            self.assertEqual(output['status'], 'CONDITION_OBSERVED')
            self.assertEqual(output['trigger']['knownAt'], stamp(START+4*60000))
            self.assertEqual(output['level'], level)

    def test_level_knowledge_cross_and_expiry(self):
        request = fixture(prices=[100, 102, 100, 102, 102])
        request['entry'] = {'setup': 'level', 'side': 'LONG', 'sessionId': 'fixture', 'level': 101,
                            'levelKnownAt': stamp(START+3*60000), 'condition': 'cross'}
        output = analyze(request)['entry']
        self.assertEqual(output['trigger']['knownAt'], stamp(START+4*60000))
        request['entry']['level'] = 1000
        self.assertEqual(analyze(request)['entry']['status'], 'EXPIRED')
        request['entry'].pop('levelKnownAt')
        with self.assertRaises(AnalysisError):
            analyze(request)

    def test_short_unknown_does_not_assume_permission(self):
        request = fixture();request['instrument']['metadata']['shortAllowed'] = None
        request['entry'] = {'setup': 'level', 'side': 'SHORT', 'sessionId': 'fixture', 'level': 200, 'levelKnownAt': request['from']}
        self.assertEqual(analyze(request)['entry']['status'], 'BLOCKED')
        self.assertFalse(any(x['side'] == 'SHORT' for x in analyze(request)['scan']['observations']))

    def test_exit_ticks_for_fx_jpy_gold_index_and_symmetric_short(self):
        cases = [(.00001, 'LONG', '1.08500', '1.083719', '1.08371', '1.08758'),
                 (.00001, 'SHORT', '1.08500', '1.086281', '1.08629', '1.08242'),
                 (.001, 'LONG', '158.125', '158.1001', '158.100', '158.175'),
                 (.05, 'LONG', '2400.25', '2398.023', '2398.00', '2404.75'),
                 (.25, 'LONG', '18500', '18497.9', '18497.75', '18504.50')]
        from decimal import Decimal
        for tick, side, entry, stop, expected_stop, expected_target in cases:
            request = fixture(tick=tick)
            request['exit'] = {'side': side, 'entry': entry, 'stop': {'kind': 'price', 'value': stop}, 'target': {'kind': 'r', 'value': 2}}
            result = analyze(request)['exit']
            self.assertEqual(Decimal(result['stop']), Decimal(expected_stop))
            self.assertEqual(Decimal(result['target']), Decimal(expected_target))
            self.assertFalse(result['maximumLossGuaranteed'])

    def test_exit_rules_wrong_directions_and_missing_metadata(self):
        request = fixture(tick=.25)
        request['exit'] = {'side': 'LONG', 'entry': 150, 'stop': {'kind': 'pct', 'value': 1}, 'target': {'kind': 'price', 'value': 154}}
        self.assertEqual(analyze(request)['exit']['stop'], '148.50')
        request['exit']['stop'] = {'kind': 'range_edge', 'from': request['from'], 'to': stamp(START+3*60000)}
        self.assertEqual(analyze(request)['exit']['stop'], '99.75')
        request['exit']['stop']['kind'] = 'range_mid'
        self.assertEqual(analyze(request)['exit']['stop'], '101.00')
        request['exit']['stop'] = {'kind': 'atr', 'value': 2}
        self.assertEqual(analyze(request)['exit']['status'], 'HYPOTHETICAL')
        request['exit']['stop'] = {'kind': 'price', 'value': 151}
        with self.assertRaisesRegex(AnalysisError, 'STOP_DIRECTION'):
            analyze(request)
        request['instrument']['metadata']['tickSize'] = None
        self.assertEqual(analyze(request)['exit']['status'], 'BLOCKED')

    def test_atr_plan_uses_only_history_known_at_plan_time(self):
        request = fixture(tick=.25)
        request['exit'] = {'side': 'LONG', 'entry': 150, 'planAt': stamp(START+30*60000), 'stop': {'kind': 'atr', 'value': 2}, 'target': {'kind': 'r', 'value': 2}}
        before = analyze(request)['exit']
        request['bars'][-1].update(high=10000, close=10000)
        self.assertEqual(analyze(request)['exit'], before)

    def test_signed_energy_requires_explicit_domain_and_rejects_forex(self):
        request = fixture(prices=[-20]*40, group='energy', tick=.01);request['priceDomain'] = 'signed'
        request['exit'] = {'side': 'LONG', 'entry': '-20.00', 'stop': {'kind': 'price', 'value': '-21.001'}, 'target': {'kind': 'r', 'value': 2}}
        self.assertEqual(analyze(request)['exit']['target'], '-17.98')
        request['instrument']['group'] = 'forex'
        with self.assertRaisesRegex(AnalysisError, 'SIGNED_PRICE'):
            analyze(request)

    def test_fixed_resource_bounds(self):
        request = fixture();request['bars'] = request['bars']*251
        with self.assertRaisesRegex(AnalysisError, 'BARS_LIMIT'):
            analyze(request)
        request = fixture();request['calendar']['windows'] *= 401
        with self.assertRaisesRegex(AnalysisError, 'SESSIONS_INVALID'):
            analyze(request)


if __name__ == '__main__':
    unittest.main()
