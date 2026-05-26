/**
 * switch-control — SNMP + Telnet bridge for managed switches → MQTT
 * 
 * Architecture:
 *   Switch (SNMP poll + Telnet cmd) ←→ switch-control ←→ MQTT Broker ←→ Dashboard Backend ←→ Frontend
 * 
 * Topics:
 *   switch/{id}/status     ← published (online/offline heartbeat)
 *   switch/{id}/response   ← published (command output)
 *   switch/{id}/info       ← published (device info JSON)
 *   switch/{id}/telemetry  ← published (CPU, mem, temp, ports data)
 *   switch/{id}/cmd        → subscribed (execute CLI via Telnet)
 *   switch/{id}/discover   → subscribed (trigger SNMP discovery)
 */

const mqtt = require('mqtt');
const { exec } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────

const BROKER_URL = process.env.BROKER_URL || 'mqtt://192.168.10.10:1883';
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'switches.json');
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '120000', 10); // 2 min
const DEVICE_ID_PREFIX = 'SW_';

// ─── Load switch config ────────────────────────────────────────

let switches = {};

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
            const list = JSON.parse(raw);
            switches = {};
            for (const sw of list) {
                const deviceId = DEVICE_ID_PREFIX + sw.mac.replace(/:/g, '').toUpperCase();
                switches[deviceId] = {
                    ...sw,
                    deviceId,
                    lastSeen: null,
                    lastResponse: '',
                    status: 'offline',
                    cpu: null,
                    memory: null,
                    temperature: null,
                    ports: {},
                    uptime: null,
                };
            }
            console.log(`[CONFIG] Loaded ${Object.keys(switches).length} switches`);
        } else {
            console.log('[CONFIG] No switches.json found — create one and restart');
            switches = {};
        }
    } catch (e) {
        console.error('[CONFIG] Error:', e.message);
    }
}

// ─── MQTT ──────────────────────────────────────────────────────

const mqttClient = mqtt.connect(BROKER_URL, {
    clientId: 'switch-control',
    clean: true,
    reconnectPeriod: 5000,
    keepalive: 45,
});

mqttClient.on('connect', () => {
    console.log('[MQTT] Connected to', BROKER_URL);
    mqttClient.subscribe('switch/+/cmd');
    mqttClient.subscribe('switch/+/discover');
    console.log('[MQTT] Subscribed');
    // Publish initial state, then start polling
    for (const id of Object.keys(switches)) {
        publishStatus(id, 'offline');
    }
    pollAll(); // first poll now that MQTT is ready
});

mqttClient.on('error', (err) => {
    console.error('[MQTT] Error:', err.message);
});

mqttClient.on('message', (topic, message) => {
    const payload = message.toString();
    const parts = topic.split('/');
    if (parts[0] !== 'switch' || parts.length < 3) return;
    const deviceId = parts[1];
    const type = parts[2];

    if (type === 'cmd') {
        console.log(`[CMD] ${deviceId}: ${payload}`);
        executeTelnet(deviceId, payload);
    } else if (type === 'discover') {
        discoverSwitch(deviceId);
    }
});

function publishStatus(deviceId, status) {
    const sw = switches[deviceId];
    if (sw) { sw.status = status; sw.lastSeen = new Date().toISOString(); }
    mqttClient.publish(`switch/${deviceId}/status`, status);
}

function publishResponse(deviceId, output, success = true) {
    const sw = switches[deviceId];
    if (sw) {
        sw.lastResponse = output;
        sw.lastSeen = new Date().toISOString();
        sw.status = 'online';
    }
    mqttClient.publish(`switch/${deviceId}/response`, output);
    if (sw) publishInfo(deviceId);
}

function publishInfo(deviceId) {
    const sw = switches[deviceId];
    if (!sw) return;
    const info = {
        ip: sw.ip, name: sw.name || deviceId,
        model: sw.model || '', firmware: sw.firmware || '',
        mac: sw.mac || '', group: sw.group || 'switches',
        cpu: sw.cpu, memory: sw.memory, temperature: sw.temperature,
        uptime: sw.uptime, ports: Object.keys(sw.ports).length,
    };
    mqttClient.publish(`switch/${deviceId}/info`, JSON.stringify(info));
    const portList = Object.entries(sw.ports || {}).map(([idx, p]) => ({
        index: idx, name: p.name || `Port ${idx}`,
        status: p.status || 'unknown',
        inBytes: p.inBytes || 0, outBytes: p.outBytes || 0,
    }));
    mqttClient.publish(`switch/${deviceId}/telemetry`, JSON.stringify({
        cpu: sw.cpu, memory: sw.memory,
        temperature: sw.temperature, uptime: sw.uptime,
        ports: sw.ports, portList,
    }));
}

