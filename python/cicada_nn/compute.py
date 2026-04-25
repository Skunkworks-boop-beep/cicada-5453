"""
Central compute configuration for CICADA-5453.

The backend was running single-threaded backtests and under-using the GPU when
CUDA was available. This module is the single place that answers:

* How many worker processes should I use for a parallel backtest?
* Am I supposed to use a GPU? Which one? With TF32?
* How aggressive can I be with throttling before the box becomes unresponsive?

Everything is env-overridable so the same code runs on laptops, on a research
workstation, and on a remote GPU box without code changes.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional


logger = logging.getLogger(__name__)


def _env_int(name: str, default: int, *, lo: int = 1, hi: int = 256) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        v = int(raw)
    except ValueError:
        return default
    return max(lo, min(hi, v))


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def cpu_count_safe() -> int:
    """Return the number of CPUs usable by the process.

    Respects cgroup cpu.max / quota-period (Docker, Kubernetes) via
    ``os.sched_getaffinity`` where available; falls back to ``os.cpu_count``.
    """
    try:
        return len(os.sched_getaffinity(0))
    except AttributeError:  # pragma: no cover - non-POSIX
        return os.cpu_count() or 1


@dataclass(frozen=True)
class ComputeConfig:
    """Resolved compute knobs for the current process."""

    cpu_count: int
    backtest_workers: int
    research_workers: int
    throttle_reserved_cores: int
    torch_num_threads: int
    use_cuda: bool
    device_str: str
    cuda_device_count: int
    cuda_devices: list[str]
    use_multi_gpu: bool
    enable_tf32: bool
    dataloader_workers: int
    pin_memory: bool


def resolve_compute_config() -> ComputeConfig:
    """Derive a single consistent view of compute resources.

    Env overrides:
      CICADA_WORKERS            - default worker cap (backtest/research)
      CICADA_BACKTEST_WORKERS   - override for backtest parallelism
      CICADA_RESEARCH_WORKERS   - override for research / grid runs
      CICADA_RESERVE_CORES      - reserve N cores for the OS/UI (default 1)
      CICADA_DISABLE_CUDA=1     - force CPU even when CUDA is available
      CICADA_DISABLE_MULTI_GPU=1 - use only cuda:0 even when multiple GPUs are visible
      CICADA_TF32=0             - disable TF32 matmul (default on)
      CICADA_DATALOADER_WORKERS - DataLoader num_workers (default min(4, cpu-1))
      CICADA_PIN_MEMORY=0       - disable pinned memory
    """
    cpu = max(1, cpu_count_safe())
    reserve = _env_int("CICADA_RESERVE_CORES", 1, lo=0, hi=cpu)
    usable = max(1, cpu - reserve)
    default_workers = max(1, usable)

    w_all = _env_int("CICADA_WORKERS", default_workers, lo=1, hi=max(1, usable))
    w_bt = _env_int("CICADA_BACKTEST_WORKERS", w_all, lo=1, hi=cpu)
    w_research = _env_int("CICADA_RESEARCH_WORKERS", w_all, lo=1, hi=cpu)

    # Torch intra-op threads default to leaving one core free for the HTTP loop.
    torch_threads = _env_int("CICADA_TORCH_THREADS", max(1, usable), lo=1, hi=cpu)

    use_cuda_env = not _env_flag("CICADA_DISABLE_CUDA", False)
    device_str = "cpu"
    use_cuda = False
    cuda_device_count = 0
    cuda_devices: list[str] = []
    try:
        import torch  # type: ignore[reportMissingImports]
        if use_cuda_env and torch.cuda.is_available():
            cuda_device_count = int(torch.cuda.device_count())
            use_cuda = True
            current = int(torch.cuda.current_device())
            device_str = f"cuda:{current}"
            for idx in range(cuda_device_count):
                try:
                    name = torch.cuda.get_device_name(idx)
                except Exception:
                    name = f"cuda:{idx}"
                cuda_devices.append(f"cuda:{idx}:{name}")
    except Exception:  # pragma: no cover - torch always installed, defensive
        pass

    use_multi_gpu = use_cuda and cuda_device_count > 1 and not _env_flag("CICADA_DISABLE_MULTI_GPU", False)
    enable_tf32 = _env_flag("CICADA_TF32", True)
    dataloader_workers = _env_int("CICADA_DATALOADER_WORKERS", max(1, min(4, usable - 1)), lo=0, hi=cpu)
    pin_memory = _env_flag("CICADA_PIN_MEMORY", use_cuda)

    return ComputeConfig(
        cpu_count=cpu,
        backtest_workers=w_bt,
        research_workers=w_research,
        throttle_reserved_cores=reserve,
        torch_num_threads=torch_threads,
        use_cuda=use_cuda,
        device_str=device_str,
        cuda_device_count=cuda_device_count,
        cuda_devices=cuda_devices,
        use_multi_gpu=use_multi_gpu,
        enable_tf32=enable_tf32,
        dataloader_workers=dataloader_workers,
        pin_memory=pin_memory,
    )


_CONFIG: Optional[ComputeConfig] = None


def get_compute_config() -> ComputeConfig:
    """Cached resolution of compute config so the same values are seen everywhere."""
    global _CONFIG
    if _CONFIG is None:
        _CONFIG = resolve_compute_config()
        logger.info(
            "compute config: cpu=%s bt_workers=%s research_workers=%s torch=%s cuda=%s gpu_count=%s multi_gpu=%s tf32=%s dataloader=%s",
            _CONFIG.cpu_count,
            _CONFIG.backtest_workers,
            _CONFIG.research_workers,
            _CONFIG.torch_num_threads,
            _CONFIG.use_cuda,
            _CONFIG.cuda_device_count,
            _CONFIG.use_multi_gpu,
            _CONFIG.enable_tf32,
            _CONFIG.dataloader_workers,
        )
    return _CONFIG


def configure_torch_for_speed() -> None:
    """Apply torch-level settings: TF32, num_threads, matmul precision.

    Idempotent. Safe to call from both training and inference entrypoints.
    """
    cfg = get_compute_config()
    try:
        import torch  # type: ignore[reportMissingImports]
        torch.set_num_threads(cfg.torch_num_threads)
        torch.set_num_interop_threads(max(1, cfg.torch_num_threads // 2))
        if cfg.use_cuda:
            # TF32 is the big GPU speed win for training on Ampere+ (RTX 3000 / 4000).
            if cfg.enable_tf32:
                torch.backends.cuda.matmul.allow_tf32 = True
                torch.backends.cudnn.allow_tf32 = True
            try:
                torch.set_float32_matmul_precision("high")
            except AttributeError:
                pass
            # cuDNN benchmark heuristic: fastest algo picked once per shape.
            torch.backends.cudnn.benchmark = True
    except Exception:  # pragma: no cover - torch always present
        pass


def cuda_is_preferred() -> bool:
    """Convenience: should this run prefer CUDA over CPU?"""
    return get_compute_config().use_cuda
