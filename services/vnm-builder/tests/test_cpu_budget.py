import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from cpu_budget import CpuCapacity, CompressionBudget, compression_budget, cpu_capacity, worker_count


class CpuCapacityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.proc = self.root / 'proc'
        (self.proc / 'self').mkdir(parents=True)
        self.group = self.root / 'cgroup space'
        self.group.mkdir()
        self.host = patch('cpu_budget.os.cpu_count', return_value=16)
        self.affinity = patch('cpu_budget.os.sched_getaffinity', return_value=set(range(16)))
        self.host.start(); self.affinity.start()

    def tearDown(self):
        self.affinity.stop(); self.host.stop(); self.temp.cleanup()

    def mount(self, kind='cgroup2', membership='/', mount_root='/'):
        (self.proc / 'self/cgroup').write_text(f'0::{membership}\n' if kind == 'cgroup2' else f'2:cpu,cpuacct:{membership}\n')
        mountpoint = str(self.group).replace(' ', '\\040')
        options = 'rw' if kind == 'cgroup2' else 'rw,cpu,cpuacct'
        (self.proc / 'self/mountinfo').write_text(f'1 0 0:1 {mount_root} {mountpoint} ro - {kind} cgroup {options}\n')

    def test_v2_quota_overrides_host_cpu_count(self):
        self.mount(); (self.group / 'cpu.max').write_text('800000 100000')
        result = cpu_capacity(self.proc)
        self.assertEqual((result.host, result.quota, result.workers), (16, 8, 8))

    def test_affinity_and_quota_use_the_tighter_limit(self):
        self.mount(); (self.group / 'cpu.max').write_text('800000 100000')
        with patch('cpu_budget.os.sched_getaffinity', return_value={1, 5, 9}):
            self.assertEqual(cpu_capacity(self.proc).workers, 3)

    def test_fractional_limits_round_down_with_one_worker_minimum(self):
        self.mount()
        for value, expected in [('250000 100000', 2), ('50000 100000', 1)]:
            (self.group / 'cpu.max').write_text(value)
            self.assertEqual(cpu_capacity(self.proc).workers, expected)

    def test_parent_quota_and_non_root_mount_are_respected(self):
        self.mount(membership='/docker/container/child', mount_root='/docker/container')
        child = self.group / 'child'; child.mkdir()
        (child / 'cpu.max').write_text('800000 100000')
        (self.group / 'cpu.max').write_text('200000 100000')
        self.assertEqual(cpu_capacity(self.proc).workers, 2)

    def test_v1_quota_is_supported(self):
        self.mount(kind='cgroup', membership='/nested')
        nested = self.group / 'nested'; nested.mkdir()
        (nested / 'cpu.cfs_quota_us').write_text('300000')
        (nested / 'cpu.cfs_period_us').write_text('100000')
        self.assertEqual(cpu_capacity(self.proc).workers, 3)

    def test_unlimited_missing_and_malformed_quota_fall_back_to_affinity(self):
        self.mount()
        for value in ['', 'max 100000', 'broken', '123 0', '-1 100000']:
            (self.group / 'cpu.max').write_text(value)
            with patch('cpu_budget.os.sched_getaffinity', return_value={2, 7}):
                self.assertEqual(cpu_capacity(self.proc).workers, 2)

    def test_missing_proc_or_affinity_still_has_a_safe_host_fallback(self):
        with patch('cpu_budget.os.sched_getaffinity', side_effect=OSError):
            self.assertEqual(cpu_capacity(self.root / 'missing').workers, 16)
        with patch('cpu_budget.os.cpu_count', return_value=None), patch('cpu_budget.os.sched_getaffinity', side_effect=OSError):
            self.assertEqual(cpu_capacity(self.root / 'missing').workers, 1)

    def test_explicit_worker_override_cannot_exceed_capacity_or_task_count(self):
        capacity = CpuCapacity(32, 16, 8, 8)
        for request, tasks, expected in [(0, 100, 8), (32, 100, 8), (2, 100, 2), (8, 3, 3), (-2, 100, 8)]:
            self.assertEqual(worker_count(request, capacity, tasks), expected)


class SharedBudgetTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_builds_share_remaining_capacity(self):
        budget = CompressionBudget()
        async with budget.reserve(3, 4) as first:
            async with budget.reserve(3, 4) as second:
                self.assertEqual((first, second, budget.in_use), (3, 1, 4))
            self.assertEqual(budget.in_use, 3)
        self.assertEqual(budget.in_use, 0)

    async def test_waiting_build_proceeds_after_capacity_is_released(self):
        budget = CompressionBudget(); acquired = asyncio.Event()
        async def waiting():
            async with budget.reserve(2, 2) as workers:
                acquired.set(); return workers
        async with budget.reserve(2, 2):
            waiter = asyncio.create_task(waiting())
            await asyncio.sleep(0)
            self.assertFalse(acquired.is_set())
        self.assertEqual(await asyncio.wait_for(waiter, 1), 2)
        self.assertEqual(budget.in_use, 0)

    async def test_cancelling_waiter_does_not_release_someone_elses_slots(self):
        budget = CompressionBudget()
        async def waiting():
            async with budget.reserve(1, 1):
                self.fail('Waiter should be cancelled before acquiring capacity')
        async with budget.reserve(1, 1):
            waiter = asyncio.create_task(waiting()); await asyncio.sleep(0); waiter.cancel()
            with self.assertRaises(asyncio.CancelledError): await waiter
            self.assertEqual(budget.in_use, 1)
        self.assertEqual(budget.in_use, 0)

    async def test_cancelled_active_build_releases_shared_capacity(self):
        budget = CompressionBudget(); acquired = asyncio.Event()
        async def active():
            async with budget.reserve(2, 2):
                acquired.set(); await asyncio.Event().wait()
        task = asyncio.create_task(active()); await acquired.wait(); task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertEqual(budget.in_use, 0)

    async def test_active_builds_use_the_same_event_loop_budget(self):
        async with compression_budget().reserve(1, 2):
            shared = compression_budget()
            self.assertEqual(shared.in_use, 1)
            async with shared.reserve(1, 2): self.assertEqual(shared.in_use, 2)
