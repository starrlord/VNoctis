"""Structured JSON logging for vnm-builder.

Produces one JSON object per line to stdout, compatible with Docker's
json-file log driver and log aggregation tools.

If LOG_PATH is set, also writes to a persistent log file at
``{LOG_PATH}/vnm-builder.log`` for post-mortem analysis.
"""

import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


class JSONFormatter(logging.Formatter):
    """Format log records as single-line JSON objects."""

    def format(self, record):
        log_obj = {
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "level": record.levelname.lower(),
            "service": "vnm-builder",
            "message": record.getMessage(),
            "module": record.module,
        }

        if record.exc_info and record.exc_info[0] is not None:
            log_obj["error"] = self.formatException(record.exc_info)

        # Merge any extra structured fields attached to the record
        if hasattr(record, "extra_fields"):
            log_obj.update(record.extra_fields)

        return json.dumps(log_obj, default=str)


def setup_logger(name: str = "vnm-builder") -> logging.Logger:
    """Create and configure a JSON-formatted logger.

    Parameters
    ----------
    name : str
        Logger name (default: ``vnm-builder``).

    Returns
    -------
    logging.Logger
        Configured logger instance writing JSON to stdout and optionally
        to a persistent log file.
    """
    level_str = os.environ.get("LOG_LEVEL", "info").upper()
    level = getattr(logging, level_str, logging.INFO)

    logger = logging.getLogger(name)
    logger.setLevel(level)

    # Avoid duplicate handlers if setup_logger is called multiple times
    if not logger.handlers:
        # Always write to stdout (Docker captures this)
        stdout_handler = logging.StreamHandler(sys.stdout)
        stdout_handler.setFormatter(JSONFormatter())
        logger.addHandler(stdout_handler)

        # Optionally write to a persistent log file
        log_path = os.environ.get("LOG_PATH", "/data/logs")
        try:
            log_dir = Path(log_path)
            log_dir.mkdir(parents=True, exist_ok=True)
            log_file = log_dir / "vnm-builder.log"
            file_handler = logging.FileHandler(str(log_file), encoding="utf-8")
            file_handler.setFormatter(JSONFormatter())
            logger.addHandler(file_handler)
        except OSError:
            # /data/logs not writable — stdout only
            pass

    # Prevent propagation to root logger (avoids duplicate plain-text lines)
    logger.propagate = False

    return logger


# Module-level convenience instance
logger = setup_logger()
