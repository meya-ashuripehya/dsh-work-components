import { connectImap, connectSmtp } from './mail.mjs'
import { createDispatch, runStdio } from './rpc.mjs'

const address = String(process.env.GMAIL_ADDRESS || '').trim()
const password = String(process.env.GMAIL_APP_PASSWORD || '').trim()
if (!address || !password) {
  process.stderr.write('Gmail 地址或应用专用密码为空\n')
  process.exit(1)
}

runStdio(createDispatch({ address, password, connectImap, connectSmtp }))
