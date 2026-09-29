"""Cross-platform port manager core."""

import os
import platform
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional
import threading

import psutil

from .errors import ACCESS_DENIED_KILL
from .known_ports import get_service_tag


@dataclass
class PortInfo:
    port: int
    protocol: str
    state: str
    pid: Optional[int]
    process_name: Optional[str]
    parent_process: Optional[str]
    local_address: str
    foreign_address: Optional[str]
    started_at: Optional[str]
    service_tag: Optional[str] = None
    cmdline_preview: Optional[str] = None
    username: Optional[str] = None
    cwd: Optional[str] = None
    container_hint: Optional[str] = None


class PortManager:
    def __init__(self):
        self.os = platform.system().lower()
        self._lock = threading.Lock()
    
    def get_all_ports(self) -> list[PortInfo]:
        """Get all active ports with process information."""
        ports = []
        
        try:
            # Primary method: psutil
            connections = psutil.net_connections(kind='inet')
            for conn in connections:
                if conn.laddr:
                    port = conn.laddr.port
                    local_addr = f"{conn.laddr.ip}:{conn.laddr.port}"
                    foreign_addr = None
                    if conn.raddr:
                        foreign_addr = f"{conn.raddr.ip}:{conn.raddr.port}"
                    
                    pid = conn.pid
                    process_name = None
                    parent_process = None
                    started_at = None
                    
                    if pid:
                        try:
                            proc = psutil.Process(pid)
                            process_name = proc.name()
                            parent = proc.parent()
                            if parent:
                                parent_process = parent.name()
                            # Get process creation time
                            create_time = proc.create_time()
                            started_at = datetime.fromtimestamp(create_time).isoformat()
                        except (psutil.NoSuchProcess, psutil.AccessDenied):
                            pass
                    
                    state = conn.status if conn.status else "UNKNOWN"
                    protocol = "TCP" if conn.type.name == "SOCK_STREAM" else "UDP"
                    
                    ports.append(PortInfo(
                        port=port,
                        protocol=protocol,
                        state=state,
                        pid=pid,
                        process_name=process_name,
                        parent_process=parent_process,
                        local_address=local_addr,
                        foreign_address=foreign_addr,
                        started_at=started_at,
                        service_tag=get_service_tag(port)
                    ))
        except Exception:
            # Fallback to OS-specific commands
            ports = self._fallback_port_scan()

        self._enrich_ports(ports)
        return ports

    def _truncate_cmdline(self, parts: list[str], max_len: int = 120) -> str:
        s = " ".join(parts)
        if len(s) <= max_len:
            return s
        return s[: max_len - 1] + "…"

    def _container_hint_linux(self, pid: int) -> Optional[str]:
        if self.os != "linux":
            return None
        try:
            path = f"/proc/{pid}/cgroup"
            with open(path, encoding="utf-8", errors="ignore") as f:
                txt = f.read()
            if "docker" in txt or "containerd" in txt or "kubepods" in txt:
                if "kubepods" in txt:
                    return "Kubernetes pod (cgroup)"
                return "Container (cgroup)"
        except OSError:
            pass
        return None

    def _enrich_ports(self, ports: list[PortInfo]) -> None:
        """Attach cmdline, user, cwd, container hint when accessible."""
        for i, p in enumerate(ports):
            if not p.pid:
                continue
            try:
                proc = psutil.Process(p.pid)
                cmd = None
                try:
                    cmdline = proc.cmdline()
                    if cmdline:
                        cmd = self._truncate_cmdline(cmdline)
                except (psutil.AccessDenied, psutil.NoSuchProcess):
                    pass
                user = None
                try:
                    user = proc.username()
                except (psutil.AccessDenied, psutil.NoSuchProcess):
                    pass
                cwd_val = None
                try:
                    cwd_val = proc.cwd()
                except (psutil.AccessDenied, psutil.NoSuchProcess):
                    pass
                ch = self._container_hint_linux(p.pid)
                ports[i] = PortInfo(
                    port=p.port,
                    protocol=p.protocol,
                    state=p.state,
                    pid=p.pid,
                    process_name=p.process_name,
                    parent_process=p.parent_process,
                    local_address=p.local_address,
                    foreign_address=p.foreign_address,
                    started_at=p.started_at,
                    service_tag=p.service_tag,
                    cmdline_preview=cmd,
                    username=user,
                    cwd=cwd_val,
                    container_hint=ch,
                )
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    
    def _fallback_port_scan(self) -> list[PortInfo]:
        """Fallback port scanning using OS commands."""
        if self.os == "darwin":
            return self._macos_port_scan()
        elif self.os == "linux":
            return self._linux_port_scan()
        elif self.os == "windows":
            return self._windows_port_scan()
        return []
    
    def _macos_port_scan(self) -> list[PortInfo]:
        """Use lsof on macOS."""
        ports = []
        try:
            result = subprocess.run(
                ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"],
                capture_output=True,
                text=True,
                timeout=10
            )
            lines = result.stdout.strip().split('\n')[1:]  # Skip header
            
            for line in lines:
                parts = line.split()
                if len(parts) >= 9:
                    process_name = parts[0]
                    pid = int(parts[1]) if parts[1].isdigit() else None
                    address = parts[8]
                    
                    # Parse address
                    if ':' in address:
                        local_addr, port_str = address.rsplit(':', 1)
                        try:
                            port = int(port_str)
                        except ValueError:
                            continue
                    else:
                        continue
                    
                    ports.append(PortInfo(
                        port=port,
                        protocol="TCP",
                        state="LISTEN",
                        pid=pid,
                        process_name=process_name,
                        parent_process=None,
                        local_address=address,
                        foreign_address=None,
                        started_at=None,
                        service_tag=get_service_tag(port)
                    ))
        except Exception:
            pass
        
        return ports
    
    def _linux_port_scan(self) -> list[PortInfo]:
        """Use ss or netstat on Linux."""
        ports = []
        
        # Try ss first (modern replacement for netstat)
        try:
            result = subprocess.run(
                ["ss", "-tuln"],
                capture_output=True,
                text=True,
                timeout=10
            )
            lines = result.stdout.strip().split('\n')[1:]
            
            for line in lines:
                parts = line.split()
                if len(parts) >= 5:
                    state = parts[0]
                    local_addr = parts[4]
                    
                    if ':' in local_addr:
                        _, port_str = local_addr.rsplit(':', 1)
                        try:
                            port = int(port_str)
                        except ValueError:
                            continue
                    else:
                        continue
                    
                    # Try to get PID from /proc
                    pid = self._get_pid_from_port_linux(port)
                    process_name = None
                    if pid:
                        try:
                            process_name = psutil.Process(pid).name()
                        except Exception:
                            pass
                    
                    ports.append(PortInfo(
                        port=port,
                        protocol="TCP",
                        state=state,
                        pid=pid,
                        process_name=process_name,
                        parent_process=None,
                        local_address=local_addr,
                        foreign_address=None,
                        started_at=None,
                        service_tag=get_service_tag(port)
                    ))
        except Exception:
            pass
        
        return ports
    
    def _get_pid_from_port_linux(self, port: int) -> Optional[int]:
        """Find PID using a specific port on Linux."""
        try:
            for proc in psutil.process_iter(['pid', 'connections']):
                try:
                    for conn in proc.info.get('connections', []):
                        if conn.laddr and conn.laddr.port == port:
                            return proc.info['pid']
                except Exception:
                    continue
        except Exception:
            pass
        return None
    
    def _windows_port_scan(self) -> list[PortInfo]:
        """Use netstat on Windows."""
        ports = []
        try:
            result = subprocess.run(
                ["netstat", "-ano"],
                capture_output=True,
                text=True,
                timeout=10
            )
            lines = result.stdout.strip().split('\n')[4:]  # Skip headers
            
            for line in lines:
                parts = line.split()
                if len(parts) >= 4:
                    proto = parts[0]
                    local_addr = parts[1]
                    state = parts[3] if len(parts) > 3 else "UNKNOWN"
                    pid = int(parts[-1]) if parts[-1].isdigit() else None
                    
                    # Parse port from address
                    if ':' in local_addr:
                        _, port_str = local_addr.rsplit(':', 1)
                        try:
                            port = int(port_str)
                        except ValueError:
                            continue
                    else:
                        continue
                    
                    process_name = None
                    if pid:
                        try:
                            process_name = psutil.Process(pid).name()
                        except Exception:
                            pass
                    
                    ports.append(PortInfo(
                        port=port,
                        protocol=proto,
                        state=state,
                        pid=pid,
                        process_name=process_name,
                        parent_process=None,
                        local_address=local_addr,
                        foreign_address=None,
                        started_at=None,
                        service_tag=get_service_tag(port)
                    ))
        except Exception:
            pass
        
        return ports
    
    def kill_port(self, port: int, dry_run: bool = False) -> dict:
        """Kill process by port number."""
        ports = self.get_all_ports()
        target = None
        
        for p in ports:
            if p.port == port and p.pid:
                target = p
                break
        
        if not target:
            return {"success": False, "error": f"No process found using port {port}"}
        
        if not target.pid:
            return {"success": False, "error": f"Port {port} has no associated PID"}
        
        return self.kill_pid(target.pid, port=port, dry_run=dry_run)
    
    def _macos_launchd_label_for_pid(self, pid: int) -> Optional[str]:
        """Return the user LaunchAgent/Daemon label that owns this PID, if any."""
        try:
            result = subprocess.run(
                ["launchctl", "list"],
                capture_output=True,
                text=True,
                timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        if result.returncode != 0:
            return None
        pid_s = str(pid)
        for line in result.stdout.splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 3 and parts[0] == pid_s:
                return parts[-1]
        return None

    def _service_label_for_process(self, proc: psutil.Process) -> Optional[str]:
        try:
            env = proc.environ()
        except (psutil.AccessDenied, psutil.NoSuchProcess):
            env = {}
        xpc = env.get("XPC_SERVICE_NAME")
        if xpc and not xpc.startswith("com.apple."):
            return xpc
        if self.os == "darwin":
            return self._macos_launchd_label_for_pid(proc.pid)
        return None

    def _stop_macos_user_service(self, label: str) -> bool:
        if not label or label.startswith("com.apple."):
            return False
        uid = os.getuid()
        try:
            boot = subprocess.run(
                ["launchctl", "bootout", f"gui/{uid}/{label}"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if boot.returncode == 0:
                return True
        except (OSError, subprocess.TimeoutExpired):
            pass
        plist = Path.home() / "Library" / "LaunchAgents" / f"{label}.plist"
        if not plist.is_file():
            return False
        try:
            unload = subprocess.run(
                ["launchctl", "unload", str(plist)],
                capture_output=True,
                text=True,
                timeout=10,
            )
            return unload.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False

    def _linux_user_unit_for_pid(self, pid: int) -> Optional[str]:
        try:
            with open(f"/proc/{pid}/cgroup", encoding="utf-8", errors="ignore") as f:
                text = f.read()
        except OSError:
            return None
        unit = None
        for token in text.replace("/", " ").split():
            if token.endswith(".service") and not token.startswith("user@"):
                unit = token
        return unit

    def _stop_linux_user_unit(self, unit: str) -> bool:
        if not unit:
            return False
        try:
            stop = subprocess.run(
                ["systemctl", "--user", "stop", unit],
                capture_output=True,
                text=True,
                timeout=10,
            )
            return stop.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False

    def _terminate_process_tree(self, proc: psutil.Process) -> None:
        children = []
        try:
            children = proc.children(recursive=True)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        for child in children:
            try:
                child.terminate()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        try:
            proc.terminate()
        except psutil.NoSuchProcess:
            return
        _gone, alive = psutil.wait_procs([proc, *children], timeout=3)
        for leftover in alive:
            try:
                leftover.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        if alive:
            psutil.wait_procs(alive, timeout=3)

    def kill_pid(self, pid: int, port: int | None = None, dry_run: bool = False) -> dict:
        """Kill process by PID. Stops a supervising LaunchAgent/systemd unit so it cannot respawn."""
        try:
            proc = psutil.Process(pid)
            process_name = proc.name()
            
            # Get port if not provided
            if port is None:
                try:
                    for conn in proc.connections():
                        if conn.laddr:
                            port = conn.laddr.port
                            break
                except Exception:
                    pass

            service_label = self._service_label_for_process(proc)
            if self.os == "linux" and not service_label:
                service_label = self._linux_user_unit_for_pid(pid)

            if dry_run:
                extra = f" and stop service {service_label}" if service_label else ""
                return {
                    "success": True,
                    "dry_run": True,
                    "pid": pid,
                    "process_name": process_name,
                    "port": port or 0,
                    "message": f"Would terminate {process_name} (PID {pid}){extra}",
                }

            stopped_service = False
            if service_label:
                if self.os == "darwin":
                    stopped_service = self._stop_macos_user_service(service_label)
                elif self.os == "linux":
                    stopped_service = self._stop_linux_user_unit(service_label)

            still_running = False
            try:
                still_running = proc.is_running()
            except psutil.NoSuchProcess:
                still_running = False
            if still_running:
                self._terminate_process_tree(proc)

            message = f"Terminated {process_name} (PID {pid})"
            if stopped_service:
                message += f" and stopped service {service_label}"

            return {
                "success": True,
                "pid": pid,
                "process_name": process_name,
                "port": port,
                "message": message,
            }
            
        except psutil.NoSuchProcess:
            return {"success": False, "error": f"Process {pid} not found"}
        except psutil.AccessDenied:
            return {"success": False, "error": ACCESS_DENIED_KILL}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    def kill_by_state(self, state: str, dry_run: bool = False) -> dict:
        """Kill all processes in a specific state."""
        ports = self.get_all_ports()
        killed = []
        errors = []
        would_kill = []
        
        for port_info in ports:
            if port_info.state.upper() == state.upper() and port_info.pid:
                result = self.kill_pid(port_info.pid, port_info.port, dry_run=dry_run)
                if result.get("success"):
                    if dry_run:
                        would_kill.append(result)
                    else:
                        killed.append(result)
                else:
                    errors.append({"port": port_info.port, "error": result["error"]})
        
        if dry_run:
            return {
                "success": len(errors) == 0,
                "dry_run": True,
                "would_kill_count": len(would_kill),
                "would_kill": would_kill,
                "errors": errors,
            }

        return {
            "success": len(errors) == 0,
            "killed_count": len(killed),
            "killed": killed,
            "errors": errors
        }

    def get_process_tree(self, pid: int) -> dict:
        """Get process tree information."""
        try:
            proc = psutil.Process(pid)
            parent = proc.parent()
            children = proc.children()
            
            return {
                "pid": pid,
                "name": proc.name(),
                "parent": {
                    "pid": parent.pid,
                    "name": parent.name()
                } if parent else None,
                "children": [
                    {"pid": c.pid, "name": c.name()}
                    for c in children
                ],
                "created": datetime.fromtimestamp(proc.create_time()).isoformat() if proc.create_time() else None,
                "cmdline": proc.cmdline()
            }
        except psutil.NoSuchProcess:
            return {"error": "Process not found"}
        except psutil.AccessDenied:
            return {"error": ACCESS_DENIED_KILL}


# Global instance
_manager: Optional[PortManager] = None


def get_manager() -> PortManager:
    """Get or create global PortManager instance."""
    global _manager
    if _manager is None:
        _manager = PortManager()
    return _manager
