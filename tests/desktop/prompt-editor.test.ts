import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPromptGhost, promptEditorSnapshot } from '../../src/desktop/prompt-editor.mjs'

// The app serializes the contenteditable tree the same way: a mention reads as
// its text, BR is a newline, and a top-level DIV/P gets a separating newline.
function appText(editor: HTMLElement): string {
  let buffer = ''
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      buffer += node.textContent ?? ''
      return
    }
    if (node.nodeType !== 1) return
    const element = node as HTMLElement
    if (element.dataset.mention) {
      buffer += element.textContent ?? ''
      return
    }
    if (element.tagName === 'BR') {
      buffer += '\n'
      return
    }
    Array.from(element.childNodes).forEach(visit)
  }
  const nodes = Array.from(editor.childNodes)
  nodes.forEach((node, index) => {
    visit(node)
    if (node.nodeType === 1 && ['DIV', 'P'].includes((node as HTMLElement).tagName) && index < nodes.length - 1) {
      buffer += '\n'
    }
  })
  if (buffer.replace(/[\n\u200B]/g, '') === '') return ''
  return buffer
}

function setSelectionRange(editor: HTMLElement, node: Node, offset: number, end?: { node: Node; offset: number }) {
  editor.focus()
  const range = document.createRange()
  range.setStart(node, offset)
  if (end) range.setEnd(end.node, end.offset)
  else range.collapse(true)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

function caretAtEnd(editor: HTMLElement) {
  editor.focus()
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

type FixtureOptions = {
  html?: string
  text?: string
  publicText?: string
  focused?: boolean
  quotable?: boolean
  placeholder?: boolean
  throwText?: boolean
  throwFocused?: boolean
  throwQuotable?: boolean
  caret?: (editor: HTMLElement) => void
}

function makeComposer(options: FixtureOptions = {}) {
  const parent = document.createElement('div')
  const form = document.createElement('form')
  form.setAttribute('data-component', 'composer')

  const scroll = document.createElement('div')
  scroll.setAttribute('data-component', 'composer-scroll')
  scroll.style.position = 'relative'
  scroll.style.overflowY = 'auto'
  scroll.style.maxHeight = '180px'

  const editor = document.createElement('div')
  editor.setAttribute('data-component', 'composer-editor')
  editor.setAttribute('role', 'textbox')
  editor.setAttribute('aria-multiline', 'true')
  editor.setAttribute('contenteditable', 'true')
  editor.setAttribute('dir', 'auto')
  editor.style.cssText =
    'font-family: TestFont; font-size: 13px; font-weight: 440; line-height: 20px; white-space: pre-wrap; padding: 16px 12px 8px 16px; width: 400px;'

  if (options.html !== undefined) editor.innerHTML = options.html
  else if (options.text !== undefined) editor.textContent = options.text
  else editor.innerHTML = '<br>'

  scroll.append(editor)

  let placeholder: HTMLElement | null = null
  if (options.placeholder !== false) {
    placeholder = document.createElement('div')
    placeholder.textContent = 'Ask anything'
    placeholder.style.cssText =
      'pointer-events: none; position: absolute; top: 0; left: 0; right: 0; font-family: TestFont; font-size: 13px; font-weight: 440; line-height: 20px; white-space: pre-wrap; padding: 16px 12px 0 16px;'
    scroll.append(placeholder)
  }

  form.append(scroll)
  parent.append(form)
  document.body.append(parent)

  const state = {
    text: options.publicText ?? appText(editor),
    focused: options.focused ?? true,
    quotable: options.quotable ?? true,
    throwText: options.throwText ?? false,
    throwFocused: options.throwFocused ?? false,
    throwQuotable: options.throwQuotable ?? false,
  }

  const composer = {
    text: () => {
      if (state.throwText) throw new Error('text getter failed')
      return state.text
    },
    focused: () => {
      if (state.throwFocused) throw new Error('focused getter failed')
      return state.focused
    },
    quotable: () => {
      if (state.throwQuotable) throw new Error('quotable getter failed')
      return state.quotable
    },
  }

  if (options.caret) options.caret(editor)
  else caretAtEnd(editor)

  return { parent, form, scroll, editor, placeholder, composer, state }
}

function snapshotFor(fixture: ReturnType<typeof makeComposer>, options: { composing?: boolean } = {}) {
  return promptEditorSnapshot(fixture.composer, { document, ...options })
}

function overlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-prompt-ghost]')
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.getSelection()?.removeAllRanges()
})

