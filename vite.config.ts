import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

const BROWSER_AGENT_PORT = '8787'

let browserAgent: ChildProcess | undefined

const browserAgentPlugin = (): Plugin => ({
  name: 'browser-agent',
  configureServer(server) {
    const python = path.resolve('.venv/bin/python')
    const script = path.resolve('scripts/browser_use/server.py')
    if (!existsSync(python) || !existsSync(script)) {
      server.config.logger.warn(
        'Browser agent was not started. Install the experiment deps into .venv first.',
      )
      return
    }
    if (browserAgent && browserAgent.exitCode === null && !browserAgent.killed) return

    const env = { ...process.env, BROWSER_AGENT_PORT }
    // Let Playwright use its default browser cache. A parent process sometimes
    // points this at a temporary directory that does not contain Chromium.
    delete env.PLAYWRIGHT_BROWSERS_PATH
    browserAgent = spawn(python, [script], {
      stdio: 'inherit',
      env,
    })
    const stop = () => {
      if (browserAgent && !browserAgent.killed) browserAgent.kill()
      browserAgent = undefined
    }
    server.httpServer?.once('close', stop)
  },
})

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VLLM_BASE_URL || 'http://localhost:8000'

  return {
    plugins: [react(), browserAgentPlugin()],
    server: {
      proxy: {
        '/v1': {
          target,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              const authorization = req.headers.authorization
              if (authorization) {
                proxyReq.setHeader('Authorization', authorization)
              }
            })
          },
        },
        '/browser': {
          target: `http://127.0.0.1:${BROWSER_AGENT_PORT}`,
          changeOrigin: true,
          timeout: 0,
          proxyTimeout: 0,
        },
      },
    },
  }
})
