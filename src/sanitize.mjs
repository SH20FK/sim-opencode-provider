// Cleanup of model output before it reaches the client.
//
// Some hosted models (claude-haiku-5-5 is the loudest) fall into a loop and
// emit hundreds of <br> tags, which OpenCode renders as a wall of blank lines.
// A <br> is just a line break the model meant to write, so turn it back into a
// newline. Code fences are left untouched: a <br> inside an HTML snippet is
// real content.

// Fenced blocks and inline code are captured so the odd segments can be skipped.
const CODE_SPLIT = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/

// Drop the third and following copies of the same consecutive line: a model
// stuck in a loop repeats one short line such as <br>, br, or a separator.
function collapseRepeats(text) {
  const lines = text.split('\n')
  const out = []
  let prev = null
  let run = 0
  for (const line of lines) {
    const key = line.trim()
    if (key && key === prev) {
      run++
      if (run > 2) continue
    } else {
      prev = key
      run = 0
    }
    out.push(line)
  }
  return out.join('\n')
}

function cleanProse(text) {
  let s = text
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n')
  s = s.replace(/<\s*\/?\s*(?:p|div)\s*>/gi, '\n')
  s = s.replace(/<\s*\/?\s*(?:span|strong|b|em|i)\s*>/gi, '')
  // The same degeneration without tags: "brbrbrbr...".
  s = s.replace(/(?:br\s*){8,}/gi, '')
  s = s.replace(/[ \t]+\n/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  s = s.replace(/\n+$/, '\n')
  return collapseRepeats(s)
}

export function sanitizeModelText(text) {
  if (!text || typeof text !== 'string') return text
  return text
    .split(CODE_SPLIT)
    .map((seg, i) => (i % 2 === 1 ? seg : cleanProse(seg)))
    .join('')
}

// True when the text carries the <br> flood marker, so the caller can count it.
export function hasBrFlood(text) {
  if (!text || typeof text !== 'string') return false
  return /(?:<\s*br\s*\/?\s*>\s*){20,}/i.test(text) || (text.match(/<\s*br\s*\/?\s*>/gi) || []).length >= 20
}