it('rejects a caret before a meaningful trailing newline even when it follows all text', () => {
  const fixture = makeComposer({ html: 'Draft<br>', caret: editor => setSelectionRange(editor, editor.firstChild!, 5) })
  expect(snapshotFor(fixture).eligible).toBe(false)
})

it('clips the ghost to the existing editor footprint instead of extending the scroll range', () => {
  const fixture = makeComposer({ text: 'Draft' })
  fixture.editor.getBoundingClientRect = () => ({ width: 400, height: 44, top: 0, left: 0, bottom: 44, right: 400, x: 0, y: 0, toJSON() {} })
  const ghost = createPromptGhost(document)
  expect(ghost.update(snapshotFor(fixture), ' long suffix '.repeat(30))).toBe(true)
  expect(overlay()!.style.height).toBe('44px')
  expect(overlay()!.style.overflow).toBe('hidden')
  ghost.dispose()
})

afterEach(() => {
  document.body.innerHTML = ''
  document.getSelection()?.removeAllRanges()
})

describe('promptEditorSnapshot', () => {
  it('accepts a focused composer with a collapsed caret at the end, without changing it', () => {
    const fixture = makeComposer({ text: 'hello world' })
    const html = fixture.editor.innerHTML
    const selection = document.getSelection()!
    const anchor = selection.anchorNode
    const offset = selection.anchorOffset

    const snapshot = snapshotFor(fixture)

    expect(snapshot.editor).toBe(fixture.editor)
    expect(snapshot.viewport).toBe(fixture.scroll)
    expect(snapshot.prefix).toBe('hello world')
    expect(snapshot.eligible).toBe(true)
    expect(snapshot.reason).toBe('')
    expect(fixture.editor.innerHTML).toBe(html)
    expect(document.activeElement).toBe(fixture.editor)
    expect(selection.anchorNode).toBe(anchor)
    expect(selection.anchorOffset).toBe(offset)
  })

  it('rejects a caret in the middle and reports the text before it', () => {
    const fixture = makeComposer({
      text: 'hello world',
      caret: (editor) => setSelectionRange(editor, editor.firstChild!, 5),
    })

    const snapshot = snapshotFor(fixture)

    expect(snapshot.eligible).toBe(false)
    expect(snapshot.reason).toBe('caret-not-at-end')
    expect(snapshot.prefix).toBe('hello')
    expect(snapshot.editor).toBe(fixture.editor)
    expect(document.getSelection()!.anchorOffset).toBe(5)
  })

  it('rejects a non-collapsed selection', () => {
    const fixture = makeComposer({
      text: 'hello world',
      caret: (editor) => {
        const text = editor.firstChild!
        setSelectionRange(editor, text, 0, { node: text, offset: 5 })
      },
    })

    const snapshot = snapshotFor(fixture)

    expect(snapshot.eligible).toBe(false)
    expect(snapshot.reason).toBe('selection-not-collapsed')
    expect(snapshot.prefix).toBe('')
  })

  it.each(['<br>', '\u200B', '<div><br></div>'])('accepts the blank placeholder DOM %j', (html) => {
    const fixture = makeComposer({ html })
    expect(appText(fixture.editor)).toBe('')

    const snapshot = snapshotFor(fixture)

    expect(snapshot.eligible).toBe(true)
    expect(snapshot.prefix).toBe('')
    expect(snapshot.reason).toBe('')
  })

  it('accepts multiline BR text and reports the full prefix at the end', () => {
    const fixture = makeComposer({ html: 'line one<br>line two' })
    expect(appText(fixture.editor)).toBe('line one\nline two')

    const snapshot = snapshotFor(fixture)

    expect(snapshot.eligible).toBe(true)
    expect(snapshot.prefix).toBe('line one\nline two')
  })

  it('accepts top-level DIV/P text using the installed Desktop newline rules', () => {
    const fixture = makeComposer({ html: '<div>first</div><div>second</div>' })
    expect(appText(fixture.editor)).toBe('first\nsecond')

    const snapshot = snapshotFor(fixture)

    expect(snapshot.eligible).toBe(true)
    expect(snapshot.prefix).toBe('first\nsecond')
  })

  it('rejects a caret at the end of an earlier line in a multiline editor', () => {
    const fixture = makeComposer({
      html: '<div>first</div><div>second</div>',
      caret: (editor) => {
        const first = editor.firstChild as HTMLElement
        setSelectionRange(editor, first.firstChild!, 'first'.length)
      },
    })

    const snapshot = snapshotFor(fixture)

    expect(snapshot.eligible).toBe(false)
    expect(snapshot.reason).toBe('caret-not-at-end')
    expect(snapshot.prefix).toBe('first')
  })

  it('matches the Desktop extra newline for an empty block with BR', () => {
    const fixture = makeComposer({ html: '<div>hello</div><div><br></div>' })
    expect(appText(fixture.editor)).toBe('hello\n\n')

    const snapshot = snapshotFor(fixture)

    expect(snapshot.eligible).toBe(true)
    expect(snapshot.prefix).toBe('hello\n\n')
  })

  it('rejects a public text that does not match the DOM text', () => {
    const fixture = makeComposer({ text: 'hello', publicText: 'hello!' })

    const snapshot = snapshotFor(fixture)

    expect(snapshot.eligible).toBe(false)
    expect(snapshot.reason).toBe('text-mismatch')
  })

  it('rejects text in the DOM when the public text is empty', () => {
    const fixture = makeComposer({ text: 'hello', publicText: '' })

    const snapshot = snapshotFor(fixture)

    expect(snapshot.eligible).toBe(false)
    expect(snapshot.reason).toBe('text-mismatch')
  })

  it('accepts mentions as their text and keeps the mention span intact', () => {
    const fixture = makeComposer({
      html: 'see <span data-mention="file" contenteditable="false">@a.ts</span> now',
    })
    const mention = fixture.editor.querySelector('[data-mention]')!
    expect(appText(fixture.editor)).toBe('see @a.ts now')

    const snapshot = snapshotFor(fixture)

    expect(snapshot.eligible).toBe(true)
    expect(snapshot.prefix).toBe('see @a.ts now')
    expect(mention.isConnected).toBe(true)
    expect(mention.textContent).toBe('@a.ts')
    expect(mention.getAttribute('contenteditable')).toBe('false')
  })

  it('rejects a selection inside a mention', () => {
    const fixture = makeComposer({
      html: 'see <span data-mention="file" contenteditable="false">@a.ts</span> now',
      caret: (editor) => {
        const mention = editor.querySelector('[data-mention]')!
        setSelectionRange(editor, mention.firstChild!, 2)
      },
    })

    const snapshot = snapshotFor(fixture)

    expect(snapshot.eligible).toBe(false)
    expect(snapshot.reason).toBe('selection-in-mention')
  })

  it('rejects native suggestions, history ARIA and the shell mode', () => {
    const suggestions = makeComposer({ text: 'hello' })
    const list = document.createElement('div')
    list.setAttribute('data-component', 'composer-suggestions')
    suggestions.parent.insertBefore(list, suggestions.form)
    expect(snapshotFor(suggestions).reason).toBe('suggestions')
    expect(snapshotFor(suggestions).eligible).toBe(false)

    const history = makeComposer({ text: 'hello' })
    history.editor.setAttribute('aria-controls', 'composer-history')
    history.editor.setAttribute('aria-activedescendant', 'composer-history-1')
    expect(snapshotFor(history).reason).toBe('suggestions')

    const shell = makeComposer({ text: 'ls' })
    const exit = document.createElement('button')
    exit.setAttribute('data-action', 'composer-exit-shell')
    shell.form.append(exit)
    expect(snapshotFor(shell).reason).toBe('shell')

    const notQuotable = makeComposer({ text: 'hello', quotable: false })
    expect(snapshotFor(notQuotable).reason).toBe('not-quotable')
  })

  it('rejects IME composition', () => {
    const fixture = makeComposer({ text: 'hello' })

    const snapshot = snapshotFor(fixture, { composing: true })

    expect(snapshot.eligible).toBe(false)
    expect(snapshot.reason).toBe('ime')
  })

  it('rejects a visible menu or dialog but ignores hidden ones and a dialog that hosts the composer', () => {
    const menu = makeComposer({ text: 'hello' })
    const menuElement = document.createElement('div')
    menuElement.setAttribute('role', 'menu')
    document.body.append(menuElement)
    expect(snapshotFor(menu).reason).toBe('menu')
    menuElement.remove()

    const hiddenMenu = makeComposer({ text: 'hello' })
    const hidden = document.createElement('div')
    hidden.setAttribute('role', 'menu')
    hidden.setAttribute('aria-hidden', 'true')
    document.body.append(hidden)
    expect(snapshotFor(hiddenMenu).eligible).toBe(true)
    hidden.remove()

    const hosted = makeComposer({ text: 'hello' })
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.append(hosted.parent)
    document.body.append(dialog)
    caretAtEnd(hosted.editor)
    expect(snapshotFor(hosted).eligible).toBe(true)
  })

  it('rejects another textbox and an editor outside the supplied form', () => {
    const other = document.createElement('div')
    other.setAttribute('role', 'textbox')
    other.setAttribute('contenteditable', 'true')
    document.body.append(other)
    const composer = makeComposer({ text: 'hello' })
    other.focus()

    const noEditor = promptEditorSnapshot(composer.composer, { document })
    expect(noEditor.editor).toBeNull()
    expect(noEditor.eligible).toBe(false)
    expect(noEditor.reason).toBe('no-editor')

    const first = makeComposer({ text: 'first' })
    const second = makeComposer({ text: 'second' })
    caretAtEnd(second.editor)
    Object.assign(first.composer, { form: first.form })
    const wrongForm = promptEditorSnapshot(first.composer, { document })
    expect(wrongForm.editor).toBeNull()
    expect(wrongForm.reason).toBe('no-editor')
  })

  it('rejects unknown DOM: missing viewport, missing aria-multiline and no selection', () => {
    const missingViewport = makeComposer({ text: 'hello' })
    missingViewport.form.append(missingViewport.editor)
    caretAtEnd(missingViewport.editor)
    expect(snapshotFor(missingViewport).reason).toBe('viewport-missing')
    expect(snapshotFor(missingViewport).editor).toBeNull()

    const singleLine = makeComposer({ text: 'hello' })
    singleLine.editor.removeAttribute('aria-multiline')
    expect(snapshotFor(singleLine).reason).toBe('not-multiline')
    expect(snapshotFor(singleLine).editor).toBeNull()

    const noSelection = makeComposer({ text: 'hello' })
    document.getSelection()!.removeAllRanges()
    expect(snapshotFor(noSelection).reason).toBe('selection')
    expect(snapshotFor(noSelection).eligible).toBe(false)
  })

  it('fails closed when composer getters throw or focus moved away', () => {
    const textThrow = makeComposer({ text: 'hello', throwText: true })
    expect(snapshotFor(textThrow).reason).toBe('composer-text-error')

    const focusThrow = makeComposer({ text: 'hello', throwFocused: true })
    expect(snapshotFor(focusThrow).reason).toBe('composer-focus-error')

    const quotableThrow = makeComposer({ text: 'hello', throwQuotable: true })
    expect(snapshotFor(quotableThrow).reason).toBe('composer-quotable-error')

    const notFocused = makeComposer({ text: 'hello', focused: false })
    expect(snapshotFor(notFocused).reason).toBe('not-focused')

    const moved = makeComposer({ text: 'hello' })
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    expect(snapshotFor(moved).reason).toBe('no-editor')
    expect(snapshotFor(moved).editor).toBeNull()
  })
})

