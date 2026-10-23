"""Reviewed one-shot runtime limits. Standard library only; no credentials/network."""
import sys


class RuntimeLimitError(Exception):
    pass


_job_handle = None


def install_limits(memory_mb=256):
    global _job_handle
    if sys.version_info < (3, 12):
        raise RuntimeLimitError('PYTHON_VERSION_UNSUPPORTED')
    if type(memory_mb) is not int or not 64 <= memory_mb <= 512:
        raise RuntimeLimitError('MEMORY_LIMIT_UNAVAILABLE')
    limit = memory_mb * 1024 * 1024
    try:
        if sys.platform == 'win32':
            import ctypes
            from ctypes import wintypes

            class Basic(ctypes.Structure):
                _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64),
                            ('flags', wintypes.DWORD), ('min_working', ctypes.c_size_t),
                            ('max_working', ctypes.c_size_t), ('active', wintypes.DWORD),
                            ('affinity', ctypes.c_size_t), ('priority', wintypes.DWORD),
                            ('scheduling', wintypes.DWORD)]

            class Extended(ctypes.Structure):
                _fields_ = [('basic', Basic), ('io', ctypes.c_uint64 * 6),
                            ('process_memory', ctypes.c_size_t), ('job_memory', ctypes.c_size_t),
                            ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]

            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
            kernel.CreateJobObjectW.restype = wintypes.HANDLE
            kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
            kernel.SetInformationJobObject.restype = wintypes.BOOL
            kernel.GetCurrentProcess.restype = wintypes.HANDLE
            kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            kernel.AssignProcessToJobObject.restype = wintypes.BOOL
            _job_handle = kernel.CreateJobObjectW(None, None)
            info = Extended()
            info.basic.flags = 0x100  # JOB_OBJECT_LIMIT_PROCESS_MEMORY
            info.process_memory = limit
            if not _job_handle or not kernel.SetInformationJobObject(_job_handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
                raise RuntimeLimitError('MEMORY_LIMIT_UNAVAILABLE')
            if not kernel.AssignProcessToJobObject(_job_handle, kernel.GetCurrentProcess()):
                raise RuntimeLimitError('MEMORY_LIMIT_UNAVAILABLE')
            mechanism = 'windows-job-process-memory'
        else:
            import resource
            resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
            resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
            mechanism = 'posix-rlimit-as-cpu'
    except RuntimeLimitError:
        raise
    except Exception:
        raise RuntimeLimitError('MEMORY_LIMIT_UNAVAILABLE') from None
    return {'protocol': 1, 'pythonVersion': '.'.join(map(str, sys.version_info[:3])),
            'memoryLimitMb': memory_mb, 'memoryEnforcement': mechanism}


def peak_memory_bytes():
    try:
        if sys.platform != 'win32':
            import resource
            value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            return value if sys.platform == 'darwin' else value * 1024
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [('size', wintypes.DWORD), ('faults', wintypes.DWORD)] + [
                (name, ctypes.c_size_t) for name in ('peak_working', 'working', 'peak_paged',
                 'paged', 'peak_nonpaged', 'nonpaged', 'pagefile', 'peak_pagefile')]

        counter = Counters()
        counter.size = ctypes.sizeof(counter)
        kernel = ctypes.WinDLL('kernel32')
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        psapi = ctypes.WinDLL('psapi')
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
        if psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counter), counter.size):
            return counter.peak_working
    except Exception:
        pass
    return None