// ─── Async SNMP Polling (3 batched exec calls, non-blocking) ─

function snmpWalk(ip, community, oid) {
    return new Promise((resolve) => {
        exec(`snmpwalk -v2c -c ${community} -Oqne ${ip} ${oid}`, { timeout: 10000 },
            (err, stdout) => {
                if (err) return resolve([]);
                resolve(stdout.trim().split('\n').filter(l => l.trim()));
            });
    });
}

function parseSnmp(lines) {
    // -Oqne format: ".oid.value value"
    // For flat MIBs like .X.0, extract X (second-to-last segment) as key
    // For table MIBs like .X.INDEX, extract INDEX (last segment) as key
    const result = {};
    for (const line of lines) {
        const sp = line.indexOf(' ');
        if (sp <= 0) continue;
        const oid = line.substring(0, sp);
        let val = line.substring(sp + 1).trim();
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        const dot = oid.lastIndexOf('.');
        const idx = dot > 0 ? oid.substring(dot + 1) : '';
        // If last segment is 0, try second-to-last (BDCOM flat MIB style)
        if (idx === '0') {
            const dot2 = oid.lastIndexOf('.', dot - 1);
            if (dot2 > 0) {
                const attr = oid.substring(dot2 + 1, dot);
                if (/^\d+$/.test(attr)) result[attr] = val;
            }
        } else if (/^\d+$/.test(idx)) {
            result[idx] = val;
        }
    }
    return result;
}

async function pollSwitch(deviceId) {
    const sw = switches[deviceId];
    if (!sw) return;
    console.log(`[SNMP] Polling ${deviceId} (${sw.ip})`);

    // 3 batched walks in parallel
    const [sysData, hwData, ifData] = await Promise.all([
        snmpWalk(sw.ip, sw.community, '1.3.6.1.2.1.1'),          // sysDescr, sysUptime
        snmpWalk(sw.ip, sw.community, '1.3.6.1.4.1.3320.9.48'),  // CPU, Mem, Temp
        snmpWalk(sw.ip, sw.community, '1.3.6.1.2.1.2.2.1'),       // ifTable
    ]);

    const sys = parseSnmp(sysData);
    const hw = parseSnmp(hwData);
    const ift = parseSnmp(ifData);

    // System
    if (!sw.model && sys['1']) sw.model = sys['1'];
    if (sys['3']) sw.uptime = parseInt(sys['3']);

    // CPU / Memory / Temperature
    if (hw['1']) sw.cpu = parseInt(hw['1']);
    const memTotal = parseInt(hw['2']);
    const memUsed = parseInt(hw['5']);
    if (memTotal && !isNaN(memUsed)) {
        sw.memory = { total: memTotal, used: memUsed, free: memTotal - memUsed };
    }
    const tempVal = parseInt(hw['6']);
    if (!isNaN(tempVal)) sw.temperature = tempVal;

    // Ports from ifTable — extract last OID index + detect sub-OID type
    const portMap = {};
    for (const line of ifData) {
        const sp = line.indexOf(' ');
        if (sp <= 0) continue;
        const oid = line.substring(0, sp);
        let val = line.substring(sp + 1).trim();
        const idx = oid.substring(oid.lastIndexOf('.') + 1);
        if (!idx || !/^\d+$/.test(idx)) continue;
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (!portMap[idx]) portMap[idx] = { name: `Port ${idx}` };
        if (oid.endsWith('.2.1.2.' + idx)) portMap[idx].name = val;
        else if (oid.endsWith('.2.1.10.' + idx)) portMap[idx].inBytes = parseInt(val) || 0;
        else if (oid.endsWith('.2.1.16.' + idx)) portMap[idx].outBytes = parseInt(val) || 0;
        else if (oid.endsWith('.2.1.8.' + idx)) portMap[idx].status = val === '1' ? 'up' : 'down';
    }
    sw.ports = Object.fromEntries(
        Object.entries(portMap).filter(([k, v]) => v.name).map(([k, v]) => [
            k, { name: v.name, inBytes: v.inBytes || 0, outBytes: v.outBytes || 0, status: v.status || 'unknown' }
        ])
    );

    // Publish
    const reachable = sw.cpu !== null || sw.memory !== null;
    sw.status = reachable ? 'online' : 'offline';
    publishStatus(deviceId, sw.status);
    publishInfo(deviceId);
    console.log(`[SNMP] ${deviceId} — CPU: ${sw.cpu ?? 'N/A'}% Mem: ${sw.memory ? Math.round(sw.memory.used/1024/1024) + '/' + Math.round(sw.memory.total/1024/1024) + 'MB' : 'N/A'} Ports: ${Object.keys(sw.ports).length} Temp: ${sw.temperature ?? 'N/A'}°C`);
}

