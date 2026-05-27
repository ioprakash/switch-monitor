const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');

const MQTT_BROKER = process.env.MQTT_BROKER || 'tcp://192.168.10.10:1883';
const PORT = process.env.PORT || 3002;

const app = express();
app.use(cors());
app.use(express.json());

// ─── In-Memory Store ──────────────────────────────────────────
const devices = {};

// ─── WebSocket Broadcast ──────────────────────────────────────
let wsClients = new Set();

function wsBroadcast(data) {
    const msg = JSON.stringify(data);
    for (const ws of wsClients) {
        if (ws.readyState === 1) ws.send(msg);
    }
}

// ─── MQTT Client ──────────────────────────────────────────────
const client = mqtt.connect(MQTT_BROKER);

client.on('connect', () => {
    console.log(`[backend] Connected to MQTT broker at ${MQTT_BROKER}`);
    client.subscribe('switch/+/status');
    client.subscribe('switch/+/info');
    client.subscribe('switch/+/telemetry');
    client.subscribe('switch/+/response');
});

client.on('message', (topic, message) => {
    const payload = message.toString();
    const parts = topic.split('/');
    if (parts[0] !== 'switch' || parts.length < 3) return;
    const deviceId = parts[1];
    const type = parts[2];

    if (!devices[deviceId]) {
        devices[deviceId] = { 
            id: deviceId, status: 'unknown', lastSeen: null, lastResponse: '',
            name: deviceId, ip: '', ipAddresses: [], model: '', hostname: '',
            cpu: null, temperature: null,
            memory: null, uptime: null, ports: 0, portList: []
        };
    }

    const d = devices[deviceId];
    d.lastSeen = new Date().toISOString();

    if (type === 'info' || type === 'telemetry') {
        try {
            const data = JSON.parse(payload);
            if (data.ip) d.ip = data.ip;
            if (Array.isArray(data.ipAddresses)) d.ipAddresses = data.ipAddresses;
            if (data.model) d.model = data.model;
            if (data.hostname) d.hostname = data.hostname;
            if (data.name) d.name = data.name;
            if (data.mac) d.mac = data.mac;
            if (data.cpu !== undefined) d.cpu = data.cpu;
            if (data.memory) d.memory = data.memory;
            if (data.temperature !== undefined) d.temperature = data.temperature;
            if (data.uptime !== undefined && data.uptime !== null) d.uptime = data.uptime;
            if (data.ports !== undefined) {
                d.ports = typeof data.ports === 'object' ? Object.keys(data.ports).length : data.ports;
                if (data.ports && typeof data.ports === 'object') d.rawPorts = data.ports;
            }
            if (data.portList) d.portList = data.portList;
        } catch {}
        wsBroadcast({ type: 'telemetry', deviceId, data: d });
        return;
    }

    if (type === 'status') {
        const s = payload.trim().toLowerCase();
        if (s.includes('online') || s === 'online') d.status = 'online';
        else if (s.includes('offline') || s === 'offline') d.status = 'offline';
        wsBroadcast({ type: 'status', deviceId, status: d.status });
    }

    if (type === 'response') {
        d.lastResponse = payload.substring(0, 5000);
        d.lastCmdTime = new Date().toISOString();
        // Parse model & firmware from 'show version' output
        if (payload.includes('BDCOM') && payload.includes('Version')) {
            const modelMatch = payload.match(/BDCOM\(tm\)\s+(\S+)\s+Software/i);
            if (modelMatch) d.model = modelMatch[1];
            const fwMatch = payload.match(/Version\s+(\S+)\s+Build\s+(\d+)/i);
            if (fwMatch) d.firmware = fwMatch[1] + ' (Build ' + fwMatch[2] + ')';
            const hwMatch = payload.match(/hardware version:\s*(\S+)/i);
            if (hwMatch) d.hardware = hwMatch[1];
            const serialMatch = payload.match(/Serial num:(\S+)/i);
            if (serialMatch) d.serial = serialMatch[1];
        }
        // Broadcast command response to WebSocket clients
        wsBroadcast({ type: 'response', deviceId, cmdTime: d.lastCmdTime, response: d.lastResponse });
    }
});

// ─── REST API ─────────────────────────────────────────────────
app.get('/api/switches', (req, res) => {
    const list = Object.values(devices).filter(d => d.id.startsWith('SW_'));
    res.json(list);
});

app.get('/api/switches/:id', (req, res) => {
    const d = devices[req.params.id];
    if (!d || !d.id.startsWith('SW_')) return res.status(404).json({ error: 'Switch not found' });
    res.json(d);
});

app.post('/api/switches/:id/cmd', (req, res) => {
    const { id } = req.params;
    const { cmd } = req.body;
    if (!id.startsWith('SW_')) return res.status(400).json({ error: 'Not a switch device' });
    if (!cmd) return res.status(400).json({ error: 'cmd is required' });
    const topic = `switch/${id}/cmd`;
    client.publish(topic, cmd);
    console.log(`[backend] Command sent to ${id}: ${cmd.substring(0, 100)}`);
    res.json({ success: true, message: `Command sent to ${id}` });
});

app.get('/health', (req, res) => res.json({ status: 'ok', wsClients: wsClients.size, switches: Object.keys(devices).length }));

// ─── Ansible Integration ──────────────────────────────────────
// List available playbooks
app.get('/api/ansible/playbooks', (req, res) => {
    http.get('http://127.0.0.1:3003/playbooks', (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => res.json(JSON.parse(data || '[]')));
    }).on('error', () => res.json([]));
});

// Run an Ansible playbook
app.post('/api/ansible/run', (req, res) => {
    const { playbook, vars } = req.body;
    if (!playbook) return res.status(400).json({ error: 'playbook name required' });
    
    const body = JSON.stringify({ playbook, vars: vars || {} });
    const opt = {
        hostname: '127.0.0.1', port: 3003, path: '/run', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    
    const req2 = http.request(opt, (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => {
            try { res.json(JSON.parse(data)); } catch(e) { res.json({ error: data.substring(0,500) }); }
        });
    });
    req2.on('error', (e) => res.status(500).json({ error: e.message }));
    req2.write(body);
    req2.end();
});

// ─── HTTP + WebSocket Server ──────────────────────────────────
const server = http.createServer(app);

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
    wsClients.add(ws);
    // Send full switch list on connect
    const list = Object.values(devices).filter(d => d.id.startsWith('SW_'));
    ws.send(JSON.stringify({ type: 'init', data: list }));
    
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
});

server.listen(PORT, () => {
    console.log(`[backend] Switch Monitor API + WebSocket running on port ${PORT}`);
});
