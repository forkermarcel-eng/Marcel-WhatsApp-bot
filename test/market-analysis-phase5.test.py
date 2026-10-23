"""All prices/specifications are synthetic offline fixtures, not broker facts."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'market-analysis/python'))
import unittest
import copy
from analysis import timestamp,stamp,AnalysisError,analyze
from time_machine import simulate,barrier,historical_setups,trace
from risk import calculate_risk,sequence_risk

START=timestamp('2026-10-22T00:00:00Z')


def fixture(n=80):
    end=stamp(START+n*60000)
    return {'operation':'time-machine','mode':'offline-fixture','allowSmallFixtureSample':True,
      'instrument':{'id':'fixture:offline:cfd:INDEX','kind':'cfd','active':True,'group':'indices','quote':'USD',
                    'metadata':{'tickSize':.25,'priceBasis':'mid','shortAllowed':True}},
      'from':stamp(START),'to':end,'asOf':end,'dataKnownAt':end,'trainingEnd':end,'intervalMs':60000,'delayMs':0,
      'calendar':{'from':stamp(START),'to':end,'reference':'synthetic UTC training session',
                  'windows':[{'id':'fixture','start':stamp(START),'end':end}]},
      'bars':[{'time':stamp(START+i*60000),'knownAt':stamp(START+(i+1)*60000),'open':100+i*.25,
               'high':100.5+i*.25,'low':99.5+i*.25,'close':100.25+i*.25} for i in range(n)],
      'plan':{'side':'LONG','entry':120,'stop':118,'target':124},'paths':100,'horizonBars':10,'seed':19,'method':'block-delta',
      'quantity':'2','accountCurrency':'USD','equity':'10000','holdingDays':'1',
      'contract':{'instrumentId':'fixture:offline:cfd:INDEX','kind':'cfd','broker':'OFFLINE-FIXTURE-ONLY',
                  'reference':'synthetic contract, not a provider offering','asOf':stamp(START),'validUntil':stamp(START+86400000),
                  'quoteCurrency':'USD','unitsPerQuantity':'1','tickSize':'.25','quantityStep':'1','minQuantity':'1','priceBasis':'mid'},
      'costs':{'reference':'explicit synthetic cost assumptions','asOf':stamp(START),'validUntil':stamp(START+86400000),
               'currency':'USD','spreadPrice':'.5','entrySlippagePrice':'.25','exitSlippagePrice':'.25',
               'commissionPerQuantityRoundTrip':'1','commissionFlatRoundTrip':'0','fundingPerQuantityPerDay':{'LONG':'.2','SHORT':'.1'}}}


class Phase5Tests(unittest.TestCase):
    def test_seed_reproducibility_and_input_fingerprint(self):
        r=fixture();price=100
        for i,b in enumerate(r['bars']):
            close=price+[-.5,.25,.75,-.25,0][i%5]
            b.update(open=price,high=max(price,close)+.25,low=min(price,close)-.25,close=close);price=close
        self.assertEqual(simulate(r),simulate(copy.deepcopy(r)))
        other=copy.deepcopy(r);other['seed']=20
        self.assertNotEqual(simulate(r)['inputHash'],simulate(other)['inputHash'])
        self.assertNotEqual(simulate(r)['samplePaths'],simulate(other)['samplePaths'])
        self.assertEqual(sum(simulate(r)['events'].values()),r['paths'])

    def test_positive_ratio_and_block_bootstrap_both_directions(self):
        for method in ('slot-ratio','block-delta'):
            for side in ('LONG','SHORT'):
                r=fixture();r['method']=method
                if side=='SHORT':r['plan']={'side':'SHORT','entry':120,'stop':122,'target':116}
                result=simulate(r);self.assertEqual(result['paths'],100)
                self.assertEqual(result['category'],'MODEL_SIMULATION')
                self.assertFalse(result['assumptions']['futurePredictionGuaranteed'])

    def test_barrier_order_ambiguous_gap_and_neither(self):
        self.assertEqual(barrier((100,106,94,100),95,105,1),('ambiguous',95,105))
        self.assertEqual(barrier((90,100,89,99),95,105,1),('stop',90,90))
        self.assertEqual(barrier((110,112,108,111),95,105,1),('target',105,105))
        self.assertEqual(barrier((100,102,98,101),95,105,1)[0],None)
        self.assertEqual(barrier((100,106,94,100),105,95,-1),('ambiguous',105,95))

    def test_double_hit_fractions_are_bounds_not_fake_order(self):
        r=fixture()
        for bar in r['bars']:bar.update(open=100,close=100,high=110,low=90)
        r['plan']={'side':'LONG','entry':100,'stop':95,'target':105}
        result=simulate(r);self.assertEqual(result['events']['ambiguous'],100)
        self.assertEqual(result['targetFirstFractionBounds'],[0,1])
        self.assertEqual(result['grossR']['lower']['mean'],-1)
        self.assertEqual(result['grossR']['upper']['mean'],1)
        curve=result['equity']['samplePaths'][0];self.assertEqual(curve['flatAfterExitStep'],1)
        self.assertEqual(len(set(curve['lower'][1:])),1)  # No post-exit underlying changes equity.

    def test_stop_gap_is_not_capped_at_minus_one_r(self):
        outcome,a,b,elapsed,dd,upper,steps=trace([{'prices':(90,92,88,91),'elapsedMs':60000}],100,95,105,1)
        self.assertEqual(outcome,'stop');self.assertEqual((a-100)/5,-2)
        self.assertGreaterEqual(upper,dd)
        adverse=trace([{'prices':(100,106,94,96),'elapsedMs':60000}],100,95,110,1)
        self.assertGreaterEqual(adverse[5],11)  # Possible favorable excursion before stop.

    def test_missing_costs_do_not_become_zero(self):
        r=fixture();del r['costs']['spreadPrice']
        result=simulate(r);self.assertIsNone(result['net']);self.assertEqual(result['netUnavailableReason'],'COSTS_INCOMPLETE')
        risk=calculate_risk(r);self.assertEqual(risk['status'],'GROSS_ONLY');self.assertIsNone(risk['net'])

    def test_costs_currency_conversion_and_risk_percent(self):
        r=fixture();result=calculate_risk(r)
        self.assertEqual(result['grossRisk'],'4')
        self.assertEqual(result['tickValueAccount'],'0.50')
        self.assertEqual(float(result['net']['plannedLoss']),8.4)
        self.assertEqual(float(result['grossRiskPercent']),.04)
        r['accountCurrency']='EUR';r['costs']['currency']='EUR'
        r['conversion']={'from':'USD','to':'EUR','rate':'.9','asOf':r['asOf'],'maxAgeMs':60000,'source':'synthetic offline FX'}
        result=calculate_risk(r);self.assertEqual(result['grossRisk'],'3.6')
        r['conversion']['from']='EUR';self.assertEqual(calculate_risk(r)['status'],'BLOCKED')

    def test_fx_units_pips_jpy_and_broker_variants(self):
        r=fixture();r['instrument'].update(kind='fx',group='forex',id='fixture:offline:fx:EURUSD')
        r['instrument']['metadata']['tickSize']=.00001
        r['contract'].update(kind='fx',instrumentId=r['instrument']['id'],unitsPerQuantity='100000',quantityStep='.01',minQuantity='.01',tickSize='.00001',pipSize='.0001')
        r['plan']={'side':'LONG','entry':'1.08500','stop':'1.08300','target':'1.08900'};r['quantity']='.1'
        result=calculate_risk(r);self.assertEqual(float(result['grossRisk']),20);self.assertEqual(float(result['pipValueAccount']),1)
        r['instrument']['metadata']['tickSize']=.001;r['contract'].update(tickSize='.001',pipSize='.01',quoteCurrency='JPY')
        r['instrument']['quote']='JPY';r['accountCurrency']='JPY';r['plan']={'side':'SHORT','entry':'158.125','stop':'158.325','target':'157.725'}
        self.assertEqual(float(calculate_risk(r)['pipValueAccount']),100)
        r['contract']['unitsPerQuantity']='10000';self.assertEqual(float(calculate_risk(r)['pipValueAccount']),10)

    def test_metals_and_energy_use_explicit_contracts(self):
        for symbol,units,tick in [('GOLD','100','.01'),('SILVER','5000','.001'),('OIL','1000','.01')]:
            r=fixture();r['instrument']['id']=symbol;r['instrument']['metadata']['tickSize']=float(tick)
            r['contract'].update(instrumentId=symbol,unitsPerQuantity=units,tickSize=tick)
            self.assertEqual(float(calculate_risk(r)['tickValueAccount']),2*float(units)*float(tick))

    def test_missing_contract_metadata_conversion_and_steps_block(self):
        for mutate in [lambda r:r.pop('contract'),lambda r:r['contract'].pop('unitsPerQuantity'),
                       lambda r:r.update(quantity='1.5'),lambda r:r['contract'].update(instrumentId='wrong'),
                       lambda r:r['contract'].update(validUntil=r['asOf']),lambda r:r.update(accountCurrency='EUR'),
                       lambda r:r['contract'].update(tickValueQuotePerQuantity=999),
                       lambda r:(r['plan'].update(side='SHORT',stop=122,target=116),r['instrument']['metadata'].update(shortAllowed=None))]:
            r=fixture();mutate(r);self.assertEqual(calculate_risk(r)['status'],'BLOCKED')

    def test_stale_fx_and_unknown_funding(self):
        r=fixture();r['accountCurrency']='EUR';r['costs']['currency']='EUR'
        r['conversion']={'from':'USD','to':'EUR','rate':1,'asOf':r['from'],'maxAgeMs':1,'source':'fixture'}
        self.assertEqual(calculate_risk(r)['reason'],'CONVERSION_STALE_OR_FUTURE')
        r=fixture();r['costs']['fundingPerQuantityPerDay'].pop('LONG')
        self.assertEqual(calculate_risk(r)['netUnavailableReason'],'FUNDING_UNKNOWN')

    def test_budget_sizing_rounds_down_includes_costs(self):
        r=fixture();r['riskBudget']='20'
        result=calculate_risk(r);self.assertEqual(result['budgetQuantity'],'4')
        r['contract']['maxQuantity']='2';self.assertEqual(calculate_risk(r)['budgetQuantity'],'2')
        r['riskBudget']='.01';self.assertIsNone(calculate_risk(r)['budgetQuantity'])

    def test_loss_sequence_drawdown_and_bankruptcy(self):
        result=sequence_risk([10,-5,-10,2,-1],100)
        self.assertEqual(result['maximumRealizedDrawdown'],'15');self.assertEqual(result['longestLossStreak'],2)
        self.assertTrue(sequence_risk([-200],100)['bankrupt'])

    def test_training_cutoffs_and_late_vintage_block(self):
        r=fixture();r['trainingEnd']=r['from']
        with self.assertRaisesRegex(AnalysisError,'LOOKAHEAD'):simulate(r)
        r=fixture();r['bars'][-1]['knownAt']=stamp(timestamp(r['asOf'])+60000)
        with self.assertRaisesRegex(AnalysisError,'BAR_NOT_YET_KNOWN'):simulate(r)

    def test_gaps_invalid_ohlc_and_resource_limits(self):
        r=fixture();r['bars'].pop(10)
        with self.assertRaisesRegex(AnalysisError,'GAPS'):simulate(r)
        for key,value in [('paths',10001),('horizonBars',241),('seed',-1),('blockLength',1000)]:
            r=fixture();r[key]=value
            with self.assertRaises(AnalysisError):simulate(r)
        r=fixture();r['bars'][0]['high']=0
        with self.assertRaises(AnalysisError):simulate(r)

    def test_overnight_break_elapsed_is_retained(self):
        r=fixture();gap=8*3600000
        for b in r['bars'][40:]:
            b['time']=stamp(timestamp(b['time'])+gap);b['knownAt']=stamp(timestamp(b['knownAt'])+gap)
        end=stamp(timestamp(r['to'])+gap)
        r.update(to=end,asOf=end,dataKnownAt=end,trainingEnd=end)
        r['calendar']={'from':r['from'],'to':end,'reference':'synthetic overnight break','windows':[
          {'id':'a','start':r['from'],'end':stamp(START+40*60000)},
          {'id':'b','start':stamp(START+40*60000+gap),'end':end}]}
        self.assertEqual(simulate(r)['training']['sessions'],2)

    def test_historical_setups_are_separate_and_use_frozen_rules(self):
        r=fixture();r.update(operation='historical-setups',trainingEnd=stamp(START+30*60000),evaluationStart=stamp(START+30*60000),parametersKnownAt=r['from'],horizonBars=3,
          setup={'side':'LONG','rule':'CLOSE_BREAKOUT','trend':'UP'},exitTemplate={'stop':{'kind':'pct','value':.5},'target':{'kind':'r','value':1}})
        result=historical_setups(r);self.assertEqual(result['category'],'HISTORICAL_OHLC_REPLAY');self.assertGreater(result['count'],0)
        self.assertFalse(result['executionObserved'])
        self.assertIsNotNone(result['netLower'])
        changed=copy.deepcopy(r);changed['bars'][-1].update(high=1000,close=1000)
        self.assertEqual(historical_setups(changed)['trades'][0]['plan'],result['trades'][0]['plan'])
        r['parametersKnownAt']=r['to']
        with self.assertRaisesRegex(AnalysisError,'FROZEN'):historical_setups(r)

    def test_history_without_original_availability_is_refused(self):
        r=fixture();r.update(trainingEnd=stamp(START+30*60000),evaluationStart=stamp(START+30*60000),parametersKnownAt=r['from'])
        r['bars'][0].pop('knownAt')
        with self.assertRaisesRegex(AnalysisError,'AVAILABILITY'):historical_setups(r)

    def test_phase4_exit_string_plan_and_signed_energy(self):
        r=fixture();p=analyze({**r,'exit':{'side':'LONG','entry':120,'stop':{'kind':'price','value':118},'target':{'kind':'r','value':2}}})['exit']
        r['plan']=p;self.assertEqual(simulate(r)['paths'],100)
        r=fixture();r['priceDomain']='signed';r['instrument']['group']='energy'
        for b in r['bars']:
            for k in ('open','high','low','close'):b[k]-=150
        r['plan']={'side':'LONG','entry':-30,'stop':-32,'target':-26}
        self.assertEqual(simulate(r)['method'],'block-delta')
        r['method']='slot-ratio'
        with self.assertRaisesRegex(AnalysisError,'POSITIVE'):simulate(r)


if __name__=='__main__':unittest.main()
