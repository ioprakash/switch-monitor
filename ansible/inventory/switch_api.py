#!/usr/bin/env python3
"""Dynamic inventory script - reads switches from dashboard API."""
import json, urllib.request, sys

API = "http://192.168.10.10:7575/api/switches"

try:
    resp = urllib.request.urlopen(API, timeout=5)
    switches = json.loads(resp.read())
except Exception as e:
    print(json.dumps({"_meta": {"hostvars": {}}}))
    sys.exit(0)

host_list = []
hostvars = {}
for sw in switches:
    sid = (sw.get("hostname") or sw.get("name") or sw.get("id", "unknown")).replace(" ", "_")
    host_list.append(sid)
    hostvars[sid] = {
        "ansible_host": sw.get("ip", ""),
        "ansible_connection": "ansible.netcommon.network_cli",
        "ansible_network_os": "bdcom",
        "ansible_user": "admin",
        "ansible_password": "admin",
        "ansible_become_method": "enable",
        "ansible_become_password": "",
        "switch_id": sw.get("id"),
        "model": sw.get("model", ""),
        "status": sw.get("status", "unknown"),
        "mac": sw.get("mac", ""),
        "cpu": sw.get("cpu"),
        "temperature": sw.get("temperature"),
    }

inventory = {
    "all": {
        "hosts": host_list,
        "vars": {
            "ansible_python_interpreter": "/usr/bin/python3",
        }
    },
    "bdcom_switches": {
        "hosts": host_list
    },
    "_meta": {
        "hostvars": hostvars
    }
}

print(json.dumps(inventory))
