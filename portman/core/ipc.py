"""JSON-RPC IPC interface for GUI communication."""

import sys
import json
import threading
from typing import Callable

from .port_manager import get_manager


class JSONRPCServer:
    """JSON-RPC server over stdin/stdout for GUI communication."""
    
    def __init__(self):
        self.manager = get_manager()
        self.methods: dict[str, Callable] = {
            "get_ports": self._get_ports,
            "kill_port": self._kill_port,
            "kill_pid": self._kill_pid,
            "kill_by_state": self._kill_by_state,
            "get_process_tree": self._get_process_tree,
        }
        self._lock = threading.Lock()
    
    def _get_ports(self, params: dict) -> dict:
        """Get all ports with optional filtering."""
        ports = self.manager.get_all_ports()

        state_filter = params.get("state")
        proc_filter = params.get("process")
        
        if state_filter:
            ports = [p for p in ports if p.state.upper() == state_filter.upper()]
        if proc_filter:
            ports = [p for p in ports if p.process_name and proc_filter.lower() in p.process_name.lower()]
        
        def port_item(p):
            d = {
                "port": p.port,
                "protocol": p.protocol,
                "state": p.state,
                "pid": p.pid,
                "process_name": p.process_name,
                "parent_process": p.parent_process,
                "local_address": p.local_address,
                "foreign_address": p.foreign_address,
                "started_at": p.started_at,
                "service_tag": p.service_tag,
            }
            if p.cmdline_preview:
                d["cmdline_preview"] = p.cmdline_preview
            if p.username:
                d["username"] = p.username
            if p.cwd:
                d["cwd"] = p.cwd
            if p.container_hint:
                d["container_hint"] = p.container_hint
            return d

        return {
            "ports": [port_item(p) for p in ports],
            "count": len(ports),
        }
    
    def _kill_port(self, params: dict) -> dict:
        """Kill process by port."""
        port = params.get("port")
        if port is None:
            return {"success": False, "error": "Port parameter required"}
        dry_run = bool(params.get("dry_run", False))
        return self.manager.kill_port(int(port), dry_run=dry_run)
    
    def _kill_pid(self, params: dict) -> dict:
        """Kill process by PID."""
        pid = params.get("pid")
        port = params.get("port")
        if pid is None:
            return {"success": False, "error": "PID parameter required"}
        dry_run = bool(params.get("dry_run", False))
        return self.manager.kill_pid(int(pid), port, dry_run=dry_run)
    
    def _kill_by_state(self, params: dict) -> dict:
        """Kill processes by state."""
        state = params.get("state")
        if state is None:
            return {"success": False, "error": "State parameter required"}
        dry_run = bool(params.get("dry_run", False))
        return self.manager.kill_by_state(str(state), dry_run=dry_run)

    def _get_process_tree(self, params: dict) -> dict:
        """Get process tree."""
        pid = params.get("pid")
        if pid is None:
            return {"error": "PID parameter required"}
        return self.manager.get_process_tree(pid)

    def handle_request(self, request: dict) -> dict:
        """Handle a JSON-RPC request."""
        request_id = request.get("id")
        method_name = request.get("method")
        params = request.get("params", {})
        
        if method_name not in self.methods:
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": f"Method '{method_name}' not found"}
            }
        
        try:
            with self._lock:
                result = self.methods[method_name](params)
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": result
            }
        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32603, "message": str(e)}
            }
    
    def run(self):
        """Run the server, reading from stdin and writing to stdout."""
        print("PortMan IPC Server started", file=sys.stderr)
        
        while True:
            try:
                line = sys.stdin.readline()
                if not line:
                    break
                
                line = line.strip()
                if not line:
                    continue
                
                try:
                    request = json.loads(line)
                except json.JSONDecodeError as e:
                    response = {
                        "jsonrpc": "2.0",
                        "id": None,
                        "error": {"code": -32700, "message": f"Parse error: {e}"}
                    }
                    print(json.dumps(response), flush=True)
                    continue
                
                response = self.handle_request(request)
                print(json.dumps(response), flush=True)
                
            except KeyboardInterrupt:
                break
            except Exception as e:
                error_response = {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32603, "message": f"Internal error: {e}"}
                }
                print(json.dumps(error_response), flush=True)


def main():
    """Entry point for IPC server."""
    server = JSONRPCServer()
    server.run()


if __name__ == "__main__":
    main()
