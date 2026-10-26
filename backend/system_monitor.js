const os = require('os');
const { exec } = require('child_process');
const axios = require('axios');

function getRAMStats() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memoryLoad = Math.round((usedMem / totalMem) * 100);
    return {
        totalGB: (totalMem / 1024 / 1024 / 1024).toFixed(1),
        usedGB: (usedMem / 1024 / 1024 / 1024).toFixed(1),
        loadPercentage: memoryLoad
    };
}

function getGPUStats() {
    return new Promise((resolve) => {
        exec('nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits', (error, stdout) => {
            if (error) {
                // Graceful fallback for non-Nvidia or unconfigured PATH
                resolve({ status: 'N/A (Nvidia-SMI not available)' });
                return;
            }
            try {
                const parts = stdout.trim().split(',');
                if (parts.length >= 3) {
                    resolve({
                        utilization: parts[0].trim() + '%',
                        vramUsed: parts[1].trim() + ' MB',
                        vramTotal: parts[2].trim() + ' MB'
                    });
                } else {
                    resolve({ status: 'Parse error' });
                }
            } catch (e) {
                resolve({ status: 'Error parsing nvidia-smi' });
            }
        });
    });
}

async function checkOllama() {
    try {
        const res = await axios.get('http://localhost:11434/api/tags', { timeout: 2000 });
        if (res.status === 200) {
            const models = res.data.models ? res.data.models.map(m => m.name) : [];
            return { status: 'Online', models_available: models.length };
        }
        return { status: 'Unexpected response' };
    } catch (error) {
        return { status: 'Offline or Unreachable' };
    }
}

async function runDiagnostic() {
    const ram = getRAMStats();
    const gpu = await getGPUStats();
    const ollama = await checkOllama();

    return JSON.stringify({
        System: 'Jarvis Local Framework',
        OS: os.platform(),
        CPU_Cores: os.cpus().length,
        RAM: ram,
        GPU: gpu,
        Ollama_Service: ollama,
        Timestamp: new Date().toISOString()
    }, null, 2);
}

module.exports = { runDiagnostic };
