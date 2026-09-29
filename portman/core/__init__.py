"""PortMan core library."""

from .port_manager import PortManager, PortInfo, get_manager
from .known_ports import get_service_tag, KNOWN_PORTS

# Do not import ipc here: `python -m core.ipc` loads this package first; importing ipc
# would preload core.ipc before runpy executes it as __main__ (RuntimeWarning).

__all__ = [
    "PortManager",
    "PortInfo",
    "get_manager",
    "get_service_tag",
    "KNOWN_PORTS",
]
