// pm2 ecosystem — levanta los 3 procesos de JARVIS en un servidor limpio.
// Uso: pm2 start ecosystem.config.cjs  (desde /opt/JARVIS, tras npm ci y .env restaurado)
module.exports = {
    apps: [
        {
            name: 'JARVIS',
            cwd: '/opt/JARVIS',
            script: 'node_modules/.bin/tsx',
            args: 'src/index.ts',
            autorestart: true,
            max_memory_restart: '1G',
            env: { NODE_ENV: 'production' },
        },
        {
            name: 'JARVIS_OS',
            cwd: '/opt/JARVIS/jarvis-os',
            script: 'npm',
            args: 'run dev -- --host 0.0.0.0',
            autorestart: true,
            max_memory_restart: '1G',
        },
        {
            name: 'KRONOS_API',
            cwd: '/opt/JARVIS',
            script: 'kronos_api/venv/bin/uvicorn',
            args: 'kronos_api.main:app --host 0.0.0.0 --port 8000',
            autorestart: true,
        },
    ],
};
