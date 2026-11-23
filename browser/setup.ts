import { importDeviceRecord } from '../src/device-import.ts'

const tokenList = document.getElementById('tokens')!
const deviceList = document.getElementById('credentials')!
const fileStatus = document.getElementById('file-status')!
const generate = document.querySelector<HTMLButtonElement>('#generate')!
const fileInput = document.querySelector<HTMLInputElement>('#device')!

function showSecret(container: HTMLElement, name: string, value: string) {
  const row = document.createElement('div')
  row.className = 'secret'
  const label = document.createElement('label')
  label.htmlFor = name
  label.textContent = name
  const entry = document.createElement('div')
  entry.className = 'entry'
  const field = document.createElement('input')
  field.id = name
  field.type = 'password'
  field.readOnly = true
  field.autocomplete = 'off'
  field.value = value
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = 'Copy'
  copy.setAttribute('aria-label', 'Copy ' + name)
  copy.addEventListener('click', async () => {
    const status = document.getElementById('copy-status')!
    try {
      await navigator.clipboard.writeText(field.value)
      status.textContent = name + ' copied.'
      copy.textContent = 'Copied'
    } catch {
      field.type = 'text'
      field.focus()
      field.select()
      field.addEventListener(
        'blur',
        () => {
          field.type = 'password'
        },
        { once: true },
      )
      status.textContent = 'Copy the selected value using your browser.'
    }
  })
  entry.append(field, copy)
  row.append(label, entry)
  container.append(row)
}

generate.addEventListener('click', () => {
  for (const name of ['HOOK_TOKEN', 'MCP_TOKEN', 'MCP_ADMIN_TOKEN']) {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    showSecret(tokenList, name, Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join(''))
  }
  generate.disabled = true
})

fileInput.addEventListener('change', async () => {
  deviceList.replaceChildren()
  fileStatus.textContent = ''
  const file = fileInput.files?.[0]
  if (!file) return
  try {
    if (file.size > 1024 * 1024) throw new Error()
    const values = importDeviceRecord(JSON.parse(await file.text()))
    if (file !== fileInput.files?.[0]) return
    for (const [name, value] of Object.entries(values)) showSecret(deviceList, name, value)
    fileStatus.textContent = values.MUSE_SDK_TOKEN
      ? 'Device values are ready to copy.'
      : 'Also enter the SDK token used to pair this device as MUSE_SDK_TOKEN in Cloudflare.'
  } catch {
    if (file === fileInput.files?.[0])
      fileStatus.textContent = 'Choose a supported authorized device JSON file under 1 MiB.'
  }
})

document.getElementById('connector-url')!.textContent = new URL('/mcp', location.origin).href
document.getElementById('hook-url')!.textContent = new URL('/hooks/default', location.origin).href
