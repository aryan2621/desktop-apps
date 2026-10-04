"""MCP transport fixture: stdio or HTTP with optional static authentication and SSE replies."""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def respond(r):
    if "id" not in r:
        return None
    method = r.get("method")
    if method == "initialize":
        # Negotiate the stable 2025 protocol to also cover legacy-server compatibility.
        value = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}, "resources": {}, "prompts": {}}, "serverInfo": {"name": "relay-test", "version": "1"}}
    elif method == "tools/list":
        value = {"tools": [{"name": "echo", "description": "Echo", "inputSchema": {"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]}}]}
    elif method == "tools/call":
        value = {"content": [{"type": "text", "text": r["params"]["arguments"].get("message", "")}], "isError": False}
    elif method == "resources/list":
        value = {"resources": []}
    elif method == "prompts/list":
        value = {"prompts": []}
    else:
        value = {}
    return {"jsonrpc": "2.0", "id": r["id"], "result": value}

if "--http" not in sys.argv:
    for line in sys.stdin:
        result = respond(json.loads(line))
        if result:
            print(json.dumps(result), flush=True)
else:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_GET(self):
            self.send_response(405)
            self.end_headers()
        def do_DELETE(self):
            self.send_response(200)
            self.end_headers()
        def do_POST(self):
            if "--auth" in sys.argv and self.headers.get("X-API-Key") != "fixture-secret":
                self.send_response(401)
                self.end_headers()
                return
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            result = respond(request)
            if result is None:
                self.send_response(202)
                self.end_headers()
                return
            body = json.dumps(result)
            sse = "--sse" in sys.argv
            if sse:
                body = "event: message\ndata: " + body + "\n\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream" if sse else "application/json")
            self.send_header("Mcp-Session-Id", "fixture-session")
            self.send_header("Content-Length", str(len(body.encode())))
            self.end_headers()
            self.wfile.write(body.encode())
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(server.server_address[1], flush=True)
    server.serve_forever()
