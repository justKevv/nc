import { spawn } from 'node:child_process'

/**
 * Opens a Cloudflare quick tunnel and prints the public URL. Quick tunnels need
 * no account and give a random *.trycloudflare.com hostname, which is fine for
 * a single class session but changes every time you restart.
 */
const PORT = process.env.PORT || 8787
const child = spawn(
  'cloudflared',
  ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

const publicUrl = (line) => {
  const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
  return m ? m[0] : null
}

let announced = false

const onData = (buf) => {
  const text = buf.toString()
  process.stderr.write(text)
  if (announced) return
  for (const line of text.split('\n')) {
    const url = publicUrl(line)
    if (!url) continue
    announced = true
    const pad = ' '.repeat(Math.max(0, 46 - url.length))
    process.stderr.write(
      `\n  ╭──────────────────────────────────────────────╮\n` +
        `  │  Give your students this link:              ${pad}│\n` +
        `  ${url}\n` +
        `  ╰──────────────────────────────────────────────╯\n` +
        `  Live only while this command is running.\n\n`,
    )
  }
}

child.stdout.on('data', onData)
child.stderr.on('data', onData)

child.on('error', (err) => {
  if (err.code === 'ENOENT') {
    process.stderr.write(
      '\n  cloudflared is not installed.\n' +
        '  Install it with:  brew install cloudflared\n\n',
    )
  } else {
    process.stderr.write(`\n  tunnel error: ${err.message}\n\n`)
  }
  process.exit(1)
})

child.on('exit', (code) => process.exit(code ?? 0))

// Take the tunnel down with us, so no orphaned cloudflared is left behind.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child.kill('SIGINT')
    setTimeout(() => process.exit(0), 300)
  })
}
