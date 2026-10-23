"""Adapted build_pool/simulate/history_replay from audited MIT Time Machine.
No fetcher, NYSE slots, cents, broker, model calls or file writes.
"""
import random
import math
import json
import hashlib
import statistics
import sys
from analysis import validate, analyze, config, exit_plan, need, number, decimal, timestamp, stamp, AnalysisError
from risk import context, cost_context, plan as risk_plan, sequence_risk

VERSION='phase5.v1'


def fingerprint(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def summarize(values):
    ordered=sorted(values);n=len(ordered)
    def pct(q):return ordered[min(n-1,int(q*(n-1)))]
    return {'count':n,'mean':statistics.fmean(ordered),'median':statistics.median(ordered),
            'p05':pct(.05),'p95':pct(.95),'min':ordered[0],'max':ordered[-1]}


def pool_from(request):
    bars,windows,missing,excluded=validate(request)
    need(not missing and not excluded,'TRAINING_GAPS_OR_UNPUBLISHED')
    need(len(bars)>=30,'TRAINING_SAMPLE_TOO_SMALL')
    cutoff=timestamp(request['trainingEnd']);at=timestamp(request['asOf'])
    need(timestamp(request['to'])<=cutoff<=at,'TRAINING_LOOKAHEAD')
    need(timestamp(request['to'])<=timestamp(request['dataKnownAt'])<=at,'SNAPSHOT_NOT_YET_KNOWN')
    original={timestamp(b['time']):b for b in request['bars']}
    for bar in bars:
        known=original[bar['_time']].get('knownAt')
        if known:need(timestamp(known)<=at,'BAR_NOT_YET_KNOWN')
    used_windows=[w for w in windows if w['_start']<timestamp(request['to']) and w['_end']>timestamp(request['from'])]
    need(all(w['_start']>=timestamp(request['from']) and w['_end']<=timestamp(request['to']) for w in used_windows),'PARTIAL_TRAINING_SESSION')
    need(len(used_windows)>=20 or request['mode']=='offline-fixture' and request.get('allowSmallFixtureSample') is True,'TRAINING_SESSIONS_TOO_FEW')
    method=request.get('method','block-delta')
    need(method in ('slot-ratio','block-delta'),'METHOD_INVALID')
    if method=='slot-ratio':need(all(min(b[k] for k in ('open','high','low','close'))>0 for b in bars),'RATIO_REQUIRES_POSITIVE_PRICES')
    rows=[]
    for previous,bar in zip(bars,bars[1:]):
        session=next(w for w in windows if w['_start']<=bar['_time']<w['_end'])
        slot=(bar['_time']-session['_start'])//request['intervalMs']
        p=previous['close']
        moves=tuple(bar[k]/p if method=='slot-ratio' else bar[k]-p for k in ('open','high','low','close'))
        rows.append({'moves':moves,'elapsedMs':bar['_time']-previous['_time'],'slot':slot})
    return rows,bars,used_windows


def validate_plan(request):
    p=request['plan'];need(p.get('side') in ('LONG','SHORT'),'SIDE_INVALID')
    if p['side']=='SHORT':need(request['instrument'].get('metadata',{}).get('shortAllowed') is True,'SHORT_PERMISSION_UNKNOWN_OR_FALSE')
    e,s,t=[float(decimal(p[k])) for k in ('entry','stop','target')];sign=1 if p['side']=='LONG' else -1
    need(sign*(e-s)>0 and sign*(t-e)>0,'PLAN_DIRECTION_INVALID')
    tick=request['instrument'].get('metadata',{}).get('tickSize')
    need(tick is not None and decimal(tick)>0,'TICK_SIZE_UNKNOWN')
    need(math.ulp(max(abs(e),abs(s),abs(t)))<=float(tick)/4,'PRICE_PRECISION_EXCEEDS_FLOAT_CORE')
    need(all(decimal(x)%decimal(tick)==0 for x in (e,s,t)),'PLAN_OFF_TICK')
    signed=request.get('priceDomain')=='signed'
    need(signed or min(e,s,t)>0,'PLAN_PRICE_DOMAIN_INVALID')
    return e,s,t,sign,float(tick)


def barrier(bar,stop,target,sign):
    """Opening gap precedes intrabar extremes; double hits remain ambiguous."""
    o,h,l,c=bar
    if sign*(o-stop)<=0:return 'stop',o,o
    if sign*(o-target)>=0:return 'target',target,target  # Conservative favorable gap fill.
    hit_stop=l<=stop if sign==1 else h>=stop
    hit_target=h>=target if sign==1 else l<=target
    if hit_stop and hit_target:return 'ambiguous',stop,target
    if hit_stop:return 'stop',stop,stop
    if hit_target:return 'target',target,target
    return None,c,c


def trace(path,entry,stop,target,sign):
    """Close-sampled drawdown + conservative OHLC envelope, never false order."""
    peak=adverse_peak=entry*sign;dd=adverse_dd=0.0;elapsed=0
    for i,row in enumerate(path):
        o,h,l,c=row['prices'];elapsed+=row['elapsedMs']
        outcome,low_exit,high_exit=barrier((o,h,l,c),stop,target,sign)
        if outcome:
            # Order and excursions BEFORE an exit are unknown. Do not include
            # post-exit high/low in an exact realized-equity drawdown claim.
            mark=min(sign*low_exit,sign*high_exit)
            dd=max(dd,peak-mark)
            adverse_peak=max(adverse_peak,sign*(h if sign==1 else l))
            adverse_dd=max(adverse_dd,adverse_peak-min(mark,sign*(l if sign==1 else h)))
            return outcome,low_exit,high_exit,elapsed,dd,adverse_dd,i+1
        mark=sign*c;peak=max(peak,mark);dd=max(dd,peak-mark)
        adverse_peak=max(adverse_peak,sign*(h if sign==1 else l))
        adverse_dd=max(adverse_dd,adverse_peak-sign*(l if sign==1 else h))
    last=path[-1]['prices'][3]
    return 'neither',last,last,elapsed,dd,adverse_dd,len(path)


def money_model(request):
    try:
        ctx=context(request);risk_plan(request,ctx);cost=cost_context(request,request['plan']['side'])
        q=decimal(request['quantity']);need(q>=ctx['minimum'] and q%ctx['step']==0,'QUANTITY_OFF_STEP_OR_BELOW_MINIMUM')
        need(ctx['spec'].get('maxQuantity') is None or q<=decimal(ctx['spec']['maxQuantity']),'QUANTITY_ABOVE_MAXIMUM')
        multiplier=float(q*ctx['units']*ctx['fx'])
        fixed=float(cost['commissionPerQuantityRoundTrip']*q+cost['commissionFlatRoundTrip'])
        price_cost=float(cost['spreadPrice']+cost['entrySlippagePrice']+cost['exitSlippagePrice'])*multiplier
        funding=float(cost['funding']*q)
        return {'multiplier':multiplier,'fixed':fixed+price_cost,'fundingPerDay':funding,'currency':ctx['account']},None
    except (AnalysisError,KeyError) as error:
        return None,str(error) if isinstance(error,AnalysisError) else 'CONTRACT_QUANTITY_OR_COSTS_MISSING'


def simulate(request):
    pool,bars,windows=pool_from(request)
    e,s,t,sign,tick=validate_plan(request)
    tick_digits=max(0,-decimal(tick).as_tuple().exponent)
    count=request.get('paths',10000);horizon=request.get('horizonBars',60);seed=request.get('seed',19)
    need(type(count) is int and 1<=count<=10000,'PATH_LIMIT')
    need(type(horizon) is int and 1<=horizon<=240 and count*horizon<=2400000,'WORK_LIMIT')
    need(type(seed) is int and 0<=seed<=2**32-1,'SEED_INVALID')
    block=request.get('blockLength',5);need(type(block) is int and 1<=block<=60 and block<=len(pool),'BLOCK_LENGTH_INVALID')
    method=request.get('method','block-delta')
    start_slot=request.get('startSlot',1);window=request.get('slotWindow',2)
    need(type(start_slot) is int and 0<=start_slot<=10000 and type(window) is int and 0<=window<=20,'SLOT_INVALID')
    choices={}
    if method=='slot-ratio':
        for i in range(horizon):
            candidates=[r for r in pool if abs(r['slot']-(start_slot+i))<=window]
            need(candidates,'SLOT_POOL_EMPTY');choices[i]=candidates
    rng=random.Random(seed);model,net_error=money_model(request)
    initial_equity=float(decimal(request['equity'])) if request.get('equity') is not None else None
    need(initial_equity is None or initial_equity>0,'EQUITY_INVALID')
    counts={k:0 for k in ('target','stop','neither','ambiguous')}
    lower,upper,net_lower,net_upper,dds,upper_dds,net_dds,price_ends=[],[],[],[],[],[],[],[]
    samples=[];equity_samples=[];risk=sign*(e-s);maximum_steps=0
    for n in range(count):
        path=[];price=e;index=0
        for k in range(horizon):
            if method=='slot-ratio':
                row=rng.choice(choices[k]);prices=tuple(price*x for x in row['moves'])
            else:
                if k%block==0:index=rng.randrange(len(pool)-block+1)
                row=pool[index+k%block];prices=tuple(price+x for x in row['moves'])
            prices=tuple(round(round(x/tick)*tick,tick_digits) for x in prices)
            need(all(math.isfinite(x) and abs(x)<=1e15 for x in prices),'SIMULATION_PRICE_OVERFLOW')
            need(request.get('priceDomain')=='signed' or min(prices)>0,'SIMULATION_LEFT_POSITIVE_DOMAIN')
            path.append({'prices':prices,'elapsedMs':row['elapsedMs']});price=prices[3]
        outcome,a,b,elapsed,dd,udd,steps=trace(path,e,s,t,sign);counts[outcome]+=1;maximum_steps=max(maximum_steps,steps)
        gross_a=sign*(a-e);gross_b=sign*(b-e)
        lo,hi=sorted((gross_a,gross_b));lower.append(lo/risk);upper.append(hi/risk)
        dds.append(dd/risk);upper_dds.append(max(dd,udd)/risk);price_ends.append(price)
        if model:
            costs=model['fixed']+model['fundingPerDay']*elapsed/86400000
            net_lower.append(lo*model['multiplier']-costs);net_upper.append(hi*model['multiplier']-costs)
            net_dds.append(dd*model['multiplier']+model['fixed']+max(0,model['fundingPerDay']*elapsed/86400000))
            if initial_equity is not None and n<16:
                lows=[initial_equity-model['fixed']];highs=list(lows);held=0
                for j,row in enumerate(path):
                    if j<steps:
                        held+=row['elapsedMs']
                        low_mark=lo if j==steps-1 else sign*(row['prices'][3]-e)
                        high_mark=hi if j==steps-1 else low_mark
                        charges=model['fixed']+model['fundingPerDay']*held/86400000
                        lows.append(initial_equity+low_mark*model['multiplier']-charges)
                        highs.append(initial_equity+high_mark*model['multiplier']-charges)
                    else:
                        lows.append(lows[-1]);highs.append(highs[-1])
                equity_samples.append({'lower':lows,'upper':highs,'flatAfterExitStep':steps})
        if n<16:samples.append({'prices':[e]+[r['prices'][3] for r in path],'outcome':outcome,'exitStep':steps})
    net={'currency':model['currency'],'lower':summarize(net_lower),'upper':summarize(net_upper),
         'closeSampledDrawdownConservative':summarize(net_dds)} if model else None
    equity={'initial':initial_equity,'terminalLower':summarize([initial_equity+x for x in net_lower]),
            'terminalUpper':summarize([initial_equity+x for x in net_upper]),'samplePaths':equity_samples,
            'insolvencyFractionBounds':[sum(initial_equity+x<=0 for x in net_upper)/count,sum(initial_equity+x<=0 for x in net_lower)/count],
            'marginCallModelled':False} if model and initial_equity is not None else None
    return {'schemaVersion':VERSION,'category':'MODEL_SIMULATION','mode':request['mode'],'instrumentId':request['instrument']['id'],
        'dataQuality':{'reasons':request.get('qualityReasons',[]),'realtimeConfirmed':False,'usableForCurrentMonitoring':False,
                       'availability':'ASSERTED_SNAPSHOT_AT_DATA_KNOWN_AT'},
        'paths':count,'seed':seed,'method':method,'blockLength':block if method=='block-delta' else None,
        'runtime':{'implementation':sys.implementation.name,'python':list(sys.version_info[:3])},
        'parameters':{'intervalMs':request['intervalMs'],'slotWindow':window,'startSlot':start_slot,
                      'priceDomain':request.get('priceDomain','positive'),'quantity':request.get('quantity'),
                      'accountCurrency':request.get('accountCurrency'),
                      'contract':{k:(request.get('contract') or {}).get(k) for k in ('broker','reference','asOf','validUntil','unitsPerQuantity','tickSize','pipSize','quoteCurrency','quantityStep','minQuantity')},
                      'costs':{k:(request.get('costs') or {}).get(k) for k in ('reference','asOf','validUntil','currency','spreadPrice','entrySlippagePrice','exitSlippagePrice','commissionPerQuantityRoundTrip','commissionFlatRoundTrip','fundingPerQuantityPerDay')},
                      'conversion':{k:(request.get('conversion') or {}).get(k) for k in ('from','to','rate','asOf','maxAgeMs','source')}},
        'training':{'from':request['from'],'to':request['to'],'cutoff':request['trainingEnd'],'bars':len(bars),
                    'sessions':len(windows),'dataKnownAt':request['dataKnownAt'],'dataHash':fingerprint(request['bars']),
                    'closeDeltaStd':statistics.stdev([b['close']-a['close'] for a,b in zip(bars,bars[1:])]),
                    'sampleWarning':'SMALL_OFFLINE_FIXTURE_NOT_GENERALISABLE' if len(windows)<20 else None},
        'analysisAt':request['asOf'],'plan':request['plan'],'inputHash':fingerprint(request),
        'events':counts,'modelFractions':{k:v/count for k,v in counts.items()},
        'targetFirstFractionBounds':[counts['target']/count,(counts['target']+counts['ambiguous'])/count],
        'grossR':{'lower':summarize(lower),'upper':summarize(upper)},'net':net,'netUnavailableReason':net_error,'equity':equity,
        'drawdown':{'closeSampledR':summarize(dds),'ohlcEnvelopeUpperR':summarize(upper_dds),
                    'type':'SINGLE_POSITION_MARK_TO_MARKET_BOUNDS','lossStreak':None},
        'underlyingTerminalPrice':summarize(price_ends),'samplePaths':samples,'horizonBars':horizon,
        'assumptions':{'conditionalOnModel':True,'futurePredictionGuaranteed':False,'intrabarOrder':'UNKNOWN_DOUBLE_HITS',
          'timeModel':'RESAMPLED_HISTORICAL_ELAPSED_TIME','barrierBasis':'MID_REFERENCE',
          'fills':'HYPOTHETICAL_STATIC_SPREAD_BID_ASK_PLUS_ADVERSE_SLIPPAGE',
          'costsModelled':model is not None,'maximumLossGuaranteed':False,'sessionRegimePreserved':method=='slot-ratio',
          'costAccrual':'ROUND_TRIP_PROVISION_AT_ENTRY_PLUS_PRO_RATA_FUNDING',
          'bootstrapSerialDependence':'WITHIN_BLOCK_ONLY' if method=='block-delta' else 'NOT_PRESERVED',
          'bands':'NO_EXTRA_INDEPENDENT_FAN_RUN','pricePathIsNotEquity':True}}


def historical_setups(request):
    bars,windows,missing,excluded=validate(request)
    need(not missing and not excluded,'HISTORY_GAPS_OR_UNPUBLISHED')
    split=timestamp(request['trainingEnd']);eval_start=timestamp(request['evaluationStart'])
    need(split<=eval_start<timestamp(request['to']),'TRAIN_TEST_OVERLAP')
    need(timestamp(request['parametersKnownAt'])<=split,'PARAMETERS_NOT_FROZEN_BEFORE_EVALUATION')
    supplied={timestamp(b['time']):b for b in request['bars']}
    need(all(supplied[b['_time']].get('knownAt') and timestamp(supplied[b['_time']]['knownAt'])<=timestamp(b['end']) for b in bars),'HISTORICAL_AVAILABILITY_NOT_CONFIRMED')
    setup=request['setup'];need(setup.get('side') in ('LONG','SHORT'),'SIDE_INVALID')
    need(isinstance(setup.get('rule'),str) and setup['rule'] in ('CLOSE_BREAKOUT','SMA_RECLAIM','RSI_REBOUND','EMA_CROSS','CONFIRMED_SWING_CROSS','COMPRESSION_AFTER_RUN'),'SETUP_RULE_INVALID')
    cfg=config(request.get('rules',{}));horizon=request.get('horizonBars',30)
    need(type(horizon) is int and 1<=horizon<=240,'HORIZON_INVALID')
    candidates=[i for i,b in enumerate(bars) if b['_time']>=eval_start]
    need(len(candidates)<=500,'HISTORY_EVALUATION_LIMIT')
    trades=[];next_index=0;censored=0
    for i in candidates:
        if i<next_index or i+1>=len(bars):continue
        prefix=bars[max(0,i-499):i+1];raw=[supplied[b['_time']] for b in prefix]
        partial={**request,'bars':raw,'from':prefix[0]['time'],'to':bars[i]['end'],'asOf':bars[i]['end'],'entry':None,'exit':None}
        state=analyze(partial)['scan']
        if state['status']!='READY' or not any(x['side']==setup['side'] and x['rule']==setup['rule'] for x in state['observations']):continue
        if setup.get('trend') and state['indicators']['trend']!=setup['trend']:continue
        atr=state['indicators']['atrSma']
        if setup.get('minAtr') is not None and atr<number(setup['minAtr']):continue
        if setup.get('maxAtr') is not None and atr>number(setup['maxAtr']):continue
        if setup.get('sessionSlot') is not None:
            w=next(w for w in windows if w['_start']<=bars[i]['_time']<w['_end'])
            if (bars[i]['_time']-w['_start'])//request['intervalMs']!=setup['sessionSlot']:continue
        spec={**request['exitTemplate'],'side':setup['side'],'entry':bars[i]['close'],'planAt':bars[i]['end']}
        exit=exit_plan(prefix,spec,request['instrument']['metadata'],cfg,timestamp(bars[i]['end']),request.get('priceDomain')=='signed')
        if exit['status']!='HYPOTHETICAL':continue
        e,s,t=map(float,(exit['entry'],exit['stop'],exit['target']));sign=1 if setup['side']=='LONG' else -1
        future=bars[i+1:i+1+horizon]
        if len(future)<horizon:
            censored+=1;continue  # Right-censored observations excluded, not counted as no exit.
        path=[{'prices':tuple(b[k] for k in ('open','high','low','close')),'elapsedMs':b['_time']-bars[i+j]['_time']} for j,b in enumerate(future)]
        outcome,a,b,elapsed,dd,udd,steps=trace(path,e,s,t,sign);risk=sign*(e-s)
        lo,hi=sorted((sign*(a-e)/risk,sign*(b-e)/risk))
        model,net_error=money_model({**request,'plan':exit,'asOf':bars[i]['end']})
        net_bounds=None
        if model:
            cost=model['fixed']+model['fundingPerDay']*elapsed/86400000
            net_bounds=[lo*risk*model['multiplier']-cost,hi*risk*model['multiplier']-cost]
        trades.append({'entryKnownAt':bars[i]['end'],'exitKnownAt':future[steps-1]['end'],'plan':exit,'outcome':outcome,
                       'grossRBounds':[lo,hi],'netBounds':net_bounds,'netUnavailableReason':net_error,
                       'atrAtEntry':atr,'trendAtEntry':state['indicators']['trend']})
        next_index=i+steps+1  # No overlapping hypothetical positions.
    complete_net=bool(trades) and all(t['netBounds'] is not None for t in trades)
    net_values=[t['netBounds'][0] for t in trades] if complete_net else []
    cumulative=peak=drawdown=0.0;streak=longest=0
    for trade in trades:
        value=trade['grossRBounds'][0];cumulative+=value;peak=max(peak,cumulative);drawdown=max(drawdown,peak-cumulative)
        streak=streak+1 if value<0 else 0;longest=max(longest,streak)
    return {'schemaVersion':VERSION,'category':'HISTORICAL_OHLC_REPLAY','mode':request['mode'],'inputHash':fingerprint(request),
        'trainingEnd':request['trainingEnd'],'evaluationStart':request['evaluationStart'],'parameterTimestampAsserted':True,
        'setup':setup,'trades':trades,'count':len(trades),'grossRLower':summarize([t['grossRBounds'][0] for t in trades]) if trades else None,
        'outcomes':{k:sum(t['outcome']==k for t in trades) for k in ('target','stop','ambiguous','neither')},
        'sequenceLowerR':{'cumulativeR':cumulative,'maximumDrawdownR':drawdown,'longestLossStreak':longest} if trades else None,
        'netLower':summarize(net_values) if complete_net else None,'rightCensored':censored,
        'netSequenceLower':sequence_risk(net_values,request['equity']) if complete_net and request.get('equity') is not None else None,
        'executionObserved':False,'assumptions':['Observed OHLC barriers, hypothetical exits; no actual trade fills.',
           '500-bar trailing indicator window; frozen parameters, no optimization on evaluation data.',
           'Serial non-overlapping positions; incomplete future windows excluded.']}
