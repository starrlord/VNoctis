"""Structured JSON logging for vnm-builder.

Produces one JSON object per line to stdout, compatible with Docker's
json-file log driver and log aggregation tools.
"""

import json
import logging
import os
import sys
from datetime import datetime, timezone


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
        Configured logger instance writing JSON to stdout.
    """
    level_str = os.environ.get("LOG_LEVEL", "info").upper()
    level = getattr(logging, level_str, logging.INFO)

    logger = logging.getLogger(name)
    logger.setLevel(level)

    # Avoid duplicate handlers if setup_logger is called multiple times
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(JSONFormatter())
        logger.addHandler(handler)

    # Prevent propagation to root logger (avoids duplicate plain-text lines)
    logger.propagate = False

    return logger


# Module-level convenience instance
logger = setup_logger()