describe('createPromptGhost', () => {
  it('renders an external overlay without mutating the editor or selection', () => {
    const fixture = makeComposer({ text: 'hello' })
    const html = fixture.editor.innerHTML
    const selection = document.getSelection()!
    const anchor = selection.anchorNode
    const offset = selection.anchorOffset
    const snapshot = snapshotFor(fixture)
    const ghost = createPromptGhost(document)

    expect(ghost.update(snapshot, ' world')).toBe(true)

    const element = overlay()!
    expect(element).not.toBeNull()
    expect(fixture.scroll.contains(element)).toBe(true)
    expect(fixture.editor.contains(element)).toBe(false)
    expect(element.getAttribute('aria-hidden')).toBe('true')
    expect(element.hasAttribute('inert')).toBe(true)
    expect(element.getAttribute('contenteditable')).toBe('false')
    expect(element.style.pointerEvents).toBe('none')
    expect(fixture.editor.innerHTML).toBe(html)
    expect(fixture.editor.textContent).toBe('hello')
    expect(document.getSelection()!.anchorNode).toBe(anchor)
    expect(document.getSelection()!.anchorOffset).toBe(offset)
    expect(document.activeElement).toBe(fixture.editor)
    expect(document.getSelection()!.toString()).not.toContain('world')
    expect(ghost.visible).toBe(true)
  })

  it('copies editor metrics, separates the invisible prefix and gray suffix, and follows repaints', () => {
    const fixture = makeComposer({ text: 'prefix' })
    const ghost = createPromptGhost(document)
    const snapshot = snapshotFor(fixture)

    expect(ghost.update(snapshot, ' suggestion')).toBe(true)

    const element = overlay()!
    const prefix = element.querySelector<HTMLElement>('[data-prompt-ghost-prefix]')!
    const suffix = element.querySelector<HTMLElement>('[data-prompt-ghost-suffix]')!
    expect(prefix.textContent).toBe('prefix')
    expect(prefix.style.visibility).toBe('hidden')
    expect(suffix.textContent).toBe(' suggestion')
    expect(suffix.style.color).toContain('--v2-text-text-faint')
    expect(element.style.fontFamily).toBe('TestFont')
    expect(element.style.fontSize).toBe('13px')
    expect(element.style.lineHeight).toBe('20px')
    expect(element.style.paddingLeft).toBe('16px')
    expect(element.style.paddingTop).toBe('16px')
    expect(element.style.whiteSpace).toBe('pre-wrap')
    expect(element.style.width).toBe('400px')
    expect(element.getAttribute('dir')).toBe('auto')

    fixture.scroll.scrollTop = 42
    fixture.editor.style.fontSize = '14px'
    expect(ghost.update(snapshot, ' next')).toBe(true)
    expect(overlay()!.style.fontSize).toBe('14px')
    expect(overlay()!.querySelector<HTMLElement>('[data-prompt-ghost-suffix]')!.textContent).toBe(' next')
    // The overlay is beside the editor and does not own its scroll position.
    expect(fixture.scroll.scrollTop).toBe(42)
  })

  it('keeps mentions intact and puts the suffix only in the overlay', () => {
    const fixture = makeComposer({
      html: 'see <span data-mention="file" contenteditable="false">@a.ts</span> now',
    })
    const mention = fixture.editor.querySelector('[data-mention]')!
    const snapshot = snapshotFor(fixture)
    const ghost = createPromptGhost(document)

    expect(ghost.update(snapshot, ' please')).toBe(true)

    expect(mention.isConnected).toBe(true)
    expect(mention.textContent).toBe('@a.ts')
    expect(mention.getAttribute('contenteditable')).toBe('false')
    expect(fixture.editor.textContent).toBe('see @a.ts now')
    expect(document.getSelection()!.toString()).not.toContain('please')
    expect(overlay()!.querySelector<HTMLElement>('[data-prompt-ghost-suffix]')!.textContent).toBe(' please')
  })

  it('hides only the confirmed native placeholder for a blank editor and restores it exactly', () => {
    const fixture = makeComposer({ html: '<br>' })
    const placeholder = fixture.placeholder!
    const beforeStyle = placeholder.getAttribute('style')
    const snapshot = snapshotFor(fixture)
    const ghost = createPromptGhost(document)

    expect(ghost.update(snapshot, 'suggest')).toBe(true)
    expect(placeholder.style.visibility).toBe('hidden')
    expect(ghost.visible).toBe(true)
    expect(document.querySelectorAll('[data-prompt-ghost]')).toHaveLength(1)

    expect(ghost.update(snapshot, 'suggest again')).toBe(true)
    expect(document.querySelectorAll('[data-prompt-ghost]')).toHaveLength(1)
    expect(overlay()!.querySelector<HTMLElement>('[data-prompt-ghost-suffix]')!.textContent).toBe('suggest again')

    ghost.clear()
    expect(ghost.visible).toBe(false)
    expect(placeholder.style.visibility).toBe('')
    expect(placeholder.getAttribute('style')).toBe(beforeStyle)
    expect(document.querySelectorAll('[data-prompt-ghost]')).toHaveLength(0)

    expect(ghost.update(snapshot, 'again')).toBe(true)
    expect(placeholder.style.visibility).toBe('hidden')
    ghost.dispose()
    expect(ghost.visible).toBe(false)
    expect(placeholder.style.visibility).toBe('')
    expect(document.querySelectorAll('[data-prompt-ghost]')).toHaveLength(0)
  })

  it('restores a non-empty native placeholder visibility value', () => {
    const fixture = makeComposer({ html: '\u200B' })
    const placeholder = fixture.placeholder!
    placeholder.style.visibility = 'visible'
    const snapshot = snapshotFor(fixture)
    const ghost = createPromptGhost(document)

    expect(ghost.update(snapshot, 'x')).toBe(true)
    expect(placeholder.style.visibility).toBe('hidden')
    ghost.clear()
    expect(placeholder.style.visibility).toBe('visible')
  })

  it('does not hide an unconfirmed native placeholder', () => {
    const fixture = makeComposer({ html: '<br>' })
    fixture.placeholder!.style.fontFamily = 'OtherFont'
    const snapshot = snapshotFor(fixture)
    const ghost = createPromptGhost(document)

    expect(ghost.update(snapshot, 'x')).toBe(true)
    expect(fixture.placeholder!.style.visibility).toBe('')
  })

  it('does not touch the placeholder for a non-blank prefix', () => {
    const fixture = makeComposer({ text: 'hello' })
    const snapshot = snapshotFor(fixture)
    const ghost = createPromptGhost(document)

    expect(ghost.update(snapshot, ' world')).toBe(true)
    expect(fixture.placeholder!.style.visibility).toBe('')
  })

  it('fails closed and removes the overlay for unknown DOM or stale state', () => {
    const fixture = makeComposer({ text: 'hello' })
    const snapshot = snapshotFor(fixture)
    const ghost = createPromptGhost(document)

    expect(ghost.update({ ...snapshot, eligible: false }, 'x')).toBe(false)
    expect(overlay()).toBeNull()
    expect(ghost.update(snapshot, '')).toBe(false)
    expect(ghost.update(snapshot, 42 as unknown as string)).toBe(false)
    expect(ghost.update(snapshot, 'x')).toBe(true)
    expect(overlay()).not.toBeNull()

    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    expect(ghost.update(snapshot, 'x')).toBe(false)
    expect(overlay()).toBeNull()

    caretAtEnd(fixture.editor)
    expect(ghost.update(snapshot, 'x')).toBe(true)
    fixture.editor.remove()
    expect(ghost.update(snapshot, 'x')).toBe(false)
    expect(overlay()).toBeNull()
  })

  it('rejects a snapshot whose viewport or editor is not the real editor host', () => {
    const fixture = makeComposer({ text: 'hello' })
    const snapshot = snapshotFor(fixture)
    const ghost = createPromptGhost(document)

    expect(ghost.update({ ...snapshot, viewport: document.body }, 'x')).toBe(false)
    expect(overlay()).toBeNull()

    const singleLine = makeComposer({ text: 'hello' })
    singleLine.editor.removeAttribute('aria-multiline')
    const lineSnapshot = promptEditorSnapshot(singleLine.composer, { document })
    expect(ghost.update({ ...lineSnapshot, eligible: true }, 'x')).toBe(false)
    expect(overlay()).toBeNull()
  })
})
