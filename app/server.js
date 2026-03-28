exports.run = function () {
  // attach nvim
  const { plugin } = require('./nvim')
  const http = require('http')
  const websocket = require('socket.io')

  const fs = require('fs')
  const path = require('path')
  const opener = require('./lib/util/opener')
  const logger = require('./lib/util/logger')('app/server')
  const { applyInlineChangesToContent } = require('./lib/util/applyInlineChanges')
  const { resolveBufferPath } = require('./lib/util/resolveBufferPath')
  const { getIP } = require('./lib/util/getIP')
  const routes = require('./routes')

  const safeReply = (done) => typeof done === 'function' ? done : () => {}

  let clients = {}

  const openUrl = (url, browser) => {
    const handler = opener(url, browser)
    handler.on('error', (err) => {
      const message = err.message || ''
      const match = message.match(/\s*spawn\s+(.+)\s+ENOENT\s*/)
      if (match) {
        plugin.nvim.call('mkdp#util#echo_messages', ['Error', [`[markdown-preview.nvim]: Can not open browser by using ${match[1]} command`]])
      } else {
        plugin.nvim.call('mkdp#util#echo_messages', ['Error', [err.name, err.message]])
      }
    })
  }

  const update_clients_active_var = () => {
    if (Object.values(clients).some(cs => cs.some(c => c.connected))) {
      plugin.nvim.setVar('mkdp_clients_active', 1)
    } else {
      plugin.nvim.setVar('mkdp_clients_active', 0)
    }
  }

  // http server
  const server = http.createServer(async (req, res) => {
    // plugin
    req.plugin = plugin
    // bufnr
    req.bufnr = (req.headers.referer || req.url)
      .replace(/[?#].*$/, '').split('/').pop()
    // request path
    req.asPath = req.url.replace(/[?#].*$/, '')
    req.mkcss = await plugin.nvim.getVar('mkdp_markdown_css')
    req.hicss = await plugin.nvim.getVar('mkdp_highlight_css')
    req.custImgPath = await plugin.nvim.getVar('mkdp_images_path')
    // routes
    routes(req, res)
  })

  // websocket server
  const io = websocket(server)

  io.on('connection', async (client) => {
    const { handshake = { query: {} } } = client
    const bufnr = handshake.query.bufnr

    logger.info('client connect: ', client.id, bufnr)

    clients[bufnr] = clients[bufnr] || []
    clients[bufnr].push(client)
    // update vim variable
    update_clients_active_var();

    const loadBufferById = async (targetBufnr) => {
      const buffers = await plugin.nvim.buffers
      return buffers.find(b => b.id === Number(targetBufnr))
    }

    const buildRefreshData = async (targetBufnr) => {
      const buffer = await loadBufferById(targetBufnr)
      if (!buffer) return null

      const winline = await plugin.nvim.call('winline')
      const currentWindow = await plugin.nvim.window
      const winheight = await plugin.nvim.call('winheight', currentWindow.id)
      const cursor = await plugin.nvim.call('getpos', '.')
      const options = await plugin.nvim.getVar('mkdp_preview_options')
      const pageTitle = await plugin.nvim.getVar('mkdp_page_title')
      const theme = await plugin.nvim.getVar('mkdp_theme')
      const name = await buffer.name
      let content = await buffer.getLines()
      const currentBuffer = await plugin.nvim.buffer

      // Convert YAML frontmatter to a fenced code block for better rendering
      if (content.length > 0 && content[0].trim() === '---') {
        let endIdx = -1
        for (let i = 1; i < content.length; i++) {
          if (content[i].trim() === '---' || content[i].trim() === '...') {
            endIdx = i
            break
          }
        }
        if (endIdx > 0) {
          content = [
            '```yaml',
            ...content.slice(1, endIdx),
            '```',
            ...content.slice(endIdx + 1)
          ]
        }
      }

      return {
        options,
        isActive: currentBuffer.id === buffer.id,
        winline,
        winheight,
        cursor,
        pageTitle,
        theme,
        name,
        content
      }
    }

    const emitRefreshContent = async (targetBufnr, targetClient) => {
      const data = await buildRefreshData(targetBufnr)
      if (!data) return false

      if (targetClient) {
        if (targetClient.connected) {
          targetClient.emit('refresh_content', data)
        }
      } else {
        ;(clients[targetBufnr] || []).forEach(c => {
          if (c.connected) {
            c.emit('refresh_content', data)
          }
        })
      }
      return true
    }

    await emitRefreshContent(Number(bufnr), client)

    client.on('update_lines', async ({ bufnr: updateBufnr, changes }, done) => {
      const reply = safeReply(done)
      try {
        const targetBufnr = Number(updateBufnr || bufnr)
        const buffer = await loadBufferById(targetBufnr)
        if (!buffer) {
          reply({ ok: false, applied: 0, error: 'buffer not found' })
          return
        }

        const filePath = await buffer.name
        if (!filePath) {
          reply({ ok: false, applied: 0, error: 'buffer has no file path' })
          return
        }

        const nvimCwd = await plugin.nvim.call('getcwd')
        const resolvedFilePath = resolveBufferPath(filePath, nvimCwd)
        let content = await fs.promises.readFile(resolvedFilePath, 'utf-8')
        const result = applyInlineChangesToContent(content, changes)

        if (result.unapplied.length > 0) {
          logger.error('update_lines: unapplied changes: ', result.unapplied.length)
        }

        if (result.applied > 0 && result.content !== content) {
          await fs.promises.writeFile(resolvedFilePath, result.content, 'utf-8')
          await plugin.nvim.command('checktime')
          logger.info('inline edit: ', result.applied, 'changes written to', resolvedFilePath)
        }

        reply({ ok: true, applied: result.applied, unapplied: result.unapplied.length })
        if (result.applied > 0 && result.content !== content) {
          emitRefreshContent(targetBufnr)
        }
      } catch (e) {
        logger.error('update_lines error: ', e)
        reply({ ok: false, applied: 0, error: String((e && e.message) || e) })
      }
    })

    client.on('read_source', async ({ bufnr: updateBufnr }, done) => {
      const reply = safeReply(done)
      try {
        const targetBufnr = Number(updateBufnr || bufnr)
        const buffer = await loadBufferById(targetBufnr)
        if (!buffer) {
          reply({ ok: false, error: 'buffer not found' })
          return
        }

        const filePath = await buffer.name
        if (!filePath) {
          reply({ ok: false, error: 'buffer has no file path' })
          return
        }

        const nvimCwd = await plugin.nvim.call('getcwd')
        const resolvedFilePath = resolveBufferPath(filePath, nvimCwd)
        const content = await fs.promises.readFile(resolvedFilePath, 'utf-8')
        reply({
          ok: true,
          content,
          filePath: resolvedFilePath
        })
      } catch (e) {
        logger.error('read_source error: ', e)
        reply({ ok: false, error: String((e && e.message) || e) })
      }
    })

    client.on('write_source', async ({ bufnr: updateBufnr, content }, done) => {
      const reply = safeReply(done)
      try {
        const targetBufnr = Number(updateBufnr || bufnr)
        const buffer = await loadBufferById(targetBufnr)
        if (!buffer) {
          reply({ ok: false, error: 'buffer not found' })
          return
        }

        if (typeof content !== 'string') {
          reply({ ok: false, error: 'content must be string' })
          return
        }

        const filePath = await buffer.name
        if (!filePath) {
          reply({ ok: false, error: 'buffer has no file path' })
          return
        }

        const nvimCwd = await plugin.nvim.call('getcwd')
        const resolvedFilePath = resolveBufferPath(filePath, nvimCwd)
        await fs.promises.writeFile(resolvedFilePath, content, 'utf-8')
        await plugin.nvim.command('checktime')
        logger.info('source write: chars=', content.length, 'path=', resolvedFilePath)
        reply({
          ok: true,
          filePath: resolvedFilePath
        })
        // Refresh preview after reply so the callback isn't lost
        emitRefreshContent(targetBufnr)
      } catch (e) {
        logger.error('write_source error: ', e)
        reply({ ok: false, error: String((e && e.message) || e) })
      }
    })

    client.on('list_md_tree', async ({ bufnr: queryBufnr }, done) => {
      const reply = safeReply(done)
      try {
        const targetBufnr = Number(queryBufnr || bufnr)
        const buffer = await loadBufferById(targetBufnr)
        if (!buffer) {
          reply({ ok: false, error: 'buffer not found' })
          return
        }

        const filePath = await buffer.name
        const nvimCwd = await plugin.nvim.call('getcwd')
        const resolvedFilePath = resolveBufferPath(filePath, nvimCwd)
        const rootDir = path.dirname(resolvedFilePath)

        async function scanDir (dir) {
          const entries = await fs.promises.readdir(dir, { withFileTypes: true })
          const children = []
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name.startsWith('.')) continue
            const fullPath = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              const sub = await scanDir(fullPath)
              if (sub.children.length > 0) {
                children.push(sub)
              }
            } else if (/\.(md|markdown)$/i.test(entry.name)) {
              children.push({
                name: entry.name,
                path: fullPath,
                type: 'file',
                isCurrent: fullPath === resolvedFilePath
              })
            }
          }
          return {
            name: path.basename(dir),
            path: dir,
            type: 'dir',
            children
          }
        }

        const tree = await scanDir(rootDir)
        reply({ ok: true, tree, rootPath: rootDir })
      } catch (e) {
        logger.error('list_md_tree error: ', e)
        reply({ ok: false, error: String((e && e.message) || e) })
      }
    })

    client.on('open_md_file', async ({ filePath }, done) => {
      const reply = safeReply(done)
      try {
        if (!filePath || typeof filePath !== 'string') {
          reply({ ok: false, error: 'filePath required' })
          return
        }
        await plugin.nvim.command('badd ' + filePath.replace(/ /g, '\\ '))
        const newBufnr = await plugin.nvim.call('bufnr', filePath)
        if (!newBufnr || newBufnr < 1) {
          reply({ ok: false, error: 'failed to open buffer' })
          return
        }
        await plugin.nvim.command('bufload ' + newBufnr)
        reply({ ok: true, bufnr: newBufnr })
      } catch (e) {
        logger.error('open_md_file error: ', e)
        reply({ ok: false, error: String((e && e.message) || e) })
      }
    })

    client.on('disconnect', function () {
      logger.info('disconnect: ', client.id)
      clients[bufnr] = (clients[bufnr] || []).filter(c => c.id !== client.id)
      // update vim variable
      update_clients_active_var();
    })
  })

  async function startServer () {
    const openToTheWord = await plugin.nvim.getVar('mkdp_open_to_the_world')
    const host = openToTheWord ? '0.0.0.0' : '127.0.0.1'
    let port = await plugin.nvim.getVar('mkdp_port')
    port = port || (8080 + Number(`${Date.now()}`.slice(-3)))
    server.listen({
      host,
      port
    }, async function () {
      logger.info('server run: ', port)
      function refreshPage ({ bufnr, data }) {
        logger.info('refresh page: ', bufnr)
        ;(clients[bufnr] || []).forEach(c => {
          if (c.connected) {
            c.emit('refresh_content', data)
          }
        })
      }
      function closePage ({ bufnr }) {
        logger.info('close page: ', bufnr)
        clients[bufnr] = (clients[bufnr] || []).filter(c => {
          if (c.connected) {
            c.emit('close_page')
            return false
          }
          return true
        })
      }
      function closeAllPages () {
        logger.info('close all pages')
        Object.keys(clients).forEach(bufnr => {
          ;(clients[bufnr] || []).forEach(c => {
            if (c.connected) {
              c.emit('close_page')
            }
          })
        })
        clients = {}
      }
      async function buildUrl (path) {
        const openIp = await plugin.nvim.getVar('mkdp_open_ip')
        const openHost = openIp !== '' ? openIp : (openToTheWord ? getIP() : 'localhost')
        return `http://${openHost}:${port}${path}`
      }
      async function launchInBrowser (url, label) {
        const browserfunc = await plugin.nvim.getVar('mkdp_browserfunc')
        if (browserfunc !== '') {
          logger.info(`open ${label} [${browserfunc}]: `, url)
          plugin.nvim.call(browserfunc, [url])
        } else {
          const browser = await plugin.nvim.getVar('mkdp_browser')
          logger.info(`open ${label} [${browser || 'default'}]: `, url)
          if (browser !== '') {
            openUrl(url, browser)
          } else {
            openUrl(url)
          }
        }
      }
      async function openBrowser ({ bufnr }) {
        const combinePreview = await plugin.nvim.getVar('mkdp_combine_preview')
        if (combinePreview && Object.values(clients).some(cs => cs.some(c => c.connected))) {
          logger.info(`combine preview page: `, bufnr)
          Object.values(clients).forEach(cs => {
            cs.forEach(c => {
              if (c.connected) {
                c.emit('change_bufnr', bufnr)
              }
            })
          })
        } else {
          const url = await buildUrl(`/page/${bufnr}`)
          await launchInBrowser(url, 'page')
          const isEchoUrl = await plugin.nvim.getVar('mkdp_echo_preview_url')
          if (isEchoUrl) {
            plugin.nvim.call('mkdp#util#echo_url', [url])
          }
        }
      }
      async function openAnnotator ({ bufnr }) {
        const url = await buildUrl(`/_static/annotator.html?page=${bufnr}`)
        await launchInBrowser(url, 'annotator')
      }
      plugin.init({
        refreshPage,
        closePage,
        closeAllPages,
        openBrowser,
        openAnnotator
      })

      const openAnnotatorOnStart = await plugin.nvim.getVar('mkdp_open_annotator_on_start')
      if (openAnnotatorOnStart) {
        await plugin.nvim.setVar('mkdp_open_annotator_on_start', 0)
        plugin.nvim.call('mkdp#util#open_annotator')
      } else {
        plugin.nvim.call('mkdp#util#open_browser')
      }
    })
  }

  startServer()
}
