"""Pure, broker-specific hypothetical risk arithmetic; no account/order access."""
from decimal import Decimal, ROUND_FLOOR
from analysis import need, decimal, timestamp, AnalysisError


def context(request):
    at = timestamp(request['asOf'])
    spec = request.get('contract')
    need(isinstance(spec, dict), 'CONTRACT_MISSING')
    need(spec.get('instrumentId') == request['instrument']['id'], 'CONTRACT_INSTRUMENT_MISMATCH')
    need(spec.get('kind') == request['instrument'].get('kind') and spec.get('kind') in ('fx','cfd','spot','future'), 'CONTRACT_KIND_MISMATCH')
    need(all(isinstance(spec.get(k), str) and spec[k].strip() for k in ('broker','reference','quoteCurrency')), 'CONTRACT_PROVENANCE_MISSING')
    need(timestamp(spec['asOf']) <= at < timestamp(spec['validUntil']), 'CONTRACT_EXPIRED_OR_FUTURE')
    need(spec.get('priceBasis') == 'mid', 'EXPLICIT_MID_COST_MODEL_REQUIRED')
    units, tick, step, minimum = [decimal(spec[k]) for k in ('unitsPerQuantity','tickSize','quantityStep','minQuantity')]
    need(min(units,tick,step,minimum)>0 and minimum%step==0, 'CONTRACT_UNITS_INVALID')
    if spec.get('maxQuantity') is not None:
        maximum=decimal(spec['maxQuantity']);need(maximum>=minimum and maximum%step==0,'MAX_QUANTITY_INVALID')
    metadata = request['instrument'].get('metadata', {})
    need(metadata.get('tickSize') is None or decimal(metadata['tickSize']) == tick, 'TICK_SPEC_MISMATCH')
    account = request.get('accountCurrency')
    need(isinstance(account,str) and len(account)==3 and account.isalpha() and account.isupper(), 'ACCOUNT_CURRENCY_REQUIRED')
    quote = spec['quoteCurrency']
    need(request['instrument'].get('quote') in (None,quote),'QUOTE_CURRENCY_MISMATCH')
    if spec.get('tickValueQuotePerQuantity') is not None:need(decimal(spec['tickValueQuotePerQuantity'])==tick*units,'TICK_VALUE_MISMATCH')
    if account == quote:
        fx = Decimal(1)
    else:
        conversion = request.get('conversion')
        need(isinstance(conversion,dict) and conversion.get('from')==quote and conversion.get('to')==account, 'CONVERSION_MISSING_OR_WRONG_DIRECTION')
        need(isinstance(conversion.get('source'),str) and conversion['source'].strip(), 'CONVERSION_SOURCE_REQUIRED')
        age = at-timestamp(conversion['asOf'])
        budget = conversion.get('maxAgeMs')
        need(type(budget) is int and budget>0 and 0<=age<=budget, 'CONVERSION_STALE_OR_FUTURE')
        fx=decimal(conversion['rate']);need(fx>0,'CONVERSION_RATE_INVALID')
    pip = decimal(spec['pipSize']) if spec.get('pipSize') is not None else None
    need(spec['kind']!='fx' or pip is not None and pip>0, 'PIP_SIZE_REQUIRED')
    need(pip is None or pip>0 and pip%tick==0, 'PIP_SIZE_INVALID')
    return {'spec':spec,'units':units,'tick':tick,'step':step,'minimum':minimum,'fx':fx,'pip':pip,'account':account}


def cost_context(request, side):
    costs=request.get('costs')
    need(isinstance(costs,dict),'COSTS_UNKNOWN')
    keys=('spreadPrice','entrySlippagePrice','exitSlippagePrice','commissionPerQuantityRoundTrip','commissionFlatRoundTrip')
    need(all(costs.get(k) is not None for k in keys),'COSTS_INCOMPLETE')
    values={k:decimal(costs[k]) for k in keys}
    need(all(v>=0 for v in values.values()),'COSTS_INVALID')
    funding=costs.get('fundingPerQuantityPerDay')
    need(isinstance(funding,dict) and funding.get(side) is not None,'FUNDING_UNKNOWN')
    values['funding']=decimal(funding[side])  # Signed charge; negative means credit.
    need(costs.get('currency')==request.get('accountCurrency'),'COST_CURRENCY_MISMATCH')
    need(isinstance(costs.get('reference'),str) and costs['reference'].strip(),'COST_PROVENANCE_REQUIRED')
    need(timestamp(costs['asOf'])<=timestamp(request['asOf'])<timestamp(costs['validUntil']),'COSTS_EXPIRED_OR_FUTURE')
    return values


