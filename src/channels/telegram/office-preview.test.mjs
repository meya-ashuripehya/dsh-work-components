import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { extractContentPreview } from './office-preview.mjs'
import { classifyPreview, mmFileBlock } from './files.mjs'

function zip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const nameBuf = Buffer.from(name)
    const comp = deflateRawSync(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const localRec = Buffer.concat([local, nameBuf, comp])
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBuf]))
    locals.push(localRec)
    offset += localRec.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(centrals.length, 8)
  eocd.writeUInt16LE(centrals.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

test('extracts docx, xlsx, pptx, pdf and markdown kind', () => {
  assert.equal(classifyPreview('note.md'), 'markdown')
  const docx = zip({
    'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>你好</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>',
  })
  assert.equal(extractContentPreview(docx, 'a.docx').text, '你好\n第二段')

  const xlsx = zip({
    'xl/sharedStrings.xml': '<sst><si><t>姓名</t></si><si><t>甲</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>1</v></c></row><row><c r="A2" t="s"><v>1</v></c><c r="B2"><v>2</v></c></row></sheetData></worksheet>',
  })
  const sheet = extractContentPreview(xlsx, 'a.xlsx')
  assert.deepEqual(sheet.rows, [['姓名', '1'], ['甲', '2']])

  const pptx = zip({
    'ppt/slides/slide1.xml': '<p:sld><a:t>封面</a:t><a:t>要点</a:t></p:sld>',
  })
  assert.deepEqual(extractContentPreview(pptx, 'a.pptx').slides, [['封面', '要点']])

  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 20 >>\nstream\nBT (Hello PDF) Tj ET\nendstream\nendobj\n')
  assert.match(extractContentPreview(pdf, 'a.pdf').text, /Hello PDF/)

  const card = mmFileBlock({
    name: 'a.xlsx', bytes: 10, mimeType: 'application/vnd.ms-excel', previewKind: 'sheet', previewId: 'x',
    text: sheet.text, preview: JSON.stringify({ rows: sheet.rows }),
  })
  assert.deepEqual(card.file.rows, [['姓名', '1'], ['甲', '2']])
})

test('legacy doc keeps readable utf-16 text', () => {
  const got = extractContentPreview(Buffer.from('季度总结', 'utf16le'), 'old.doc')
  assert.equal(got.text, '季度总结')
})
