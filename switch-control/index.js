const mqtt = require('mqtt');
const { execSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const MQTT_BROKER = process.env.MQTT_BROKER || 'tcp://192.168.10.10:1883';
const SWITCHES_FILE = path.join(__dirname, 'switches.json');
const POLL_INTERVAL = 120000;
const CMD_TIMEOUT = 30000;

let switches = {};

const mqttClient = mqtt.connect(MQTT_BROKER, { reconnectPeriod: 10000 });

mqttClient.on('connect', () => {
    console.log(`[switch-control] Connected to MQTT at ${MQTT_BROKER}`);
    Object.keys(switches).forEach(id => mqttClient.subscribe(`switch/${id}/cmd`));
});

mqttClient.on('message', (topic, message) => {
    const parts = topic.split('/');
    if (parts.length < 3) return;
    const deviceId = parts[1];
    if (parts[2] === 'cmd' && switches[deviceId]) {
        const cmd = message.toString().trim();
        console.log(`[${deviceId}] CMD: ${cmd.substring(0,80)}`);
        executeTelnetCommand(deviceId, cmd);
    }
});

function loadSwitches() {
    try {
        const raw = fs.readFileSync(SWITCHES_FILE, 'utf8');
        const list = JSON.parse(raw);
        switches = {};
        list.forEach(sw => {
            const id = `SW_${sw.mac.replace(/:/g,'').toUpperCase()}`;
            sw.id = id;
            switches[id] = sw;
            console.log(`[switch-control] Loaded: ${sw.name} (${id})`);
            mqttClient.subscribe(`switch/${id}/cmd`);
        });
        console.log(`[switch-control] ${Object.keys(switches).length} switch(es)`);
    } catch(e) {
        console.error(`Failed to load switches: ${e.message}`);
    }
}
loadSwitches();
fs.watchFile(SWITCHES_FILE, () => { loadSwitches(); });

// ─── SNMP ─────────────────────────────────────────────────────
function snmpGet(host, community, oid) {
    try {
        const out = execSync(`snmpget -v2c -c ${community} -Oqv ${host} ${oid}`, { timeout: 5000, encoding: 'utf8' });
        const val = out.trim();
        if (val && !val.includes('No Such')) return parseInt(val.replace(/["\s]/g, ''));
    } catch(e) {}
    return null;
}
function snmpWalk(host, community, oid) {
    try {
        const out = execSync(`snmpwalk -v2c -c ${community} -Oqv ${host} ${oid}`, { timeout: 8000, encoding: 'utf8' });
        return out.trim().split('\n').map(l => l.trim()).filter(l => l && !l.includes('No more'));
    } catch(e) { return []; }
}

async function pollSwitch(sw) {
    const { ip, community, id } = sw;
    const result = { ports: {} };
    const cpu = snmpGet(ip, community, '.1.3.6.1.4.1.3320.9.48.1.0');
    if (cpu !== null) result.cpu = cpu;
    const totalMem = snmpGet(ip, community, '.1.3.6.1.4.1.3320.9.48.2.0');
    const usedMem = snmpGet(ip, community, '.1.3.6.1.4.1.3320.9.48.5.0');
    const freeMem = snmpGet(ip, community, '.1.3.6.1.4.1.3320.9.48.3.0');
    if (totalMem) result.memory = { total: totalMem, used: usedMem || 0, free: freeMem || 0 };
    const temp = snmpGet(ip, community, '.1.3.6.1.4.1.3320.9.48.6.0');
    if (temp !== null) result.temperature = temp;
    const ifNames = snmpWalk(ip, community, '.1.3.6.1.2.1.2.2.1.2');
    const ifStatus = snmpWalk(ip, community, '.1.3.6.1.2.1.2.2.1.8');
    const ifIn = snmpWalk(ip, community, '.1.3.6.1.2.1.2.2.1.10');
    const ifOut = snmpWalk(ip, community, '.1.3.6.1.2.1.2.2.1.16');
    if (ifNames.length > 0) {
        for (let i = 0; i < ifNames.length; i++) {
            result.ports[i+1] = {
                name: ifNames[i] || `Port${i+1}`, index: i+1,
                status: (parseInt(ifStatus[i]) === 1) ? 'up' : 'down',
                inBytes: parseInt(ifIn[i] || '0'),
                outBytes: parseInt(ifOut[i] || '0'),
            };
        }
    }
    console.log(`[${id}] Poll: CPU=${result.cpu}% Temp=${result.temperature}°C Ports=${Object.keys(result.ports).length}`);
    return result;
}

function publishTelemetry(id, data) {
    const portList = Object.values(data.ports || {}).map(p => ({
        index: p.index, name: p.name, status: p.status,
        inBytes: p.inBytes, outBytes: p.outBytes
    }));
    mqttClient.publish(`switch/${id}/telemetry`, JSON.stringify({
        cpu: data.cpu, memory: data.memory, temperature: data.temperature,
        ports: data.ports, portList, mac: switches[id]?.mac || ''
    }));
}

async function runPollCycle() {
    for (const id of Object.keys(switches)) {
        const sw = switches[id];
        mqttClient.publish(`switch/${id}/status`, 'online');
        const data = await pollSwitch(sw);
        if (data.cpu !== undefined || data.memory) publishTelemetry(id, data);
    }
}
runPollCycle();
setInterval(runPollCycle, POLL_INTERVAL);

// ─── Telnet Executor (robust BDCOM) ───────────────────────────
function executeTelnetCommand(deviceId, cmd) {
    const sw = switches[deviceId];
    if (!sw) return mqttClient.publish(`switch/${deviceId}/response`, `Error: Unknown switch ${deviceId}`);

    // Fix BDCOM-specific hyphen issue
    if (cmd === 'show mac-address-table') cmd = 'show mac address-table';

    const client = new net.Socket();
    let buf = '';
    let outputBuf = '';
    let stage = 0;
    let cmdSent = false;
    let cmdLine = cmd;

    const send = (text, nextStage) => {
        console.log(`[${deviceId}] Stage ${stage}→${nextStage}: sending "${text.substring(0,40)}"`);
        client.write(text + '\r\n');
        stage = nextStage;
    };

    const finish = () => {
        if (cmdSent && outputBuf) {
            const clean = outputBuf.replace(/\r/g, '')
                .replace(/\xff[\xfb-\xfe][\x00-\xff]/g, '')
                .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
                .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
            
            const lines = clean.split('\n');
            let outLines = [];
            let foundCmd = false;
            for (const line of lines) {
                const t = line.trim();
                if (!foundCmd && (t === cmdLine || t.includes(cmdLine))) {
                    foundCmd = true;
                    continue;
                }
                if (foundCmd && (/#\s*$/.test(t) || />\s*$/.test(t) || t.includes('F1-SOFT-'))) break;
                if (foundCmd && t && !t.includes('--More--')) outLines.push(t);
            }
            
            let out = outLines.join('\n').trim();
            if (!out) {
                // Fallback: just the whole cleaned output
                out = clean.replace(/.*?\nshow version\n/s, '').trim();
                if (out === clean.trim()) out = clean.trim();
            }
            if (out.length > 20) {
                console.log(`[${deviceId}] Response: ${out.substring(0,80)}...`);
                mqttClient.publish(`switch/${deviceId}/response`, out.substring(0, 5000));
            }
        }
        client.destroy();
    };

    client.connect(23, sw.ip, () => {
        console.log(`[${deviceId}] Telnet connected to ${sw.ip}`);
    });

    client.on('data', (chunk) => {
        const txt = chunk.toString('utf8');
        buf += txt;
        if (cmdSent) outputBuf += txt;
        const clean = buf.replace(/\r/g, '');

        // Stage 0: Wait for login prompt
        if (stage === 0 && /[Uu]sername\s*[:]/.test(clean)) {
            send(sw.username || 'admin', 1);
            return;
        }
        // Stage 1: Wait for password prompt
        if (stage === 1 && /[Pp]assword\s*[:]/.test(clean)) {
            send(sw.password || 'admin', 2);
            return;
        }
        // Stage 2: After login - check if in # or > mode
        if (stage === 2) {
            const lastLines = clean.split('\n').filter(l => l.trim());
            const lastLine = lastLines[lastLines.length - 1] || '';
            if (/#\s*$/.test(lastLine.trim())) {
                console.log(`[${deviceId}] In # mode, sending terminal length 0`);
                send('terminal length 0', 3);
                return;
            }
            if (/>\s*$/.test(lastLine.trim())) {
                console.log(`[${deviceId}] In > mode, sending enable`);
                send('enable', 2); // stay on stage 2 to wait for #
                return;
            }
            // Check for 'Unknown command' or errors
            if (clean.includes('Unknown command') || clean.includes('Incomplete')) {
                console.log(`[${deviceId}] Login issue detected`);
            }
        }
        // Stage 2a: After sending enable, wait for hash prompt
        if (stage === 2 && buf.includes('enable')) {
            if (/[#]/.test(clean) && !/>/.test(clean)) {
                console.log(`[${deviceId}] Now in # mode after enable`);
                send('terminal length 0', 3);
                return;
            }
        }
        // Stage 3: Wait for prompt after terminal length
        // Stage 3: Wait for prompt after terminal length or enable
        if (stage === 3) {
            const lastLines = clean.split('\n').filter(l => l.trim());
            const lastLine = lastLines[lastLines.length - 1] || '';
            if (/[#>]\s*$/.test(lastLine.trim())) {
                console.log(`[${deviceId}] Sending command: ${cmd.substring(0,50)}`);
                send(cmd, 4);
                cmdSent = true;
                // Wait for output then collect
                setTimeout(() => {
                    console.log(`[${deviceId}] Collecting response...`);
                    finish();
                }, 5000);
                setTimeout(() => {
                    if (!client.destroyed) {
                        console.log(`[${deviceId}] Safety timeout, collecting...`);
                        finish();
                    }
                }, 10000);
                return;
            }
            // No prompt yet, check for 'Unknown command' in buffer
            if (clean.includes('Unknown command') || clean.includes('Incomplete')) {
                console.log(`[${deviceId}] Command error detected in buffer`);
                finish();
                return;
            }
        }
    });

    client.on('error', (e) => {
        console.error(`[${deviceId}] Telnet error: ${e.message}`);
        mqttClient.publish(`switch/${deviceId}/response`, `Error: ${e.message}`);
    });

    // Global timeout
    setTimeout(() => {
        if (stage < 4) {
            console.log(`[${deviceId}] Timeout at stage ${stage}`);
            mqttClient.publish(`switch/${deviceId}/response`, buf.replace(/\r/g, '').substring(0, 2000) || `(timeout stage ${stage})`);
            client.destroy();
        } else if (!cmdSent) {
            finish();
        }
    }, CMD_TIMEOUT);
}

console.log(`[switch-control] Started. MQTT: ${MQTT_BROKER}`);
