#!/usr/bin/env python3
"""ansible-bridge: HTTP server that runs Ansible playbooks.
Backend in Docker calls this to execute playbooks on the host."""
import http.server
import json
import subprocess
import os
import urllib.parse

PORT = 3003
ANSIBLE_DIR = "/home/prakash/code/switch-monitor/ansible"

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self._resp({"status": "ok"})
        elif parsed.path == "/playbooks":
            pb_dir = os.path.join(ANSIBLE_DIR, "playbooks")
            pbs = [f.replace(".yml", "") for f in os.listdir(pb_dir) if f.endswith(".yml")]
            self._resp(pbs)
        else:
            self._resp({"error": "not found"}, 404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/run":
            self._resp({"error": "not found"}, 404)
            return
        
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        playbook = body.get("playbook", "")
        vars_dict = body.get("vars", {})
        
        if not playbook:
            self._resp({"error": "playbook required"}, 400)
            return
        
        pb_file = os.path.join(ANSIBLE_DIR, "playbooks", 
                               playbook if playbook.endswith(".yml") else playbook + ".yml")
        inventory = os.path.join(ANSIBLE_DIR, "inventory", "switch_api.py")
        
        cmd = f"cd {ANSIBLE_DIR} && ansible-playbook -i {inventory} {pb_file} 2>&1"
        for k, v in vars_dict.items():
            cmd += f' -e "{k}={v}"'
        
        print(f"[ansible-bridge] Running: {playbook}")
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=60
        )
        
        self._resp({
            "success": result.returncode == 0,
            "exitCode": result.returncode,
            "output": result.stdout + result.stderr
        })

    def _resp(self, data, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, fmt, *args):
        print(f"[ansible-bridge] {args[0]}" if args else "")

print(f"[ansible-bridge] Starting on port {PORT}")
http.server.HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
