"""Single JSON request over stdio. No CLI paths, provider access or shell."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import json
from runtime_limits import install_limits, RuntimeLimitError, peak_memory_bytes


def deny_external(event, args):
    if event in ('socket.connect', 'socket.getaddrinfo', 'subprocess.Popen', 'os.system'):
        raise PermissionError('External operation blocked')


def main():
    sys.addaudithook(deny_external)
    raw = sys.stdin.buffer.read(8000001)
    if len(raw) > 8000000:
        return {'ok': False, 'error': 'INPUT_LIMIT'}
    try:
        value = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if value == {'control': 'probe'}:
            return {'ok': True, 'results': []}
        requests = value.get('requests')
        if not isinstance(requests, list) or not 1 <= len(requests) <= 12:
            raise AnalysisError('REQUEST_LIMIT')
        if sum(len(r.get('bars', [])) for r in requests) > 30000:
            raise AnalysisError('TOTAL_BAR_LIMIT')
        work = 0
        for r in requests:
            if r.get('operation') == 'time-machine':
                n, h = r.get('paths',10000), r.get('horizonBars',60)
                if type(n) is int and type(h) is int:work += max(0,n)*max(0,h)
        if work > 2400000:
            raise AnalysisError('SIMULATION_WORK_LIMIT')
        results = []
        for request in requests:
            try:
                operation = request.get('operation','analyze')
                if operation == 'analyze':
                    result = analyze(request)
                else:
                    from time_machine import simulate, historical_setups
                    from risk import calculate_risk, sequence_risk
                    if operation == 'time-machine':result = simulate(request)
                    elif operation == 'historical-setups':result = historical_setups(request)
                    elif operation == 'risk':result = calculate_risk(request)
                    elif operation == 'sequence-risk':result = sequence_risk(request['pnl'],request['equity'])
                    else:raise AnalysisError('OPERATION_NOT_SUPPORTED')
                results.append({'ok': True, 'result': result})
            except AnalysisError as error:
                results.append({'ok': False, 'error': str(error)})
            except (KeyError, TypeError, ValueError, ArithmeticError, OverflowError, AttributeError):
                results.append({'ok': False, 'error': 'REQUEST_INVALID'})
        return {'ok': True, 'results': results}
    except AnalysisError as error:
        return {'ok': False, 'error': str(error)}
    except (ValueError, TypeError, AttributeError):
        return {'ok': False, 'error': 'INPUT_INVALID'}


if __name__ == '__main__':
    runtime = None
    try:
        memory_mb = 256
        if len(sys.argv) > 1:
            if len(sys.argv) != 2 or not sys.argv[1].startswith('--memory-mb='):
                raise RuntimeLimitError('MEMORY_LIMIT_UNAVAILABLE')
            memory_mb = int(sys.argv[1].split('=', 1)[1])
        runtime = install_limits(memory_mb)
        from analysis import analyze, AnalysisError
        result = main()
        runtime['peakWorkingSetBytes'] = peak_memory_bytes()
        result['runtime'] = runtime
        print(json.dumps(result, allow_nan=False, separators=(',', ':')))
    except RuntimeLimitError as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
    except MemoryError:
        print('{"ok":false,"error":"MEMORY_LIMIT"}')
    except Exception:
        print('{"ok":false,"error":"COMPUTE_FAILED"}')
