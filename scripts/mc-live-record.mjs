/** Bounded local acceptance capture with graceful early stop (keeps MP4 playable). */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
const [output, secondsText, stopFile] = process.argv.slice(2)
const seconds = Number(secondsText)
if (!output || !stopFile || !Number.isInteger(seconds) || seconds < 1 || seconds > 1800) throw Error('output, 1..1800 seconds, stop file required')
const ffmpeg = 'C:/Users/10917/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe'
const capture = spawn(ffmpeg, ['-y','-hide_banner','-loglevel','error','-f','gdigrab','-framerate','10','-i','desktop','-t',String(seconds),'-c:v','h264_nvenc','-preset','p5','-cq','26','-pix_fmt','yuv420p','-movflags','+faststart',output], { stdio: ['pipe','ignore','pipe'], windowsHide: true })
let stopping = false
const stop = () => { if (!stopping) { stopping = true; capture.stdin.write('q\n') } }
const timer = setInterval(() => { if (existsSync(stopFile)) stop() }, 250)
capture.stdin.on('error', () => {})
capture.stderr.on('data', data => process.stderr.write(data))
process.on('SIGINT', stop); process.on('SIGTERM', stop)
capture.on('error', () => { clearInterval(timer); process.exitCode = 1 })
capture.on('exit', code => { clearInterval(timer); process.exitCode = code || 0; console.log(JSON.stringify({ output, code, stoppedEarly: stopping })) })
