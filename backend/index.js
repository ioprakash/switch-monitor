const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');

const MQTT_BROKER = process.env.MQTT_BROKER || 'tcp://192.168.10.10:1883';
const PORT = process.env.PORT || 3002;

const app = express();
app.use(cors());
app.use(express.json());

// ─── In-Memory Store ──────────────────────────────────────────
const devices = {};

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
        return;
    }

    if (type === 'status') {
        const s = payload.trim().toLowerCase();
        if (s.includes('online') || s === 'online') d.status = 'online';
        else if (s.includes('offline') || s === 'offline') d.status = 'offline';
    }

    if (type === 'response') {
        d.lastResponse = payload.substring(0, 5000);
        d.lastCmdTime = new Date().toISOString();
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

app.get('/health', (req, res) => res.json({ status: 'ok', switches: Object.keys(devices).length }));

app.listen(PORT, () => {
    console.log(`[backend] Switch Monitor API running on port ${PORT}`);
});