def plan(request, ctx):
    p=request['plan'];need(p.get('side') in ('LONG','SHORT'),'SIDE_INVALID')
    if p['side']=='SHORT':
        need(request['instrument'].get('metadata',{}).get('shortAllowed') is True,'SHORT_PERMISSION_UNKNOWN_OR_FALSE')
    e,s,t=[decimal(p[k]) for k in ('entry','stop','target')]
    sign=1 if p['side']=='LONG' else -1
    need(sign*(e-s)>0 and sign*(t-e)>0,'PLAN_DIRECTION_INVALID')
    need(all(v%ctx['tick']==0 for v in (e,s,t)),'PLAN_OFF_TICK')
    signed=request.get('priceDomain')=='signed'
    need(not signed or request['instrument'].get('group')=='energy','SIGNED_PRICE_DOMAIN_NOT_SUPPORTED')
    need(signed or min(e,s,t)>0,'PLAN_PRICE_DOMAIN_INVALID')
    return e,s,t,sign


def sequence_risk(values, equity):
    need(isinstance(values,list) and 1<=len(values)<=10000,'SEQUENCE_LIMIT')
    initial=decimal(equity);need(initial>0,'EQUITY_INVALID')
    current=peak=initial;drawdown=Decimal(0);max_pct=Decimal(0);run=longest=0
    for raw in values:
        value=decimal(raw);current+=value;peak=max(peak,current)
        drawdown=max(drawdown,peak-current)
        if peak>0:max_pct=max(max_pct,(peak-current)/peak*100)
        run=run+1 if value<0 else 0;longest=max(longest,run)
    return {'initialEquity':str(initial),'endingEquity':str(current),'maximumRealizedDrawdown':str(drawdown),
            'maximumRealizedDrawdownPercent':str(max_pct),'longestLossStreak':longest,'bankrupt':current<=0}


def calculate_risk(request):
    try:
        ctx=context(request);e,s,t,sign=plan(request,ctx)
        quantity=decimal(request['quantity'])
        need(quantity>=ctx['minimum'] and quantity%ctx['step']==0,'QUANTITY_OFF_STEP_OR_BELOW_MINIMUM')
        if ctx['spec'].get('maxQuantity') is not None:need(quantity<=decimal(ctx['spec']['maxQuantity']),'QUANTITY_ABOVE_MAXIMUM')
        unit_value=ctx['units']*ctx['fx'];risk_distance=sign*(e-s);reward_distance=sign*(t-e)
        gross_risk=risk_distance*quantity*unit_value;gross_reward=reward_distance*quantity*unit_value
        result={'schemaVersion':'phase5.v1','category':'HYPOTHETICAL_RISK','mode':request.get('mode','unknown'),
                'status':'GROSS_ONLY','currency':ctx['account'],'quantity':str(quantity),'grossRisk':str(gross_risk),
                'grossReward':str(gross_reward),'grossRewardRisk':str(gross_reward/gross_risk),
                'tickValueAccount':str(ctx['tick']*quantity*unit_value),
                'pipValueAccount':str(ctx['pip']*quantity*unit_value) if ctx['pip'] is not None else None,
                'maximumLossGuaranteed':False,'margin':None,'net':None}
        equity=decimal(request['equity']) if request.get('equity') is not None else None
        need(equity is None or equity>0,'EQUITY_INVALID')
        result['grossRiskPercent']=str(gross_risk/equity*100) if equity else None
        try:
            costs=cost_context(request,request['plan']['side']);days=decimal(request['holdingDays']);need(days>=0,'HOLDING_DAYS_INVALID')
            price_cost=costs['spreadPrice']+costs['entrySlippagePrice']+costs['exitSlippagePrice']
            total=price_cost*quantity*unit_value+costs['commissionPerQuantityRoundTrip']*quantity+costs['commissionFlatRoundTrip']+costs['funding']*quantity*days
            net_loss=gross_risk+total;net_reward=gross_reward-total
            result.update(status='COMPLETE',net={'modeledCosts':str(total),'plannedLoss':str(net_loss),'plannedReward':str(net_reward),
                'rewardRisk':str(net_reward/net_loss) if net_loss>0 else None,'riskPercent':str(net_loss/equity*100) if equity else None})
            if request.get('riskBudget') is not None:
                budget=decimal(request['riskBudget']);need(budget>0,'RISK_BUDGET_INVALID')
                per_quantity=risk_distance*unit_value+price_cost*unit_value+costs['commissionPerQuantityRoundTrip']+max(Decimal(0),costs['funding']*days)
                need(per_quantity>0,'SIZING_MODEL_INVALID')
                sized=max(Decimal(0),((budget-costs['commissionFlatRoundTrip'])/per_quantity/ctx['step']).to_integral_value(rounding=ROUND_FLOOR)*ctx['step'])
                if ctx['spec'].get('maxQuantity') is not None:sized=min(sized,decimal(ctx['spec']['maxQuantity']))
                result['budgetQuantity']=str(sized) if sized>=ctx['minimum'] else None
        except (AnalysisError,KeyError) as error:
            result['netUnavailableReason']=str(error) if isinstance(error,AnalysisError) else 'HOLDING_DAYS_UNKNOWN'
        return result
    except (AnalysisError,KeyError) as error:
        return {'status':'BLOCKED','reason':str(error) if isinstance(error,AnalysisError) else 'CONTRACT_OR_PLAN_INCOMPLETE'}
