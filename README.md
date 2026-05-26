# Switch Monitor

A standalone monitoring & control dashboard for managed network switches (BDCOM, Cisco, Huawei, etc.). Communicates via **SNMP + Telnet → MQTT** bridge.

> 🧭 **Separate project** — completely independent from the STB launcher dashboard.

---

## Architecture

```
Managed Switch (SNMP + Telnet)
         │
         ▼
┌────────────────────┐
│  switch-control    │  ← SNMP poller + Telnet executor
│  (Node.js)         │     → Publishes to MQTT: switch/{id}/telemetry
│                    │     → Listens on: switch/{id}/cmd
└────────┬───────────┘
         │ MQTT
         ▼
┌────────────────────┐
│  Backend (Express) │  ← REST API for dashboard
│  (port 3002)       │     /api/switches
│                    │     /api/switches/:id
│                    │     /api/switches/:id/cmd
└────────┬───────────┘
         │ HTTP
         ▼
┌────────────────────┐
│  Dashboard (nginx) │  ← Web UI on port 7575
│  (port 7575)       │     📊 Monitor · 📟 Console · 🖥️ Terminal
└────────────────────┘
```

## Quick Start

```bash
# 1. Build & start all services
docker compose up -d --build

# 2. Run the switch-control service (standalone, not in Docker for telnet access)
cd switch-control && node index.js

# 3. Open dashboard
# http://localhost:7575
```

## Dashboard Tabs

### 📊 Monitor Tab
- **CPU Gauge** — animated ring chart with color thresholds
- **Temperature** — live value with progress bar
- **Memory** — used/free with percentage bar
- **Port Summary** — total/up/down port counts
- **Quick Actions** — Version | Config | Interfaces | MAC Table | Route | Log | VLAN | CPU | Reboot

#### 🔌 Port Section (inline in Monitor tab)
- **Collapsible** — click header to expand/collapse
- All ports displayed as colored tiles
- **🟢 UP** (green) — **🔴 DOWN** (red)
- Each tile shows: status LED, port name, traffic (↓↑ bytes)
- **Click any port** → detail popup modal:
  - Status, Index, Traffic, Speed, Duplex, MAC, Errors
  - Auto-fetches MAC addresses learned on that port
  - Action buttons: Show Interface | Show MAC | Counters

### 📟 Console Tab
- Command entry with execution history
- Preset command buttons
- Real-time response polling from switch

### 🖥️ Terminal Tab
- Full interactive SSH-style terminal
- Type directly — no input field
- Blinking cursor, `admin@switch#` prompt
- ↑↓ command history, Tab completion
- Ctrl+U clear line, `clear`/`cls` clears screen
- `help` lists all available commands

## Services

| Service | Port | Description |
|---|---|---|
| Dashboard (nginx) | **7575** | Web UI — vanilla HTML/JS, no build |
| Backend (Express) | **3002** | REST API — single /api/switches endpoint |
| switch-control | — | Node.js MQTT bridge (runs standalone) |
| MQTT Broker | 192.168.10.10:1883 | Shared Mosquitto — existing infrastructure |

## Adding a Switch

Edit `switch-control/switches.json`:

```json
[
    {
        "name": "Core Switch 1",
        "ip": "192.168.10.50",
        "mac": "b8:69:f4:01:ed:a4",
        "username": "admin",
        "password": "***",
        "community": "nmscloud",
        "model": "BDCOM S2500-8T2S",
        "group": "core-switches"
    }
]
```

The switch-control service auto-reloads the config.

## BDCOM OIDs

| Data | OID |
|---|---|
| CPU Utilization | `.1.3.6.1.4.1.3320.9.48.1.0` |
| Total Memory | `.1.3.6.1.4.1.3320.9.48.2.0` |
| Memory Used | `.1.3.6.1.4.1.3320.9.48.5.0` |
| Temperature | `.1.3.6.1.4.1.3320.9.48.6.0` |
| SNMP Community | `nmscloud` (R/W) |

## Troubleshooting

```bash
# Check switch-control is running
ps aux | grep switch-control

# Check SNMP reachability
snmpwalk -v2c -c nmscloud 192.168.10.50 1.3.6.1.4.1.3320.9.48

# Check telnet access
telnet 192.168.10.50 23

# Test MQTT data flow
mosquitto_sub -t "switch/#" -v

# Check backend
curl http://localhost:3002/api/switches
```

## File Structure

```
switch-monitor/
├── docker-compose.yml       # Backend + Dashboard containers
├── README.md                # This file
│
├── backend/
│   ├── index.js             # Express + MQTT REST API
│   ├── package.json
│   └── Dockerfile
│
├── dashboard/
│   ├── index.html           # Complete web UI (single HTML file)
│   ├── nginx.conf           # API proxy config
│   └── Dockerfile
│
└── switch-control/
    ├── index.js             # SNMP poller + Telnet executor
    ├── package.json
    └── switches.json        # Device configs
```
