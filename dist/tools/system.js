import os from 'node:os';
import { execSync } from 'node:child_process';
export function systemInfoTool() {
    return {
        name: 'system_info',
        description: 'Returns safe OS details plus uptime, load average, memory, and disk usage for the local machine.',
        permission: 'read',
        schema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
        handler: async () => {
            const uptime = os.uptime();
            const load = os.loadavg();
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const osInfo = {
                platform: os.platform(),
                type: os.type(),
                release: os.release(),
                version: typeof os.version === 'function' ? os.version() : undefined,
                arch: os.arch(),
                cpus: os.cpus().length,
            };
            let disk = 'unavailable';
            try {
                const raw = execSync('df -k .').toString().trim().split('\n')[1]?.split(/\s+/);
                if (raw && raw.length >= 5) {
                    const total = Number(raw[1]) * 1024;
                    const used = Number(raw[2]) * 1024;
                    const avail = Number(raw[3]) * 1024;
                    disk = JSON.stringify({ total, used, available: avail, usePercent: raw[4] });
                }
            }
            catch {
                // ignore
            }
            return {
                os: osInfo,
                uptimeSeconds: uptime,
                loadAvg: load,
                memory: { total: totalMem, free: freeMem, used: totalMem - freeMem },
                disk,
            };
        },
    };
}
