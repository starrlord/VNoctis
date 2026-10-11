"""CPU allowance from affinity and visible Linux cgroup quotas."""
import asyncio
import math
import os
import re
import weakref
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


def _read(path):
    try:
        return path.read_text()
    except OSError:
        return ''


def _unescape(value):
    return re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), value)


def _quota_locations(proc_root):
    memberships = {}
    for line in _read(proc_root / 'self/cgroup').splitlines():
        parts = line.split(':', 2)
        if len(parts) == 3:
            for controller in parts[1].split(','):
                memberships[controller] = PurePosixPath(parts[2])
    for line in _read(proc_root / 'self/mountinfo').splitlines():
        parts = line.split(' - ', 1)
        if len(parts) != 2:
            continue
        mount, filesystem = parts[0].split(), parts[1].split()
        if len(mount) < 6 or len(filesystem) < 3:
            continue
        kind = filesystem[0]
        if kind == 'cgroup2':
            group = memberships.get('')
        elif kind == 'cgroup' and 'cpu' in filesystem[2].split(','):
            group = memberships.get('cpu')
        else:
            continue
        if group is None:
            continue
        root = PurePosixPath(_unescape(mount[3]))
        base = Path(_unescape(mount[4]))
        try:
            relative = group.relative_to(root)
        except ValueError:
            continue
        if '..' in relative.parts:
            continue
        directory = base.joinpath(*relative.parts)
        # A parent may impose a tighter quota than the leaf cgroup.
        while directory.is_relative_to(base):
            yield directory, kind
            if directory == base:
                break
            directory = directory.parent


@dataclass(frozen=True)
class CpuCapacity:
    host: int
    affinity: int
    quota: float | None
    workers: int


def cpu_capacity(proc_root=Path('/proc')):
    host = os.cpu_count() or 1
    try:
        affinity = len(os.sched_getaffinity(0)) or host
    except (AttributeError, OSError):
        affinity = host
    quotas = []
    for directory, kind in _quota_locations(Path(proc_root)):
        try:
            if kind == 'cgroup2':
                quota, period = _read(directory / 'cpu.max').split()
                if quota == 'max':
                    continue
            else:
                quota = _read(directory / 'cpu.cfs_quota_us').strip()
                period = _read(directory / 'cpu.cfs_period_us').strip()
            quota, period = int(quota), int(period)
            if quota > 0 and period > 0:
                quotas.append(quota / period)
        except (ValueError, OverflowError):
            continue
    quota = min(quotas) if quotas else None
    available = min(host, affinity, quota if quota is not None else host)
    return CpuCapacity(host, affinity, quota, max(1, math.floor(available)))


def worker_count(requested, capacity, images):
    return max(1, min(requested if requested > 0 else capacity.workers, capacity.workers, images))


class CompressionBudget:
    """Reserve worker slots across simultaneous builds in the builder process."""
    def __init__(self):
        self.condition = asyncio.Condition()
        self.in_use = 0

    @asynccontextmanager
    async def reserve(self, requested, limit):
        async with self.condition:
            await self.condition.wait_for(lambda: self.in_use < limit)
            workers = min(requested, limit - self.in_use)
            self.in_use += workers
        try:
            yield workers
        finally:
            async with self.condition:
                self.in_use -= workers
                self.condition.notify_all()


_budgets = weakref.WeakKeyDictionary()


def compression_budget():
    # Keep event-loop ownership explicit (also supports isolated async tests).
    loop = asyncio.get_running_loop()
    reference = _budgets.get(loop)
    budget = reference() if reference else None
    if budget is None:
        budget = CompressionBudget()
        _budgets[loop] = weakref.ref(budget)
    return budget