async function pollAll() {
    for (const id of Object.keys(switches)) {
        await pollSwitch(id);
    }
}

// ─── Telnet Command Execution ──────────────────────────────────

function telnetCommand(host, username, password, command, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        let buffer = '';
        let authenticated = false;
        let cmdSent = false;
        let timer = setTimeout(() => { client.destroy(); reject(new Error('Timeout')); }, timeout);

        client.connect(23, host, () => {});

        client.on('data', (data) => {
            buffer += data.toString('utf-8');

            if ((buffer.includes('Username:') || buffer.includes('login:')) && !authenticated) {
                client.write(username + '\n');
                buffer = '';
            } else if (buffer.includes('Password:') && !authenticated) {
                client.write(password + '\n');
                buffer = '';
            } else if (!cmdSent && (buffer.includes('>') || buffer.includes('#'))) {
                authenticated = true;
                if (buffer.includes('>') && !buffer.includes('#')) {
                    client.write('enable\n');
                    setTimeout(() => client.write(password + '\n'), 200);
                }
                client.write(command + '\n');
                cmdSent = true;
                buffer = '';
                setTimeout(() => {
                    clearTimeout(timer);
                    client.destroy();
                    const lines = buffer.split('\n')
                        .filter(l => l.trim() && !l.includes(command.trim()) &&
                            !l.includes('Username:') && !l.includes('Password:') &&
                            !l.includes('enable') && !l.startsWith('---') && !l.startsWith('===') &&
                            !l.match(/^[\s\-=*]+$/) && !l.includes('Welcome'));
                    resolve(lines.join('\n').trim() || buffer.trim());
                }, 2500);
            }
        });

        client.on('error', (err) => { clearTimeout(timer); reject(err); });
        client.on('close', () => { clearTimeout(timer); });
    });
}

async function executeTelnet(deviceId, command) {
    const sw = switches[deviceId];
    if (!sw) {
        mqttClient.publish(`switch/${deviceId}/response`, `ERROR: Unknown switch ${deviceId}`);
        return;
    }
    try {
        console.log(`[TELNET] ${deviceId}: ${command}`);
        const output = await telnetCommand(sw.ip, sw.username, sw.password, command);
        publishResponse(deviceId, output || 'Command executed (no output)');
        console.log(`[TELNET] ${deviceId}: OK (${output.length} chars)`);
    } catch (err) {
        console.error(`[TELNET] ${deviceId} error: ${err.message}`);
        publishResponse(deviceId, `ERROR: ${err.message}`, false);
    }
}

function discoverSwitch(deviceId) {
    const sw = switches[deviceId];
    if (!sw) return;
    console.log(`[DISCOVER] ${deviceId} (${sw.ip})`);
    executeTelnet(deviceId, 'show system all');
    setTimeout(() => pollSwitch(deviceId), 3000);
}

// ─── Start ─────────────────────────────────────────────────────

loadConfig();
setInterval(pollAll, POLL_INTERVAL);

console.log(`[START] Switch Control Service`);
console.log(`[START] Poll interval: ${POLL_INTERVAL / 1000}s`);
console.log(`[START] MQTT broker: ${BROKER_URL}`);

// Watch for config changes
fs.watchFile(CONFIG_PATH, (curr, prev) => {
    if (curr.mtime !== prev.mtime) {
        console.log('[CONFIG] Reloading switches.json');
        loadConfig();
    }
});
