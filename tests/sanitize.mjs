// Unit checks for src/sanitize.mjs. No proxy needed.
//   node tests/sanitize.mjs

import { sanitizeModelText, hasBrFlood } from '../src/sanitize.mjs'

let failures = 0
const eq = (name, got, want) => {
  if (got === want) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}\n       got:  ${JSON.stringify(got)}\n       want: ${JSON.stringify(want)}`)
  }
}

// <br> becomes a newline instead of blank space.
eq('br to newline', sanitizeModelText('one<br>two'), 'one\ntwo')
eq('br variants', sanitizeModelText('a<BR/>b<br />c'), 'a\nb\nc')

// The real failure mode: hundreds of <br> with blank lines between them.
const flood = 'Готово.' + '\n\n<br>\n\n'.repeat(400)
const cleaned = sanitizeModelText(flood)
eq('flood collapses to one newline', cleaned, 'Готово.\n')
eq('flood detected', hasBrFlood(flood), true)
eq('normal text not flagged', hasBrFlood('a<br>b'), false)

// A tag-free "brbrbrbr..." loop.
eq('bare br loop', sanitizeModelText('text brbrbrbrbrbrbrbrbrbr done'), 'text done')

// Code fences keep their content byte for byte.
const html = '```html\nline<br>break\n```'
eq('fence untouched', sanitizeModelText(html), html)
eq('inline code untouched', sanitizeModelText('use `<br>` in html'), 'use `<br>` in html')

// Repeated lines are capped, normal text is not.
eq('repeated lines capped', sanitizeModelText('a\nx\nx\nx\nx\nx\nb'), 'a\nx\nx\nx\nb')
eq('blank lines capped', sanitizeModelText('a\n\n\n\n\nb'), 'a\n\nb')
eq('plain text untouched', sanitizeModelText('1. one\n2. two\n\n3. three'), '1. one\n2. two\n\n3. three')

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
