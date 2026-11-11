import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

const AGENT_SERVER_PORT = '8787'

let agentServer: ChildProcess | undefined

const agentServerPlugin = (): Plugin => ({
  name: 'agent-server',
  configureServer(server) {
    const python = path.resolve('.venv/bin/python')
    const script = path.resolve('agent_server/app.py')
    if (!existsSync(python) || !existsSync(script)) {
      server.config.logger.warn(
        'Agent server was not started. Install agent_server/requirements.txt into .venv first.',
      )
      return
    }
    if (agentServer && agentServer.exitCode === null && !agentServer.killed) return

    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_SERVER_PORT }
    // Let Playwright use its default browser cache. A parent process sometimes
    // points this at a temporary directory that does not contain Chromium.
    delete env.PLAYWRIGHT_BROWSERS_PATH
    agentServer = spawn(python, [script], { stdio: 'inherit', env })
    const stop = () => {
      if (agentServer && !agentServer.killed) agentServer.kill()
      agentServer = undefined
    }
    server.httpServer?.once('close', stop)
  },
})

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VLLM_BASE_URL || 'http://localhost:8000'

  return {
    plugins: [react(), agentServerPlugin()],
    server: {
      proxy: {
        '/v1': {
          target,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              const authorization =
                req.headers.authorization ||
                (env.VLLM_API_KEY ? `Bearer ${env.VLLM_API_KEY}` : undefined)
              if (authorization) {
                proxyReq.setHeader('Authorization', authorization)
              }
            })
          },
        },
        '/api': {
          target: `http://127.0.0.1:${AGENT_SERVER_PORT}`,
          changeOrigin: true,
          timeout: 0,
          proxyTimeout: 0,
        },
      },
    },
  }
})
